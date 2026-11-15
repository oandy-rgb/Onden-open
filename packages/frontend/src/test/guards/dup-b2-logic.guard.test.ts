// @vitest-environment node
// Guard for the "logic and rules" batch (docs/research/dup-patterns-2026-10-30-fe-logic.md #1 #5 #7 #8 #9 #11 #12).
// Allowlist, deny by default: each job has one owner file; the same thing written anywhere else fails.
// An exception says why. One that no longer applies fails too, so the lists only shrink.
import { describe, expect, it } from "vitest";
import { findUses, sourceFiles } from "./sources";

const files = [...sourceFiles("components"), ...sourceFiles("hooks"), ...sourceFiles("lib"), ...sourceFiles("modules"),
  ...sourceFiles("pages"), ...sourceFiles("settings")];
const tsx = files.filter((file) => file.endsWith(".tsx"));

/** `rel:line` uses of `pattern`, minus the owner files; the rest must be exactly the listed exceptions. */
function onlyOwnerAnd(
  scope: string[], pattern: RegExp, owners: readonly string[], exceptions: Record<string, string> = {},
): { stray: string[]; stale: string[] } {
  const hits = findUses(scope, pattern, owners);
  const files = [...new Set(hits.map((hit) => hit.replace(/:\d+$/, "")))];
  return {
    stray: files.filter((file) => !(file in exceptions)).flatMap((file) => hits.filter((hit) => hit.startsWith(`${file}:`))),
    stale: Object.keys(exceptions).filter((file) => !files.includes(file)),
  };
}

const clean = { stray: [], stale: [] };

// Lines per file that still say "(s)"; only shrinks. Migrate a file to tn, then lower or drop its line.
// ratchet:list PLURAL_SUFFIX_BASELINE
const PLURAL_SUFFIX_BASELINE: Record<string, number> = {
  "components/DeviceNotices.tsx": 2,
  "components/InboxReview.tsx": 2,
  "components/KnowledgeWorkspace.tsx": 2,
  "components/TagDeleteConfirm.tsx": 6,
  "components/TagsPanel.tsx": 1,
  "components/tagPage/useTagMerge.ts": 1,
  "hooks/useBlockChildNote.ts": 1,
  "lib/history/eventSentence.ts": 1,
  "modules/capture/QuickCapture.tsx": 1,
  "settings/SpaceDeleteDialog.tsx": 3,
  "settings/registry.tsx": 1,
};


const NOW_OF_DEVICE = /\b(?:getHours|getMinutes|getDay)\(/;
const RENDER_TODAY = /\btodayId\(\)/;
const FROZEN_DATE = /useMemo\(\(\) => new Date\(\)/;
const WHITEBOARD_KIND = /layout\s*===\s*"canvas"|node_type\s*[!=]==\s*"canvas"/;
const PARENT_LOOP = /\b(?:for|while)\s*\(.*parent_id/;
const PLURAL_TERNARY = /(?:===|!==)\s*1\s*\?\s*t\(/;
const PLURAL_SUFFIX = /\bt\("[^"]*\((?:s|es|ies)\)/;
const LIST_FILTER = /\.(?:filter|some)\(\(?\w+\)?\s*=>\s*(?:!\w+\.hidden|\w+\.node_type\s*===\s*"content"\s*&&)/;
const UUID_FALLBACK = /typeof crypto !== "undefined"|typeof crypto\.randomUUID/;
const RANDOM_ID = /Math\.random\(\)\.toString\(36\)/;
const OWNER_FLAG = /\.actor_is_owner\b/;
const SPACE_RIGHTS = /\.can_manage\b|\b(?:space|s)\.permission\s*===\s*"edit"/;

describe("#1 the workspace's now and today are lib/localDate's (pages: hooks/useToday)", () => {
  it("no clock read of the device's hours, minutes or weekday", () => {
    expect(onlyOwnerAnd(files, NOW_OF_DEVICE, [
      "lib/localDate.ts", "lib/workspaceTime.ts", "components/viewLayoutKit/calendarGrid.ts",
    ], {
      "modules/capture/QuickCapture.tsx": "nowTimeString() reads the device clock; its file is being changed by another open PR",
    })).toEqual(clean);
  });

  it("a component renders today through useToday, so a page left open rolls over at midnight", () => {
    expect(onlyOwnerAnd(tsx, RENDER_TODAY, [], {
      "components/history/WorkspaceHistoryChanges.tsx": "renders todayId(); its file is being changed by another open PR",
    })).toEqual(clean);
  });

  it("no page freezes one Date for its whole life", () => {
    expect(findUses(files, FROZEN_DATE)).toEqual([]);
  });

  it("the checks fire on what they forbid", () => {
    expect(NOW_OF_DEVICE.test("const h = now.getHours();")).toBe(true);
    expect(RENDER_TODAY.test("  const today = todayId();")).toBe(true);
    expect(FROZEN_DATE.test("const now = useMemo(() => new Date(), []);")).toBe(true);
  });
});

describe("#5 'this note has a whiteboard' is lib/whiteboardNote's", () => {
  it("only whiteboardNote names the canvas layout or the retired canvas node kind", () => {
    expect(findUses(files, WHITEBOARD_KIND, ["lib/whiteboardNote.ts"])).toEqual([]);
  });

  it("the check fires on what it forbids", () => {
    expect(WHITEBOARD_KIND.test('views.find((view) => view.layout === "canvas")')).toBe(true);
    expect(WHITEBOARD_KIND.test('node.node_type !== "canvas"')).toBe(true);
  });
});

describe("#7 walking parent_id is lib/treeWalk's", () => {
  it("no loop reads parent_id by itself", () => {
    expect(onlyOwnerAnd(files, PARENT_LOOP, ["lib/treeWalk.ts"], {
      "hooks/useGraphLayout.ts": "one level of children, not a walk",
      "lib/boardTree.ts": "pathFromRoot: the path root-to-node with its own depth cap",
      "lib/data/dayNotes.ts": "dayNotesOutside; its file is being changed by another open PR",
      "lib/tagTree.ts": "canMoveTagUnder / withDescendants; its file is being changed by another open PR",
      "lib/utils.ts": "groupNodes: which rows have children, not a walk",
      "modules/daily/journal.ts": "which notes have captures, not a walk",
    })).toEqual(clean);
  });

  it("the check fires on what it forbids", () => {
    expect(PARENT_LOOP.test("for (let at = byId.get(x); at; at = at.parent_id ? byId.get(at.parent_id) : undefined) {")).toBe(true);
    expect(PARENT_LOOP.test("while (cur.parent_id && !seen.has(cur.id)) {")).toBe(true);
  });
});

/** Lines of `pattern` per file, for a list that may only shrink. */
function countsPerFile(scope: string[], pattern: RegExp, owners: readonly string[] = []): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const hit of findUses(scope, pattern, owners)) {
    const file = hit.replace(/:\d+$/, "");
    counts[file] = (counts[file] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

describe("#8 a count in a sentence is lib/i18n's tn", () => {
  it("no new n === 1 ? t(…) : t(…)", () => {
    expect(countsPerFile(files, PLURAL_TERNARY, ["lib/i18n.ts"])).toEqual({
      "modules/tasks/taskLabels.ts": 1, // takes the caller's t (a TFn), so it cannot call the global tn
    });
  });

  // Only shrinks: migrate a file to tn, then lower its number here (or drop the line).
  it("no new \"(s)\" in a t(…) string", () => {
    expect(countsPerFile(files, PLURAL_SUFFIX, ["lib/i18n.ts"])).toEqual(PLURAL_SUFFIX_BASELINE);
  });

  it("the checks fire on what they forbid", () => {
    expect(PLURAL_TERNARY.test('n === 1 ? t("1 note") : t("{n} notes", { n })')).toBe(true);
    expect(PLURAL_SUFFIX.test('t("{n} note(s) under it:", { n })')).toBe(true);
  });
});

describe("#9 which notes a list offers is lib/nodeTags' isShownNote / listsAsNote", () => {
  it("no list filters hidden or node_type === \"content\" by hand", () => {
    expect(onlyOwnerAnd(files, LIST_FILTER, ["lib/nodeTags.ts"])).toEqual(clean);
  });

  it("the check fires on what it forbids", () => {
    expect(LIST_FILTER.test("nodes.filter((n) => !n.hidden)")).toBe(true);
    expect(LIST_FILTER.test('nodes.filter((n) => n.node_type === "content" && !n.hidden)')).toBe(true);
  });
});

describe("#11 a client-made id is lib/uuid's randomUUID", () => {
  it("no secure-context check of crypto.randomUUID outside it", () => {
    expect(findUses(files, UUID_FALLBACK, ["lib/uuid.ts"])).toEqual([]);
  });

  it("no Math.random() id outside the three that are not row ids", () => {
    expect(onlyOwnerAnd(files, RANDOM_ID, ["lib/uuid.ts"], {
      "components/MarkdownRenderer.tsx": "a DOM id for a mermaid render",
      "hooks/useCanvasActions.ts": "a temporary row key for an import in progress",
      "lib/appStore.ts": "a subscription token, not an id the server stores",
    })).toEqual(clean);
  });

  it("the checks fire on what they forbid", () => {
    expect(UUID_FALLBACK.test('if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")')).toBe(true);
    expect(RANDOM_ID.test("`p-${Math.random().toString(36).slice(2)}`")).toBe(true);
  });
});

describe("#12 who may do what is lib/capabilities'", () => {
  it("the owner flag is read through useIsOwner / useCapabilities", () => {
    expect(onlyOwnerAnd(files, OWNER_FLAG, [
      "lib/capabilities.ts", "lib/api.ts", "lib/spaces.ts", "lib/workspaceMirror.ts",
      "lib/data/syncEngine.ts", "lib/localDbPersist.ts", "lib/localDbWorker.ts", // the cached copy of the bootstrap flag
    ], {
      "settings/TimeSetting.tsx": "its file is being changed by another open PR",
    })).toEqual(clean);
  });

  it("a space's rights are read through canManageSpace / canWriteSpace", () => {
    expect(onlyOwnerAnd(files, SPACE_RIGHTS, ["lib/capabilities.ts", "lib/spaces.ts"], {})).toEqual(clean);
  });

  it("the checks fire on what they forbid", () => {
    expect(OWNER_FLAG.test("useAppSelector((s) => s.data.actor_is_owner === true)")).toBe(true);
    expect(SPACE_RIGHTS.test('space.can_manage || space.permission === "edit"')).toBe(true);
  });
});
