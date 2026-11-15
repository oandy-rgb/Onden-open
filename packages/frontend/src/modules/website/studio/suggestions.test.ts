import { beforeEach, describe, expect, it } from "vitest";
import { setLocalePref } from "../../../lib/i18n";
import { bracesBalanced, defaultDesignV2, validateDesignV2, type PuckComponentData, type SiteDesignV2 } from "@onden/site";
import type { BlockedNote, StudioNote } from "./editorData";
import { computeSuggestions, repairBraces, type Suggestion } from "./suggestions";

// The studio's wording is asserted in Chinese here; studioStrings.test.tsx covers English.
beforeEach(() => setLocalePref("zh-TW"));

const part = (type: string, id: string, extra: Record<string, unknown> = {}): PuckComponentData => ({ type, props: { id, bg: "none", heading: "auto", cls: "", css: "", ...extra } });
const note = (id: string, noteId: string): PuckComponentData => ({ type: "note", props: { id, noteId, blockId: "", display: "full" } });
const view = (id: string, extra: Record<string, unknown> = {}): PuckComponentData => ({ type: "tag_view", props: { id, tagId: "t", viewId: "", viewKind: "list", limit: 6, sort: "new", ...extra } });
const design = (...content: PuckComponentData[]): SiteDesignV2 => ({ ...defaultDesignV2({}), home: { root: { props: {} }, content } });
const studioNote = (over: Partial<StudioNote> & { id: string }): StudioNote => ({ title: over.id, slug: over.id, updatedAt: "", published: true, ...over });
const blockedNote = (over: Partial<BlockedNote> & { id: string }): BlockedNote => ({ title: over.id, marked: true, blocker: { reason: "space", space: "只有我" }, ...over });
const run = (d: SiteDesignV2, notes: StudioNote[] = [], rowCounts: Record<string, number> = {}, blocked: BlockedNote[] = []) => computeSuggestions({ design: d, notes, blocked, rowCounts });
const kinds = (list: Suggestion[]) => list.map((s) => s.kind);

describe("computeSuggestions", () => {
  it("an unpublished note on the page: 一起發布 (or pick another), nothing applied", () => {
    const d = design(part("stack", "s", { items: [note("n", "draft")] }));
    const list = run(d, [studioNote({ id: "draft", title: "Draft", published: false })]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "unpublished", includeNoteIds: ["draft"], selectComponentId: "n", applyLabel: "一起發布" });
    expect(list[0]!.text).toContain("Draft");
  });
  it("a note kept off by its space (moved there after it was placed) is not offered 一起發布; it says why", () => {
    const d = design(part("stack", "s", { items: [note("n", "x")] }));
    // The studio lists no note of a closed space: the note is known only as blocked.
    const list = run(d, [], {}, [blockedNote({ id: "x", title: "Secret" })]);
    expect(list[0]).toMatchObject({ kind: "private_space", selectComponentId: "n" });
    expect(list[0]!.includeNoteIds).toBeUndefined();
    expect(list[0]!.text).toContain("只有我");
  });
  it("a card view of more than 4 items: the change is a limit of 4, on a copy", () => {
    const d = design(part("stack", "s", { items: [view("v", { viewKind: "cards", limit: 8 })] }));
    const list = run(d, [], { v: 7 });
    expect(kinds(list)).toEqual(["many_cards"]);
    const changed = list[0]!.design!;
    expect((changed.home.content[0]!.props.items as PuckComponentData[])[0]!.props.limit).toBe(4);
    expect((d.home.content[0]!.props.items as PuckComponentData[])[0]!.props.limit).toBe(8);
    // 4 or fewer shown: nothing to suggest
    expect(run(d, [], { v: 4 })).toEqual([]);
    expect(run(design(part("stack", "s", { items: [view("v", { viewKind: "list", limit: 8 })] })), [], { v: 7 })).toEqual([]);
  });
  it("an empty slot: a part with nothing in it can be removed; a half-empty one is selected", () => {
    const empty = run(design(part("stack", "s", { items: [] }), part("stack", "t", { items: [note("n", "a")] })), [studioNote({ id: "a" })]);
    expect(kinds(empty)).toEqual(["empty_slot"]);
    expect(empty[0]!.design!.home.content.map((c) => c.props.id)).toEqual(["t"]);
    const half = run(design(part("sidebar", "sb", { aside: [note("n", "a")], main: [] })), [studioNote({ id: "a" })]);
    expect(half[0]).toMatchObject({ kind: "empty_slot", selectComponentId: "sb" });
    expect(half[0]!.design).toBeUndefined();
  });
  it("a content block with nothing chosen asks to choose", () => {
    const list = run(design(part("stack", "s", { items: [note("n", "")] })));
    expect(list[0]).toMatchObject({ kind: "empty_choice", selectComponentId: "n" });
  });
  it("unbalanced CSS: the repair appends the missing braces, and the result is balanced", () => {
    const d = { ...design(), css: "a { color: red; " };
    const list = run(d);
    expect(kinds(list)).toEqual(["bad_css"]);
    expect(bracesBalanced(list[0]!.design!.css)).toBe(true);
    expect(d.css).toBe("a { color: red; ");
    // a stray } cannot be repaired by appending: the style tab is where it is fixed
    const stray = run({ ...design(), css: "} a {}" });
    expect(stray[0]).toMatchObject({ kind: "bad_css", styleTab: true });
    expect(stray[0]!.design).toBeUndefined();
    expect(repairBraces("a { b { c: d }")).toBe("a { b { c: d }\n}");
  });
  it("a part's own CSS counts too", () => {
    const list = run(design(part("stack", "s", { css: "& p { color: red", items: [note("n", "a")] })), [studioNote({ id: "a" })]);
    expect(kinds(list)).toEqual(["bad_css"]);
    expect(bracesBalanced((list[0]!.design!.home.content[0]!.props.css as string))).toBe(true);
  });
  it("more than 5 top-level blocks: the tail folds into one stack when every block fits inside a part", () => {
    const blocks = Array.from({ length: 7 }, (_, i) => part("stack", `s${i}`, { items: [note(`n${i}`, "a")] }));
    const list = run(design(...blocks), [studioNote({ id: "a" })]);
    expect(kinds(list)).toEqual(["too_long"]);
    const folded = list[0]!.design!;
    expect(folded.home.content).toHaveLength(6);
    expect(validateDesignV2(folded).problems).toEqual([]);
    // a tail with a sidebar cannot be folded: advice only
    const mixed = run(design(...blocks.slice(0, 5), part("sidebar", "sb", { aside: [note("na", "a")], main: [note("nb", "a")] }), blocks[6]!), [studioNote({ id: "a" })]);
    expect(mixed[0]).toMatchObject({ kind: "too_long" });
    expect(mixed[0]!.design).toBeUndefined();
  });
  it("top-level content counts as a block and folds into the stack too", () => {
    const flat = Array.from({ length: 7 }, (_, i) => note(`n${i}`, "a"));
    const list = run(design(...flat), [studioNote({ id: "a" })]);
    expect(kinds(list)).toEqual(["too_long"]);
    const folded = list[0]!.design!;
    expect(folded.home.content.map((c) => c.type)).toEqual(["note", "note", "note", "note", "note", "stack"]);
    expect((folded.home.content[5]!.props.items as unknown[]).length).toBe(2);
    expect(validateDesignV2(folded).problems).toEqual([]);
  });
  it("a tidy page has no suggestions", () => {
    const d = design(part("stack", "s", { items: [note("n", "a"), view("v")] }));
    expect(run(d, [studioNote({ id: "a" })], { v: 3 })).toEqual([]);
  });
});
