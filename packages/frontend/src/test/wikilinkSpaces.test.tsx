// D43: which note a [[label]] names has ONE rule in the app (lib/wikilinks.ts),
// the server's (syncWikilinkEdges): title, slug or alias, `|alias` and
// `#anchor` dropped; a title resolves within the linking note's space, a tag
// is global. Before, the renderer and version history took the first
// same-titled note in ANY space, and backlink snippets compared the raw link
// body, so `[[Plan|our plan]]` had no snippet.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownRenderer from "../components/MarkdownRenderer";
import NoteVersionHistory from "./versionHistoryHarness";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { findBacklinkSnippet } from "../lib/backlinks";
import { setLocalePref } from "../lib/i18n";
import { resolveWikilink, wikilinkSpan } from "../lib/wikilinks";
// History rows read the session; the real store keeps a 1 s unmount timer that can outlive the test environment.
vi.mock("../lib/accountSession", () => ({ useAccountSession: () => null }));

vi.mock("../hooks/useVersionRestore", () => ({ useVersionRestore: () => ({ restore: vi.fn(), restoringVersionId: null, feedback: null }) }));

const note = (id: string, extra: Partial<ContentNode> = {}): ContentNode => ({
  id, title: `Note ${id}`, slug: `note-${id}`, markdown: "", source_type: "manual", node_type: "content", ...extra,
});

// Two notes titled "Plan" — same slug, since slugs are unique per space only.
const planA = note("plan-a", { title: "Plan", slug: "plan", space_id: "A" });
const planB = note("plan-b", { title: "Plan", slug: "plan", space_id: "B" });
const tag = note("tag-x", { title: "Reading", slug: "reading", node_type: "class_tag", space_id: null });
const inB = note("src-b", { title: "Weekly", space_id: "B", markdown: "See [[Plan]] and [[Reading]]." });

describe("resolveWikilink", () => {
  it("a title resolves within the linking note's space, whatever the list order", () => {
    expect(resolveWikilink("Plan", inB, [planA, planB])?.id).toBe("plan-b");
    expect(resolveWikilink("plan#Goals", inB, [planA, planB])?.id).toBe("plan-b");
    expect(resolveWikilink("Plan", note("src-c", { space_id: "C" }), [planA, planB])).toBeNull();
  });

  it("a tag is global", () => {
    expect(resolveWikilink("Reading", inB, [tag])?.id).toBe("tag-x");
  });

  it("a note without a space reaches only notes without one (the server's IS NOT DISTINCT FROM)", () => {
    const loose = note("loose", { title: "Plan", space_id: null });
    expect(resolveWikilink("Plan", note("src-null", { space_id: null }), [planA, loose])?.id).toBe("loose");
    expect(resolveWikilink("Plan", inB, [loose])).toBeNull();
  });

  it("skips trashed notes and prefers another note to the linking one", () => {
    const trashed = { ...planB, deleted_at: "2026-10-01T00:00:00Z" };
    expect(resolveWikilink("Plan", inB, [trashed])).toBeNull();
    const self = note("self", { title: "Plan", space_id: "B" });
    expect(resolveWikilink("Plan", self, [self, planB])?.id).toBe("plan-b");
    expect(resolveWikilink("Plan", self, [self])?.id).toBe("self");
  });

  it("without a linking note (the published site) nothing is space-filtered", () => {
    expect(resolveWikilink("Plan", undefined, [planA, planB])?.id).toBe("plan-a");
  });
});

describe("backlink snippets", () => {
  it.each([
    ["an alias", "We agreed on [[Plan|our plan]] today."],
    ["an anchor", "We agreed on [[Plan#Goals]] today."],
    ["an anchor and alias", "We agreed on [[Plan#Goals|the goals]] today."],
    ["the slug", "We agreed on [[plan]] today."],
  ])("finds the link written with %s, so clicking places the cursor on it", (_kind, markdown) => {
    const source = note("src", { space_id: "A", markdown });
    const snip = findBacklinkSnippet(source, planA)!;
    expect(snip).not.toBeNull();
    expect(markdown.slice(snip.linkAbsStart, snip.linkAbsStart + snip.linkEnd - snip.linkStart)).toMatch(/^\[\[.*\]\]$/);
    expect(snip.linkAbsStart).toBe(markdown.indexOf("[["));
  });

  it("finds a link by one of the target's aliases", () => {
    const target = { ...planA, attrs: { aliases: '["Roadmap"]' } };
    const source = note("src", { space_id: "A", markdown: "Read [[roadmap]] first." });
    expect(findBacklinkSnippet(source, target)?.linkAbsStart).toBe(5);
  });

  it("a same-titled link from another space is not a backlink of this note", () => {
    expect(wikilinkSpan(inB.markdown, inB, planA)).toBeNull();
    expect(wikilinkSpan(inB.markdown, inB, planB)?.start).toBe(4);
  });
});

describe("the note renderer", () => {
  it("opens the same-titled note in the linking note's space, by id", () => {
    const navs: Array<[string, string | null]> = [];
    const { container } = render(
      <MarkdownRenderer nodes={[planA, planB]} from={inB} onNavigate={(label, id) => navs.push([label, id])}>
        {"See [[Plan]]."}
      </MarkdownRenderer>,
    );
    const button = container.querySelector("button.wikilink-token")!;
    expect(button.className).toContain("known");
    fireEvent.click(button);
    expect(navs).toEqual([["plan", "plan-b"]]);
  });

  it("a title only in another space renders unresolved (clicking creates it here)", () => {
    const navs: Array<[string, string | null]> = [];
    const { container } = render(
      <MarkdownRenderer nodes={[planA]} from={inB} onNavigate={(label, id) => navs.push([label, id])}>
        {"See [[Plan]]."}
      </MarkdownRenderer>,
    );
    const button = container.querySelector("button.wikilink-token")!;
    expect(button.className).not.toContain("known");
    fireEvent.click(button);
    expect(navs).toEqual([["Plan", null]]);
  });
});

describe("version history", () => {
  beforeAll(async () => {
    await Promise.all([import("../components/history"), import("../components/OverviewPreview")]);
  });
  beforeEach(() => {
    setLocalePref("en");
    resetAppState({ data: { ...noWorkspaceData, nodes: [planA, planB, inB] }, selectedId: inB.id, overviewDraft: inB.markdown, online: true });
  });
  afterEach(() => { cleanup(); resetAppState(); setLocalePref("system"); });

  it("a [[link]] in an old version opens the note in the linking note's space", async () => {
    const onSelectNode = vi.fn();
    const versions = [{
      id: "v1", title: "Weekly", markdown: "Old body: [[Plan]].", changed_at: "2026-10-01T00:00:00Z",
      actor_name: "Me", actor_type: "user", saves: 1,
    }];
    render(<NoteVersionHistory node={inB} nodeVersions={versions} onSelectNode={onSelectNode} />);
    fireEvent.click(screen.getByRole("button", { name: "All versions" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("button", { name: "Plan" });
    // The preview can draw again after it first shows (its lazy parts arriving), which
    // swaps the link element: click the one on screen now, and again if that one was
    // replaced before the click landed. Only a click on the live link opens a note.
    await waitFor(async () => {
      const link = within(dialog).getByRole("button", { name: "Plan" });
      await act(async () => { fireEvent.click(link); });
      expect(onSelectNode).toHaveBeenCalled();
    });
    expect(onSelectNode).toHaveBeenCalledExactlyOnceWith("plan-b");
  });
});

// Every surface resolves through lib/wikilinks.ts: a component that does its
// own `nodes.find(… nodeMatchesLink …)` skips the space rule again.
describe("one resolver", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

  it("only lib/wikilinks.ts matches link labels against notes", () => {
    const allowed = new Set(["lib/wikilinks.ts", "lib/utils.ts", "lib/backlinks.ts"]);
    const offenders = files(src)
      .filter((file) => !allowed.has(relative(src, file)))
      .filter((file) => /\b(nodeMatchesLink|linkNamesNote)\b/.test(readFileSync(file, "utf8")))
      .map((file) => relative(src, file));
    expect(offenders).toEqual([]);
  });
});
