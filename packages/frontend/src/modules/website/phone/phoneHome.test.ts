import { untitledTitle } from "../../../lib/noteLabel";
import { beforeEach, describe, expect, it } from "vitest";
import { setLocalePref } from "../../../lib/i18n";
import { defaultDesignV2, validateDesignV2, walkHome, type PuckComponentData, type PuckData, type SiteDesignV2 } from "@onden/site";
import { blockRows, deleteBlock, insertPattern, moveBlock, patternSlots, swapNote, swapTagView, swappableOf } from "./phoneHome";

// The studio's wording is asserted in Chinese here; studioStrings.test.tsx covers English.
beforeEach(() => setLocalePref("zh-TW"));

const part = (type: string, id: string, extra: Record<string, unknown> = {}): PuckComponentData => ({ type, props: { id, bg: "none", heading: "auto", cls: "", css: "", ...extra } });
const note = (id: string, noteId: string, extra: Record<string, unknown> = {}): PuckComponentData => ({ type: "note", props: { id, noteId, blockId: "", display: "full", ...extra } });
const view = (id: string, tagId: string): PuckComponentData => ({ type: "tag_view", props: { id, tagId, viewId: "", viewKind: "list", limit: 6, sort: "new" } });
const home = (...content: PuckComponentData[]): PuckData => ({ root: { props: {} }, content });
const design = (h: PuckData): SiteDesignV2 => ({ ...defaultDesignV2({}), home: h });
const valid = (h: PuckData) => {
  const result = validateDesignV2(design(h));
  expect(result.problems).toEqual([]);
  return result.design.home;
};
const ids = (h: PuckData) => { const out: string[] = []; walkHome(h, (c) => { out.push(c.props.id); }); return out; };

const names = {
  noteTitle: (id: string) => ({ a: "Alpha", b: "Beta" } as Record<string, string>)[id] ?? null,
  notePublished: (id: string) => id !== "b",
  tagName: (id: string) => (id === "t1" ? "文章" : null),
};
const base = () => home(
  part("stack", "s1", { items: [note("n1", "a")] }),
  part("stack", "s2", { items: [view("v1", "t1")] }),
  part("sidebar", "s3", { aside: [note("n2", "a")], main: [view("v2", "t1")] }),
);

describe("rows", () => {
  it("name a block by its note or tag view; a block with several things is named by what it is", () => {
    const rows = blockRows(base(), names);
    expect(rows.map((r) => r.title)).toEqual(["Alpha", "標籤檢視：文章", "側欄"]);
    expect(rows[2]!.detail).toBe("Alpha、標籤檢視：文章");
    expect(rows.map((r) => r.swap?.kind ?? null)).toEqual(["note", "tag_view", null]);
  });
  it("say 未發布 for an unpublished note and 未命名 for a missing one, never an id", () => {
    const rows = blockRows(home(part("stack", "s", { items: [note("n", "b")] }), part("stack", "t", { items: [note("m", "gone")] }), part("stack", "u", { items: [note("e", "")] })), names);
    expect(rows.map((r) => r.title)).toEqual(["Beta（未發布）", untitledTitle(), "還沒選筆記"]);
    expect(JSON.stringify(rows)).not.toMatch(/"gone"/);
  });
  it("a nested part is one row, swappable only when it holds a single note or tag view", () => {
    const nested = part("stack", "o", { items: [part("cards", "i", { items: [note("n", "a")] })] });
    expect(swappableOf(nested)).toEqual({ id: "n", kind: "note" });
    const two = part("stack", "o2", { items: [part("cards", "i2", { items: [note("n3", "a"), note("n4", "a")] })] });
    expect(swappableOf(two)).toBeNull();
    expect(swappableOf(part("stack", "tl", { items: [{ type: "timeline", props: { id: "t", tagId: "t1", limit: 6 } }] }))).toBeNull();
  });
});

describe("moves keep a valid design", () => {
  it("moves a block up and down, and stays put at the ends", () => {
    const h = base();
    expect(valid(moveBlock(h, "s2", -1)).content.map((c) => c.props.id)).toEqual(["s2", "s1", "s3"]);
    expect(valid(moveBlock(h, "s2", 1)).content.map((c) => c.props.id)).toEqual(["s1", "s3", "s2"]);
    expect(moveBlock(h, "s1", -1)).toBe(h);
    expect(moveBlock(h, "s3", 1)).toBe(h);
    expect(moveBlock(h, "n1", 1)).toBe(h); // only top-level blocks move
  });
  it("deletes a block and everything in it", () => {
    const next = valid(deleteBlock(base(), "s3"));
    expect(next.content.map((c) => c.props.id)).toEqual(["s1", "s2"]);
    expect(ids(next)).not.toContain("n2");
    expect(deleteBlock(base(), "n1").content).toHaveLength(3); // a nested part is not deleted on its own
  });
  it("swaps the note of a block and drops the old note's paragraph", () => {
    const h = home(part("stack", "s", { items: [note("n", "a", { blockId: "p1", display: "first" })] }));
    const next = valid(swapNote(h, "n", "b"));
    expect((next.content[0]!.props.items as PuckComponentData[])[0]!.props).toMatchObject({ noteId: "b", blockId: "", display: "first" });
    expect(swapNote(h, "s", "b")).toBe(h); // not a note
  });
  it("swaps the tag and view of a tag view", () => {
    const next = valid(swapTagView(base(), "v1", { tagId: "t2", viewId: "vw", viewKind: "cards" }));
    expect((next.content[1]!.props.items as PuckComponentData[])[0]!.props).toMatchObject({ tagId: "t2", viewId: "vw", viewKind: "cards", limit: 6 });
  });
});

describe("inserting a block pattern", () => {
  it.each(["pattern_intro_now", "pattern_work_cards", "pattern_three_entries", "pattern_timeline"] as const)("%s is a valid design at every position", (type) => {
    const choices = patternSlots(type).map((slot) => slot.kind === "note"
      ? ({ kind: "note", noteId: "a" } as const)
      : ({ kind: "tag_view", tagId: "t1", viewId: "", viewKind: "list" } as const));
    for (const position of [0, 1, 3, 99]) {
      const next = valid(insertPattern(base(), type, position, choices));
      expect(next.content).toHaveLength(4);
      expect(next.content[Math.min(position, 3)]!.type).toBe(type);
      expect(new Set(ids(next)).size).toBe(ids(next).length);
    }
  });
  it("puts the chosen note / tag view into the pattern's slots, in order", () => {
    const next = valid(insertPattern(base(), "pattern_intro_now", 0, [
      { kind: "note", noteId: "b" }, { kind: "tag_view", tagId: "t1", viewId: "vw", viewKind: "cards" },
    ]));
    const block = next.content[0]!.props;
    expect((block.aside as PuckComponentData[])[0]!.props).toMatchObject({ noteId: "b", display: "first" });
    expect((block.main as PuckComponentData[])[0]!.props).toMatchObject({ tagId: "t1", viewId: "vw", viewKind: "cards" });
  });
  it("inserting the same pattern twice never repeats an id", () => {
    const choices = [{ kind: "tag_view", tagId: "t1", viewId: "", viewKind: "list" } as const];
    const once = insertPattern(home(), "pattern_work_cards", 0, choices);
    const twice = valid(insertPattern(once, "pattern_work_cards", 1, choices));
    expect(new Set(ids(twice)).size).toBe(ids(twice).length);
  });
});

describe("content on the top level", () => {
  const flat = () => home(note("n1", "a"), part("sidebar", "s3", { aside: [note("n2", "a")], main: [view("v9", "t1")] }), view("v1", "t1"), note("n3", "b"));
  it("is a row of its own, named by its note or tag view, and swappable", () => {
    const rows = blockRows(flat(), names);
    expect(rows.map((r) => r.title)).toEqual(["Alpha", "側欄", "標籤檢視：文章", "Beta（未發布）"]);
    expect(rows.map((r) => r.swap?.kind ?? null)).toEqual(["note", null, "tag_view", "note"]);
    expect(rows[0]!.swap!.id).toBe("n1");
  });
  it("moves up and down among layouts, and stays put at the ends", () => {
    const h = flat();
    expect(valid(moveBlock(h, "n1", 1)).content.map((c) => c.props.id)).toEqual(["s3", "n1", "v1", "n3"]);
    expect(valid(moveBlock(h, "v1", -1)).content.map((c) => c.props.id)).toEqual(["n1", "v1", "s3", "n3"]);
    expect(moveBlock(h, "n1", -1)).toBe(h);
    expect(moveBlock(h, "n3", 1)).toBe(h);
  });
  it("is deleted and swapped in place, and the design stays valid with no stack around it", () => {
    const h = flat();
    expect(valid(deleteBlock(h, "v1")).content.map((c) => c.props.id)).toEqual(["n1", "s3", "n3"]);
    const swapped = valid(swapNote(h, "n1", "b"));
    expect(swapped.content[0]).toMatchObject({ type: "note", props: { id: "n1", noteId: "b" } });
    const tag = valid(swapTagView(h, "v1", { tagId: "t2", viewId: "", viewKind: "cards" }));
    expect(tag.content[2]).toMatchObject({ type: "tag_view", props: { tagId: "t2", viewKind: "cards" } });
  });
  it("takes a pattern inserted between two of them", () => {
    const next = valid(insertPattern(flat(), "pattern_timeline", 1, [])).content.map((c) => c.type);
    expect(next).toEqual(["note", "pattern_timeline", "sidebar", "tag_view", "note"]);
  });
});
