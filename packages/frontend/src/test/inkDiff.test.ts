import { describe, expect, it } from "vitest";
import { diffInk, describeInkDiff, isEmptyInkDiff } from "../lib/ink/diff";
import type { InkDocument, InkShape, InkStroke } from "../lib/ink/types";

const stroke = (id: string, n = 4): InkStroke => ({
  id,
  points: Array.from({ length: n }, (_, i) => [i * 10, i * 5] as [number, number]),
  color: "#1a1a1a",
  size: 3,
  toolId: "pen",
});

const shp = (id: string): InkShape => ({ id, kind: "rectangle", start: [0, 0], end: [1, 1], color: "#1a1a1a", size: 3 });

const doc = (strokes: InkStroke[], erased: InkDocument["erased"] = {}, shapes?: InkShape[]): InkDocument => ({
  version: 1,
  strokes,
  erased,
  page: { width: 1000 },
  ...(shapes ? { shapes } : {}),
});

describe("diffInk", () => {
  it("from null: everything counts as drawn", () => {
    const d = diffInk(null, doc([stroke("a"), stroke("b")]));
    expect(d.addedStrokes.map((s) => s.id)).toEqual(["a", "b"]);
    expect(d.removedStrokes).toEqual([]);
    expect(isEmptyInkDiff(d)).toBe(false);
  });

  it("identical docs diff to empty", () => {
    const a = doc([stroke("a")], { a: [[0, 1]] });
    expect(isEmptyInkDiff(diffInk(a, a))).toBe(true);
  });

  it("detects added + undone strokes by id, not position", () => {
    const d = diffInk(doc([stroke("a"), stroke("b")]), doc([stroke("b"), stroke("c")]));
    expect(d.addedStrokes.map((s) => s.id)).toEqual(["c"]);
    expect(d.removedStrokes.map((s) => s.id)).toEqual(["a"]);
  });

  it("erase delta is interval subtraction, not whole-stroke", () => {
    const prev = doc([stroke("a", 20)], { a: [[2, 5]] });
    const next = doc([stroke("a", 20)], { a: [[2, 9], [14, 16]] });
    const d = diffInk(prev, next);
    // [2,9] minus the pre-existing [2,5] leaves [6,9]; [14,16] is all-new.
    expect(d.newlyErased).toEqual({ a: [[6, 9], [14, 16]] });
    expect(d.unerased).toEqual({});
  });

  it("an undone erase shows up as unerased", () => {
    const prev = doc([stroke("a", 20)], { a: [[4, 8]] });
    const next = doc([stroke("a", 20)], {});
    const d = diffInk(prev, next);
    expect(d.unerased).toEqual({ a: [[4, 8]] });
    expect(d.newlyErased).toEqual({});
  });

  it("erase fully covered by prior coverage is no delta", () => {
    const prev = doc([stroke("a", 20)], { a: [[0, 10]] });
    const next = doc([stroke("a", 20)], { a: [[3, 7]] });
    const d = diffInk(prev, next);
    expect(d.newlyErased).toEqual({});
    // …but prev coverage [0,2]∪[8,10] is gone → restored.
    expect(d.unerased).toEqual({ a: [[0, 2], [8, 10]] });
  });

  it("commutativity sanity: two independent saves union the same in either order", () => {
    // Mirrors the merge story: strokes grow-set ∪, erased interval-union.
    const base = doc([stroke("a")]);
    const mine = doc([stroke("a"), stroke("m")], { a: [[0, 1]] });
    const theirs = doc([stroke("a"), stroke("t")], { a: [[2, 3]] });
    const dMine = diffInk(base, mine);
    const dTheirs = diffInk(base, theirs);
    const ids = (xs: InkStroke[]) => xs.map((s) => s.id).sort();
    expect(ids([...dMine.addedStrokes, ...dTheirs.addedStrokes])).toEqual(["m", "t"]);
    // Disjoint erase deltas on the same stroke union cleanly.
    expect([...dMine.newlyErased.a, ...dTheirs.newlyErased.a].sort((x, y) => x[0] - y[0]))
      .toEqual([[0, 1], [2, 3]]);
  });
});

describe("describeInkDiff", () => {
  it("reads as a gesture, not a schema", () => {
    const d = diffInk(
      doc([stroke("a", 20)], {}),
      doc([stroke("a", 20), stroke("b"), stroke("c")], { a: [[1, 3]] }),
    );
    expect(describeInkDiff(d)).toBe("drew 2 strokes, erased 1 span");
  });
  it("empty diff says so", () => {
    const a = doc([stroke("a")]);
    expect(describeInkDiff(diffInk(a, a))).toBe("no ink change");
  });
  it("reports restored (un-erased) spans in the singular", () => {
    const prev = doc([stroke("a", 20)], { a: [[0, 3]] });
    const next = doc([stroke("a", 20)], {});
    expect(describeInkDiff(diffInk(prev, next))).toBe("restored 1 erased span");
  });
});

describe("diffInk — shapes (grow-set, same as strokes)", () => {
  it("reports added and removed shapes by id", () => {
    const d = diffInk(doc([], {}, [shp("x")]), doc([], {}, [shp("y")]));
    expect(d.addedShapes.map((s) => s.id)).toEqual(["y"]);
    expect(d.removedShapes.map((s) => s.id)).toEqual(["x"]);
  });

  it("a doc that omits shapes diffs cleanly against one that has them", () => {
    const d = diffInk(doc([]), doc([], {}, [shp("x")]));
    expect(d.addedShapes.map((s) => s.id)).toEqual(["x"]);
    expect(d.removedShapes).toEqual([]);
    expect(isEmptyInkDiff(d)).toBe(false);
  });

  it("describeInkDiff names shape gestures", () => {
    const d = diffInk(doc([], {}, [shp("x")]), doc([], {}, [shp("x"), shp("y"), shp("z")]));
    expect(describeInkDiff(d)).toBe("added 2 shapes");
  });
});
