import { describe, expect, it } from "vitest";
import {
  clampRatio, decodePane, defaultRightNote, dropSideAt, encodePane, isModClick, notePress, panesConflict, samePane,
  type PaneTarget,
} from "./splitView";

const note = (id: string, tab = "content"): PaneTarget => ({ kind: "note", id, tab });
const page = (mode: string): PaneTarget => ({ kind: "page", mode });

describe("a pane's destination in text", () => {
  it("round-trips a note's view and a function page", () => {
    for (const target of [note("n1"), note("n1", "canvas"), note("n1", "view:a"), page("tasks"), page("rss")]) {
      expect(decodePane(encodePane(target))).toEqual(target);
    }
  });
  it("reads a note with no tab as its content, and refuses what is not a destination", () => {
    expect(decodePane("note:n1")).toEqual(note("n1"));
    for (const bad of [null, undefined, "", "page:", "note:", "tasks", "page:a:b"]) expect(decodePane(bad)).toBeNull();
  });
  it("compares destinations by what they show", () => {
    expect(samePane(note("a"), note("a"))).toBe(true);
    expect(samePane(note("a"), note("a", "canvas"))).toBe(false);
    expect(samePane(null, null)).toBe(false);
  });
});

describe("which two destinations may share the screen", () => {
  it("never the same saved view twice, never the same page twice", () => {
    expect(panesConflict(note("a", "v1"), note("a", "v1"))).toBe(true);
    expect(panesConflict(page("tasks"), page("tasks"))).toBe(true);
  });
  it("a note's text on both sides is 並排: the editor on the left, rendered on the right", () => {
    expect(panesConflict(note("a"), note("a"))).toBe(false);
  });
  it("the same note in two different views is the point", () => {
    expect(panesConflict(note("a"), note("a", "canvas"))).toBe(false);
    expect(panesConflict(note("a", "v1"), note("a", "v2"))).toBe(false);
  });
  it("different notes, or a note beside a page, never conflict", () => {
    expect(panesConflict(note("a"), note("b"))).toBe(false);
    expect(panesConflict(note("a"), page("tasks"))).toBe(false);
    expect(panesConflict(page("tasks"), page("graph"))).toBe(false);
  });
});

describe("where a drag lands", () => {
  it("the right half of the window is the right side", () => {
    expect(dropSideAt(900, 1280)).toBe("right");
    expect(dropSideAt(640, 1280)).toBe("right");
    expect(dropSideAt(639, 1280)).toBe("left");
    expect(dropSideAt(-1, 1280)).toBeNull();
    expect(dropSideAt(10, 0)).toBeNull();
  });
  it("keeps the split between a quarter and three quarters", () => {
    expect(clampRatio(0.1)).toBe(0.25);
    expect(clampRatio(0.9)).toBe(0.75);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });
});

describe("what the right side starts with", () => {
  const notes = [
    { id: "old", node_type: "content", updated_at: "2026-10-01T00:00:00Z" },
    { id: "new", node_type: "content", updated_at: "2026-10-30T00:00:00Z" },
    { id: "tag", node_type: "class_tag", updated_at: "2026-10-31T00:00:00Z" },
    { id: "gone", node_type: "content", updated_at: "2026-10-31T00:00:00Z", deleted_at: "2026-10-31T01:00:00Z" },
  ];
  it("is the note last written, not a tag, not a deleted one", () => {
    expect(defaultRightNote(notes, null, "day")).toEqual(note("new"));
  });
  it("is never the note already open on the left", () => {
    expect(defaultRightNote(notes, "new", "day")).toEqual(note("old"));
  });
  it("falls back to today's day note, else nothing", () => {
    expect(defaultRightNote([], null, "day")).toEqual(note("day"));
    expect(defaultRightNote([], "day", "day")).toBeNull();
    expect(defaultRightNote([], null, null)).toBeNull();
  });
});

describe("Ctrl/⌘ + click", () => {
  it("counts for a moment after a press with the modifier, and not after a plain one", () => {
    notePress({ ctrlKey: true, metaKey: false }, 1000);
    expect(isModClick(1200)).toBe(true);
    expect(isModClick(2000)).toBe(false);
    notePress({ ctrlKey: false, metaKey: true }, 3000);
    expect(isModClick(3100)).toBe(true);
    notePress({ ctrlKey: false, metaKey: false }, 3200);
    expect(isModClick(3210)).toBe(false);
  });
});
