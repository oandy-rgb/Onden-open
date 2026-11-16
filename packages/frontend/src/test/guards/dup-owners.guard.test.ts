// Five small rules each have ONE owner; every other file is refused (an allowlist,
// not a list of known offenders). A failure names file:line: call the owner instead.
// An entry in PENDING is a file another open branch is changing right now; it is
// migrated after that branch lands, and the list may only get shorter (a stale
// entry fails too).
//
//   no title shown    → lib/noteLabel.ts            displayTitle / untitledTitle
//   child order       → lib/childOrder.ts           compareChildren / sortChildren
//   filter by title   → lib/noteSearch.ts           matchTitle / rankByTitle
//   "carries tag X"   → lib/nodeTags.ts             nodeHasTag / nodeTagIds
//   tag name, no "#"  → lib/hashtags.ts             tagName / tagQuery
import { describe, expect, it } from "vitest";
import { SRC, codeLines, findUses, sourceFiles } from "./sources";
import { join } from "node:path";
import { entryHint } from "../../../../../scripts/entrypointsCatalog.mjs";

const files = sourceFiles(".");

/** Files that still hold the pattern and are allowed to for now: path → why. */
function stale(pending: Record<string, string>, pattern: RegExp): string[] {
  return Object.keys(pending).filter((rel) => !codeLines(join(SRC, rel)).some((line) => pattern.test(line)));
}

describe("a blank title is named in one place", () => {
  // The placeholder name goes through t() and the literal 「未命名」 only here (and the translation table).
  const PATTERN = /\bt\(\s*["'](?:Untitled|\(untitled\))["']\s*\)|未命名/;
  const OWNERS = ["lib/noteLabel.ts", "lib/i18n.zh-TW.ts", "lib/i18n.zh-TW.boot.ts", "lib/i18n.zh-TW.late.ts"];
  // ratchet:list PENDING
  const PENDING: Record<string, string> = {
    "modules/tasks/TaskSheet.tsx": "refactor/dates-unify",
    "modules/daily/DayNoteParentSetting.tsx": "refactor/dates-unify",
    "modules/calendar/CalendarLayout.tsx": "refactor/dates-unify",
    "components/OverviewEditor.tsx": "refactor/dates-unify",
    "components/HomeStart.tsx": "refactor/dates-unify",
  };
  it("only lib/noteLabel.ts says Untitled / 「未命名」", () => {
    const uses = findUses(files, PATTERN, [...OWNERS, ...Object.keys(PENDING)]);
    expect(uses, entryHint("note-title")).toEqual([]);
  });
  it("PENDING lists only files that still need migrating", () => {
    expect(stale(PENDING, PATTERN)).toEqual([]);
  });
  it("catches a hand-written fallback", () => {
    expect(PATTERN.test('{n.title || t("Untitled")}')).toBe(true);
    expect(PATTERN.test('n.title || "未命名"')).toBe(true);
    expect(PATTERN.test("{displayTitle(n.title)}")).toBe(false);
  });
});

describe("siblings are ordered in one place", () => {
  const PATTERN = /(?:sort_order|order_key).*(?:\) - \(|localeCompare)|\bsort_order\s*-\s*\w+\.sort_order|\border_key\s*[<>]=?\s*\w+\.order_key/;
  // ratchet:list PENDING2
  const PENDING: Record<string, string> = {
  };
  it("only lib/childOrder.ts compares order keys", () => {
    const uses = findUses(files, PATTERN, ["lib/childOrder.ts", ...Object.keys(PENDING)]);
    expect(uses, entryHint("child-order")).toEqual([]);
  });
  it("PENDING lists only files that still need migrating", () => {
    expect(stale(PENDING, PATTERN)).toEqual([]);
  });
  it("catches a hand-written comparison", () => {
    expect(PATTERN.test("(a.sort_order ?? 0) - (b.sort_order ?? 0) || a.title.localeCompare(b.title)")).toBe(true);
    expect(PATTERN.test("a.sort_order - b.sort_order")).toBe(true);
    expect(PATTERN.test("rows.sort((a, b) => a.sort_order - b.sort_order)")).toBe(true);
    expect(PATTERN.test("rows.sort((a, b) => (a.order_key ?? \"\") < (b.order_key ?? \"\") ? -1 : 1)")).toBe(false);
    expect(PATTERN.test("a.order_key < b.order_key ? -1 : 1")).toBe(true);
    expect(PATTERN.test("sortChildren(rows)")).toBe(false);
  });
});

describe("filtering by title is matched in one place", () => {
  const PATTERN = /to(?:Locale)?LowerCase\(\)\.includes\(/;
  // Not a title/name filter, or another branch's file.
  // ratchet:list ALLOWED
  const ALLOWED: Record<string, string> = {
    "lib/noteSearch.ts": "owner",
    "lib/siteSearch.ts": "highlights a word inside page text, not a title",
    "hooks/useGraphLayout.ts": "graph highlight searches title and body together",
    "modules/tasks/TaskSheet.tsx": "refactor/dates-unify",
  };
  it("only lib/noteSearch.ts folds case to filter names", () => {
    const uses = findUses(files, PATTERN, Object.keys(ALLOWED));
    expect(uses, entryHint("title-match")).toEqual([]);
  });
  it("the exceptions only shrink", () => {
    const { "lib/noteSearch.ts": _owner, ...rest } = ALLOWED;
    expect(stale(rest, PATTERN)).toEqual([]);
  });
  // matchTitle also accepts the query's letters scattered in order ("h2" finds "Heading 2"): right for
  // a ranked list ([[ links, ⌘K), wrong for a list that filters and caps its rows, where "meeting"
  // would crowd the real Meeting out. Those use containsTitle.
  it("only ranked lists call matchTitle / rankByTitle; filters call containsTitle", () => {
    const uses = findUses(files, /\b(?:matchTitle|rankByTitle)\(/, [
      "lib/noteSearch.ts", "components/CommandPalette.tsx", "lib/wikilinkTargets.ts", "hooks/useCommandPalette.ts",
      "lib/editorCompletion.ts", "lib/blockRefSearch.ts", "modules/daily/DayNoteParentSetting.tsx",
    ]);
    expect(uses, entryHint("title-match")).toEqual([]);
  });
  it("catches a hand-written filter", () => {
    expect(PATTERN.test("n.title.toLowerCase().includes(q)")).toBe(true);
    expect(PATTERN.test("n.title.toLocaleLowerCase().includes(q)")).toBe(true);
    expect(PATTERN.test("matchTitle(q, n.title)")).toBe(false);
  });
});

describe("\"carries tag X\" is asked in one place", () => {
  // The two lists are read together only by lib/nodeTags.ts; these files store or move them as columns.
  const OWNERS = [
    "lib/nodeTags.ts", "lib/api.ts", "lib/data/tagWriter.ts", "lib/data/storeOps.ts", "lib/data/bootstrapWire.ts",
    "lib/localMirror.ts", "lib/localDbWorker.ts", "lib/localDbSchema.ts",
  ];
  const BOTH = /\.class_tag_ids.*\.label_tag_ids|\.label_tag_ids.*\.class_tag_ids/;
  const MEMBER = /(?:class|label)_tag_ids\??\.(?:includes|some|indexOf)\(/;
  // A Set built from one list or both, or checked with .has: the same question asked another way.
  const SET = /new Set\([^)]*(?:class|label)_tag_ids|(?:class|label)_tag_ids\)\.has\(/;
  it("no other file reads class_tag_ids and label_tag_ids together", () => {
    expect(findUses(files, BOTH, OWNERS), entryHint("note-tags")).toEqual([]);
  });
  it("no other file tests one list for a tag id by hand", () => {
    expect(findUses(files, MEMBER, OWNERS), entryHint("note-tags")).toEqual([]);
  });
  it("no other file turns a tag id list into a Set or looks one up by index", () => {
    expect(findUses(files, SET, OWNERS), entryHint("note-tags")).toEqual([]);
  });
  it("catches a hand-written check", () => {
    expect(MEMBER.test("node.label_tag_ids.indexOf(id) >= 0")).toBe(true);
    expect(SET.test("new Set(n.class_tag_ids ?? [])")).toBe(true);
    expect(SET.test("new Set([...a.label_tag_ids, ...a.class_tag_ids])")).toBe(true);
    expect(SET.test("nodeTagIds(n)")).toBe(false);
    expect(BOTH.test("n.class_tag_ids?.includes(t) || n.label_tag_ids?.includes(t)")).toBe(true);
    expect(MEMBER.test("node.class_tag_ids?.includes(t.id)")).toBe(true);
    expect(BOTH.test("nodeHasTag(n, t)")).toBe(false);
  });
});

describe("a tag name loses its leading # in one place", () => {
  const PATTERN = /replace\(\/\^#/;
  it("only lib/hashtags.ts strips the #", () => {
    expect(findUses(files, PATTERN, ["lib/hashtags.ts"]), entryHint("tag-name")).toEqual([]);
  });
  it("catches a hand-written strip", () => {
    expect(PATTERN.test('q.trim().replace(/^#/, "")')).toBe(true);
    expect(PATTERN.test("tagName(q)")).toBe(false);
  });
});

