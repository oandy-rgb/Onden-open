import { describe, expect, it } from "vitest";
import type { ContentNode } from "../lib/api";
import { EXPANDED_CARD_MAX_H, FOLDED_CARD_H } from "../lib/cardDisplay";
import {
  boardTreePositions, computeBoardTree, pathFromRoot, toggleBranch, TREE_CARD_BUDGET, TREE_CHILD_PAGE,
  type BranchChoices, type TreeEntry, type TreeNoteEntry,
} from "../lib/boardTree";

const NONE: BranchChoices = { open: [], closed: [] };
const note = (id: string, parent: string | null, minute = 0, extra: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", parent_id: parent, hidden: false,
    updated_at: `2026-10-29T10:${String(minute).padStart(2, "0")}:00Z`, ...extra }) as ContentNode;
const kids = (parent: string, count: number, start = 0) => Array.from({ length: count }, (_, i) => note(`${parent}.${i}`, parent, start + i));
const notes = (entries: readonly TreeEntry[]) => entries.filter((e): e is TreeNoteEntry => e.kind === "note");
const ids = (entries: readonly TreeEntry[]) => entries.map((e) => e.id);
const tree = (nodes: ContentNode[], over: Partial<Parameters<typeof computeBoardTree>[0]> = {}) =>
  computeBoardTree({ nodes, rootId: "r", depth: 2, choices: NONE, budget: 100, ...over });

describe("computeBoardTree", () => {
  it("is the root alone when the note has no sub-notes, and empty when the root is not readable", () => {
    expect(tree([note("r", null)])).toEqual([{ kind: "note", id: "r", parentId: null, level: 0, childCount: 0, expanded: false, below: 0 }]);
    expect(tree([note("x", null)])).toEqual([]);
  });

  it("draws the root, then levels down to the chosen depth", () => {
    const nodes = [note("r", null), note("a", "r"), note("b", "a"), note("c", "b"), note("d", "c")];
    expect(ids(tree(nodes, { depth: 1 }))).toEqual(["r", "a"]);
    expect(ids(tree(nodes, { depth: 2 }))).toEqual(["r", "a", "b"]);
    expect(ids(tree(nodes, { depth: 3 }))).toEqual(["r", "a", "b", "c"]);
    expect(ids(tree(nodes, { depth: "all" }))).toEqual(["r", "a", "b", "c", "d"]);
  });

  it("shows 8 sub-notes per note, the most recently changed first, and the rest as one +N card", () => {
    const nodes = [note("r", null), ...kids("r", 11)];
    const entries = tree(nodes, { depth: 1 });
    expect(ids(entries).slice(1, 9)).toEqual(["r.10", "r.9", "r.8", "r.7", "r.6", "r.5", "r.4", "r.3"]);
    expect(entries.at(-1)).toEqual({ kind: "more", id: "more:r", parentId: "r", remaining: 11 - TREE_CHILD_PAGE });
    expect(entries).toHaveLength(1 + TREE_CHILD_PAGE + 1);
  });

  it("opens another page of 8 for each extra page asked for", () => {
    const nodes = [note("r", null), ...kids("r", 30)];
    const first = tree(nodes, { depth: 1, extraPages: new Map([["r", 1]]) });
    expect(notes(first)).toHaveLength(1 + 16);
    expect(first.at(-1)).toMatchObject({ kind: "more", remaining: 14 });
    const all = tree(nodes, { depth: 1, extraPages: new Map([["r", 3]]) });
    expect(notes(all)).toHaveLength(1 + 30);
    expect(all.some((e) => e.kind === "more")).toBe(false);
  });

  it("a note beyond the depth is collapsed and says how many notes are below it, all levels", () => {
    const nodes = [note("r", null), note("a", "r"), ...kids("a", 3), note("a.0.x", "a.0"), note("a.0.y", "a.0")];
    const a = notes(tree(nodes, { depth: 1 })).find((e) => e.id === "a")!;
    expect(a).toMatchObject({ childCount: 3, expanded: false, below: 5 });
  });

  it("an opened branch shows beyond the depth, a closed one hides within it", () => {
    const nodes = [note("r", null), note("a", "r"), note("b", "a"), note("c", "r")];
    expect(ids(tree(nodes, { depth: 1, choices: { open: ["a"], closed: [] } }))).toEqual(["r", "a", "c", "b"]);
    const closed = tree(nodes, { depth: 2, choices: { open: [], closed: ["a"] } });
    expect(ids(closed)).not.toContain("b");
    expect(notes(closed).find((e) => e.id === "a")).toMatchObject({ expanded: false, below: 1 });
  });

  it("never draws more cards than the budget, filling level by level, and the rest stay collapsed with their counts", () => {
    const nodes = [note("r", null), ...kids("r", 8), ...kids("r.0", 8), ...kids("r.1", 8)];
    const entries = tree(nodes, { depth: 2, budget: 14 });
    expect(entries).toHaveLength(14);
    // All of level 1 first (r + 8), then the first parent's children as far as they fit.
    expect(notes(entries).filter((e) => e.level === 1)).toHaveLength(8);
    const later = notes(entries).find((e) => e.id === "r.6")!;
    expect(later).toMatchObject({ expanded: false, childCount: 0 });
    const starved = notes(entries).find((e) => e.expanded === false && e.childCount > 0);
    expect(starved?.below).toBe(starved?.childCount);
  });

  it("the +N card counts toward the budget", () => {
    const nodes = [note("r", null), ...kids("r", 20)];
    expect(tree(nodes, { depth: 1, budget: 5 })).toHaveLength(5);
    expect(tree(nodes, { depth: 1, budget: 2 })).toHaveLength(2);
    expect(tree(nodes, { depth: 1, budget: 1 })).toHaveLength(1);
  });

  it("uses the phone and desktop budgets as constants", () => {
    expect(TREE_CARD_BUDGET).toEqual({ phone: 30, desktop: 100 });
  });

  it("leaves out hidden notes and tag rows, and sub-notes it cannot see are simply absent", () => {
    const nodes = [note("r", null), note("a", "r"), note("h", "r", 5, { hidden: true }), note("t", "r", 6, { node_type: "class_tag" })];
    expect(ids(tree(nodes))).toEqual(["r", "a"]);
  });

  it("survives a parent loop without drawing a note twice", () => {
    const nodes = [note("r", "c"), note("a", "r"), note("b", "a"), note("c", "b")];
    const entries = tree(nodes, { depth: "all" });
    expect(new Set(ids(entries)).size).toBe(entries.length);
    expect(ids(entries)).toEqual(["r", "a", "b", "c"]);
  });
});

describe("boardTreePositions", () => {
  const entries = tree([note("r", null), note("a", "r"), note("b", "r", 1), note("a1", "a")]);

  it("puts the root at the left, its sub-notes in the next column to the right, and gives every card a place", () => {
    const at = boardTreePositions(entries);
    expect([...at.keys()].sort()).toEqual(ids(entries).sort());
    expect(at.get("a")!.x).toBeGreaterThan(at.get("r")!.x);
    expect(at.get("a1")!.x).toBeGreaterThan(at.get("a")!.x);
    expect(at.get("a")!.x).toBe(at.get("r")!.x + 360);
    expect(at.get("a1")!.x).toBe(at.get("a")!.x + 360);
    // Siblings share a column and run top to bottom.
    expect(at.get("b")!.x).toBe(at.get("a")!.x);
    expect(at.get("b")!.y).toBeLessThan(at.get("a")!.y);
    expect(boardTreePositions([])).toEqual(new Map());
  });

  it("spaces siblings by the height each card is drawn at: folded cards sit closer than expanded ones", () => {
    const pitch = (heightOf?: (id: string) => number) => { const at = boardTreePositions(entries, heightOf); return at.get("a")!.y - at.get("b")!.y; };
    expect(pitch()).toBe(EXPANDED_CARD_MAX_H + 28);
    expect(pitch(() => FOLDED_CARD_H)).toBe(FOLDED_CARD_H + 28);
    expect(pitch(() => FOLDED_CARD_H)).toBeLessThan(pitch());
  });

  it("keeps cards of different heights from overlapping in a column", () => {
    const heights = new Map([["a", 400], ["b", FOLDED_CARD_H]]);
    const at = boardTreePositions(entries, (id) => heights.get(id) ?? EXPANDED_CARD_MAX_H);
    // b sits above a (newest first): b's bottom plus the gap reaches a's top, even though a is taller than its own children.
    expect(at.get("a")!.y - at.get("b")!.y).toBeGreaterThanOrEqual(FOLDED_CARD_H + 28);
  });
});

describe("toggleBranch", () => {
  const entry = (level: number, expanded: boolean) => ({ id: "x", level, expanded });
  it("closing a branch the depth shows records it as closed; closing one that was opened just forgets that", () => {
    expect(toggleBranch(NONE, entry(1, true), 2)).toEqual({ open: [], closed: ["x"] });
    expect(toggleBranch({ open: ["x"], closed: [] }, entry(2, true), 2)).toEqual({ open: [], closed: [] });
  });
  it("opening a branch the depth hides records it as open; reopening a closed one just forgets that", () => {
    expect(toggleBranch(NONE, entry(2, false), 2)).toEqual({ open: ["x"], closed: [] });
    expect(toggleBranch({ open: [], closed: ["x"] }, entry(1, false), 2)).toEqual({ open: [], closed: [] });
    expect(toggleBranch(NONE, entry(5, false), "all")).toEqual({ open: [], closed: [] });
  });
  it("remembers a bounded number of choices", () => {
    const many = Array.from({ length: 400 }, (_, i) => `n${i}`);
    expect(toggleBranch({ open: many, closed: [] }, entry(3, false), 2).open).toHaveLength(300);
  });
});

describe("pathFromRoot", () => {
  const nodes = [note("r", null), note("a", "r"), note("b", "a"), note("x", null), note("p", "q"), note("q", "p")];
  it("runs from the root down to the note, through every note between", () => {
    expect(pathFromRoot(nodes, "r", "b")).toEqual(["r", "a", "b"]);
    expect(pathFromRoot(nodes, "r", "r")).toEqual(["r"]);
  });
  it("a note that does not lead back, or a parent loop, still gives a path", () => {
    expect(pathFromRoot(nodes, "r", "x")).toEqual(["r", "x"]);
    expect(pathFromRoot(nodes, "r", "p")).toEqual(["r", "p"]);
  });
});
