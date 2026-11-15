import { describe, expect, it } from "vitest";
import { bodyConflictPayload, splitLines, threeWayMergeBody, type BodyConflict } from "../services/eventLog/bodyMerge.js";

// Edges of the line merge that bodyMerge.test.ts leaves out (found by mutation
// testing, docs/archive/research/mutation-2026-10-24.md): where two changes only touch,
// regions that grow through a chain of overlaps, a body without a final newline,
// the very large body and the size cap of the BODY_CONFLICT payload.

describe("splitLines", () => {
  it("keeps each line's newline so the pieces join back to the text", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("a\n")).toEqual(["a\n"]);
    expect(splitLines("a\nb")).toEqual(["a\n", "b"]);
    expect(splitLines("a\n\nb\n")).toEqual(["a\n", "\n", "b\n"]);
    expect(splitLines("abc")).toEqual(["abc"]);
    expect(splitLines("a\nbc")).toEqual(["a\n", "bc"]);
    expect(splitLines("line one\nline two")).toEqual(["line one\n", "line two"]);
    expect(splitLines("\n\n")).toEqual(["\n", "\n"]);
    for (const text of ["", "x", "x\n", "x\ny", "\nx\n\n"]) expect(splitLines(text).join("")).toBe(text);
  });
});

describe("changes that only touch", () => {
  it("replacements on neighbouring lines both land", () => {
    expect(threeWayMergeBody("a\nb\nc\nd\n", "a\nB\nc\nd\n", "a\nb\nC\nd\n"))
      .toEqual({ merged: "a\nB\nC\nd\n", clean: true, conflicts: [] });
    expect(threeWayMergeBody("a\nb\nc\nd\n", "a\nb\nC\nd\n", "a\nB\nc\nd\n"))
      .toEqual({ merged: "a\nB\nC\nd\n", clean: true, conflicts: [] });
  });

  // The rule: an insertion at the edge of the other side's replaced lines is not a
  // conflict; it lands before or after them. Whichever writer inserts.
  it("an insertion just before or after the other side's replaced lines lands next to them", () => {
    const base = "a\nb\nc\n";
    const replaced = "a\nX\nc\n";
    const before = "a\nnew\nb\nc\n";
    const after = "a\nb\nnew\nc\n";
    expect(threeWayMergeBody(base, before, replaced)).toEqual({ merged: "a\nnew\nX\nc\n", clean: true, conflicts: [] });
    expect(threeWayMergeBody(base, replaced, before)).toEqual({ merged: "a\nnew\nX\nc\n", clean: true, conflicts: [] });
    expect(threeWayMergeBody(base, after, replaced)).toEqual({ merged: "a\nX\nnew\nc\n", clean: true, conflicts: [] });
    expect(threeWayMergeBody(base, replaced, after)).toEqual({ merged: "a\nX\nnew\nc\n", clean: true, conflicts: [] });
  });

  it("an insertion inside the other side's replaced lines is a conflict, whichever side inserts", () => {
    const base = "a\nb\nc\nd\n";
    const replaced = "a\nX\nd\n"; // b and c become X
    const inside = "a\nb\nnew\nc\nd\n";
    const mine = threeWayMergeBody(base, inside, replaced);
    expect(mine.clean).toBe(false);
    expect(mine.merged).toBe(inside);
    expect(mine.conflicts).toEqual([{ base: "b\nc\n", incoming: "b\nnew\nc\n", current: "X\n", before: "a\n", after: "d\n" }]);
    const theirs = threeWayMergeBody(base, replaced, inside);
    expect(theirs.clean).toBe(false);
    expect(theirs.merged).toBe(replaced);
    expect(theirs.conflicts).toEqual([{ base: "b\nc\n", incoming: "X\n", current: "b\nnew\nc\n", before: "a\n", after: "d\n" }]);
  });

  it("two insertions at different points both land; the same insertion at the same point lands once", () => {
    expect(threeWayMergeBody("a\nb\nc\n", "a\nx\nb\nc\n", "a\nb\ny\nc\n")).toEqual({ merged: "a\nx\nb\ny\nc\n", clean: true, conflicts: [] });
    expect(threeWayMergeBody("a\nb\n", "a\nsame\nb\n", "a\nsame\nb\n")).toEqual({ merged: "a\nsame\nb\n", clean: true, conflicts: [] });
    expect(threeWayMergeBody("a\nb\nc\n", "a\nsame\nb\nc1\n", "a\nsame\nb\nc\n")).toEqual({ merged: "a\nsame\nb\nc1\n", clean: true, conflicts: [] });
  });

  it("an insertion and a deletion that meet at one point do not conflict", () => {
    // current deletes b; incoming inserts a line right after b (at the deletion's end edge)
    expect(threeWayMergeBody("a\nb\nc\n", "a\nb\nnew\nc\n", "a\nc\n")).toEqual({ merged: "a\nnew\nc\n", clean: true, conflicts: [] });
  });
});

describe("a region grows through a chain of overlaps", () => {
  // incoming changes lines 1-2 and 4-5 (line 3 is kept); current changes 2-4, which
  // overlaps both. The three hunks are one conflict, though incoming's two hunks
  // do not touch each other.
  it("pulls in a hunk that overlaps only the other side's hunk", () => {
    const base = "0\n1\n2\n3\n4\n5\n6\n";
    const incoming = "0\nA\nA\n3\nB\nB\n6\n";
    const current = "0\n1\nC\nC\nC\n5\n6\n";
    const r = threeWayMergeBody(base, incoming, current);
    expect(r.clean).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toEqual({
      base: "1\n2\n3\n4\n5\n", incoming: "A\nA\n3\nB\nB\n", current: "1\nC\nC\nC\n5\n", before: "0\n", after: "6\n",
    });
    expect(r.merged).toBe(incoming);
  });

  it("grows the same way when the other side is the one with two hunks", () => {
    const base = "0\n1\n2\n3\n4\n5\n6\n";
    const incoming = "0\n1\nC\nC\nC\n5\n6\n";
    const current = "0\nA\nA\n3\nB\nB\n6\n";
    const r = threeWayMergeBody(base, incoming, current);
    expect(r.clean).toBe(false);
    expect(r.conflicts).toEqual([{
      base: "1\n2\n3\n4\n5\n", incoming: "1\nC\nC\nC\n5\n", current: "A\nA\n3\nB\nB\n", before: "0\n", after: "6\n",
    }]);
    expect(r.merged).toBe(incoming);
  });

  it("takes the region's whole extent when the other side changed more lines than incoming", () => {
    const base = "a\nb\nc\nd\ne\nf\n";
    const r = threeWayMergeBody(base, "a\nB\nc\nd\ne\nf\n", "a\nX\ne\nf\n");
    expect(r.conflicts).toEqual([{ base: "b\nc\nd\n", incoming: "B\nc\nd\n", current: "X\n", before: "a\n", after: "e\n" }]);
    expect(r.merged).toBe("a\nB\nc\nd\ne\nf\n");
    // the same, with the writers swapped
    const s = threeWayMergeBody(base, "a\nX\ne\nf\n", "a\nB\nc\nd\ne\nf\n");
    expect(s.conflicts).toEqual([{ base: "b\nc\nd\n", incoming: "X\n", current: "B\nc\nd\n", before: "a\n", after: "e\n" }]);
    expect(s.merged).toBe("a\nX\ne\nf\n");
  });

  it("keeps the text outside the conflict, from both sides' other edits, in order", () => {
    const r = threeWayMergeBody("1\n2\n3\n4\n5\n6\n7\n", "1a\n2\nx\n4\n5\n6\n7\n", "1\n2\ny\n4\n5\n6\n7a\n");
    expect(r.merged).toBe("1a\n2\nx\n4\n5\n6\n7a\n");
    expect(r.conflicts.map((c) => [c.incoming, c.current, c.before, c.after])).toEqual([["x\n", "y\n", "2\n", "4\n"]]);
  });

  it("reports several conflicts in the order they appear, each with its own neighbours", () => {
    const r = threeWayMergeBody("a\nb\nc\nd\ne\n", "a\nB1\nc\nD1\ne\n", "a\nB2\nc\nD2\ne\n");
    expect(r.conflicts.map((c) => [c.base, c.incoming, c.current, c.before, c.after])).toEqual([
      ["b\n", "B1\n", "B2\n", "a\n", "c\n"],
      ["d\n", "D1\n", "D2\n", "c\n", "e\n"],
    ]);
    expect(r.merged).toBe("a\nB1\nc\nD1\ne\n");
  });

  it("a conflict at the first or last line has an empty neighbour on that side", () => {
    const first = threeWayMergeBody("a\nb\n", "A1\nb\n", "A2\nb\n");
    expect(first.conflicts[0]).toMatchObject({ before: "", after: "b\n" });
    const last = threeWayMergeBody("a\nb\n", "a\nB1\n", "a\nB2\n");
    expect(last.conflicts[0]).toMatchObject({ before: "a\n", after: "" });
  });
});

describe("a body without a final newline", () => {
  it("keeps the ending the writer who changed it chose, else the others'", () => {
    // nobody changed the ending: it stays without one
    expect(threeWayMergeBody("a\nb", "a\nB", "a\nb\nc")).toEqual({ merged: "a\nB\nc", clean: true, conflicts: [] });
    // incoming dropped the final newline, current added a line
    expect(threeWayMergeBody("a\nb\n", "a\nB", "a\nb\nc\n")).toEqual({ merged: "a\nB\nc", clean: true, conflicts: [] });
    // incoming kept it while current dropped it: the one that changed it (current) decides
    expect(threeWayMergeBody("a\nb\n", "a\nB\n", "a\nb")).toEqual({ merged: "a\nB", clean: true, conflicts: [] });
    // incoming added the final newline that base lacked
    expect(threeWayMergeBody("a\nb", "a\nB\n", "a\nb\nc")).toEqual({ merged: "a\nB\nc\n", clean: true, conflicts: [] });
  });

  it("a conflict on the last line has no newline in its text and nothing after it", () => {
    const r = threeWayMergeBody("a\nb", "a\nB1", "a\nB2");
    expect(r.merged).toBe("a\nB1");
    expect(r.conflicts).toEqual([{ base: "b\n", incoming: "B1", current: "B2", before: "a\n", after: "" }]);
  });

  it("a conflict just before the last line gives that line without its newline as `after`", () => {
    const r = threeWayMergeBody("a\nb\nc", "a\nB1\nc", "a\nB2\nc");
    expect(r.merged).toBe("a\nB1\nc");
    expect(r.conflicts[0]).toMatchObject({ incoming: "B1\n", current: "B2\n", before: "a\n", after: "c" });
  });

  it("a conflict two lines before the end keeps the newline on `after`", () => {
    const r = threeWayMergeBody("a\nb\nc\nd", "a\nB1\nc\nd", "a\nB2\nc\nd");
    expect(r.conflicts[0]).toMatchObject({ before: "a\n", after: "c\n" });
    expect(r.merged).toBe("a\nB1\nc\nd");
  });
});

describe("a body with more distinct lines than one line diff can name", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\n`);
  const edit = (all: string[], at: number) => all.map((l, i) => (i === at ? `edited ${at}\n` : l)).join("");

  it("treats a change on both sides as one conflict over the whole body", () => {
    const all = lines(70_000);
    const base = all.join("");
    const incoming = edit(all, 5);
    const current = edit(all, 60_000);
    const r = threeWayMergeBody(base, incoming, current);
    expect(r.clean).toBe(false);
    expect(r.merged).toBe(incoming);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ base, incoming, current });
  });

  it("still diffs line by line at exactly the largest body one line diff can name", () => {
    // 65,535 distinct lines; each side's change reuses a line that is already there, so no new distinct line appears
    const all = lines(65_535);
    const base = all.join("");
    const reuse = (at: number, from: number) => all.map((l, i) => (i === at ? all[from]! : l)).join("");
    const r = threeWayMergeBody(base, reuse(5, 6), reuse(60_000, 60_001));
    expect(r.clean).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.merged).toBe(all.map((l, i) => (i === 5 ? all[6]! : i === 60_000 ? all[60_001]! : l)).join(""));
  });

  it("lands one side's change when the other side only differs in its final newline", () => {
    const all = lines(70_000);
    const base = all.join("");
    const incoming = edit(all, 5);
    const current = base.slice(0, -1); // same lines, no final newline
    const r = threeWayMergeBody(base, incoming, current);
    expect(r.clean).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.merged).toBe(incoming.slice(0, -1));
  });
});

describe("bodyConflictPayload", () => {
  const conflict = (n: { base?: number; incoming?: number; current?: number; before?: number; after?: number }): BodyConflict => ({
    base: "b".repeat(n.base ?? 0), incoming: "i".repeat(n.incoming ?? 0), current: "c".repeat(n.current ?? 0),
    before: "<".repeat(n.before ?? 0), after: ">".repeat(n.after ?? 0),
  });

  it("carries the conflicts with their count", () => {
    const list = [conflict({ base: 3, incoming: 2 }), conflict({ current: 4 })];
    expect(bodyConflictPayload(list)).toEqual({ conflicts: list, conflict_count: 2 });
    expect(bodyConflictPayload([])).toEqual({ conflicts: [], conflict_count: 0 });
  });

  it("keeps the text up to 50,000 characters over all five fields and every conflict", () => {
    const exactly = [conflict({ base: 10_000, incoming: 10_000, current: 10_000, before: 10_000 }), conflict({ after: 10_000 })];
    expect(bodyConflictPayload(exactly)).toEqual({ conflicts: exactly, conflict_count: 2 });
    const oneOver = [conflict({ base: 10_000, incoming: 10_000, current: 10_000, before: 10_000 }), conflict({ after: 10_001 })];
    expect(bodyConflictPayload(oneOver)).toEqual({ conflicts: [], conflict_count: 2, truncated: true });
  });

  it("counts the before and after text too, not only the three sides", () => {
    expect(bodyConflictPayload([conflict({ before: 25_001, after: 25_000 })])).toMatchObject({ truncated: true, conflict_count: 1 });
    expect(bodyConflictPayload([conflict({ base: 1, incoming: 1, current: 1, before: 1, after: 49_996 })])).not.toHaveProperty("truncated");
    expect(bodyConflictPayload([conflict({ base: 1, incoming: 1, current: 1, before: 1, after: 49_997 })])).toHaveProperty("truncated", true);
  });
});

describe("an emptied body has no ending to keep", () => {
  // The server body was emptied by one writer; the other writer's text must not come back with a
  // "\n" nobody typed (it showed up as a blank last line on the next load, then a later merge dropped it).
  it("the other side's insertion lands without a trailing newline", () => {
    expect(threeWayMergeBody("A", "B\nA", "")).toEqual({ merged: "B", clean: true, conflicts: [] });
    expect(threeWayMergeBody("A", "A\nB", "")).toEqual({ merged: "B", clean: true, conflicts: [] });
  });
  it("the writer who emptied the body leaves the other side's ending alone", () => {
    expect(threeWayMergeBody("x", "", "x\ny")).toEqual({ merged: "y", clean: true, conflicts: [] });
    expect(threeWayMergeBody("x\n", "", "x\ny\n")).toEqual({ merged: "y\n", clean: true, conflicts: [] });
  });
});
