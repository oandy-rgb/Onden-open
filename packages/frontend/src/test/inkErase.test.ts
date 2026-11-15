import { describe, it, expect } from "vitest";
import { mergeIntervals, eraseStrokeWithTrail, visibleRuns, isFullyErased } from "../lib/ink/erase";
import type { EraseInterval, InkStroke } from "../lib/ink/types";

// Erase geometry + the interval algebra the handwriting-as-CRDT story rests on:
// erased intervals are an interval UNION (grow-only, order-independent), so a
// stroke's dead ranges merge commutatively across edits/devices.

const stroke = (points: [number, number][], size = 0): InkStroke =>
  ({ id: "s", points, color: "#000", size, toolId: "pen" });

describe("mergeIntervals", () => {
  it("sorts and merges overlapping intervals", () => {
    expect(mergeIntervals([[5, 7], [0, 3], [2, 6]])).toEqual([[0, 7]]);
  });

  it("merges directly-adjacent intervals ([0,2]+[3,5] -> [0,5])", () => {
    expect(mergeIntervals([[0, 2], [3, 5]])).toEqual([[0, 5]]);
  });

  it("keeps a one-index gap as two intervals ([0,2]+[4,5])", () => {
    expect(mergeIntervals([[0, 2], [4, 5]])).toEqual([[0, 2], [4, 5]]);
  });

  it("is a no-op (copy) for 0 or 1 interval", () => {
    expect(mergeIntervals([])).toEqual([]);
    expect(mergeIntervals([[1, 3]])).toEqual([[1, 3]]);
  });

  it("does not mutate its input", () => {
    const input: EraseInterval[] = [[3, 5], [0, 1]];
    const snapshot = JSON.parse(JSON.stringify(input));
    mergeIntervals(input);
    expect(input).toEqual(snapshot);
  });

  it("is order-independent (the union/commutativity invariant)", () => {
    const a: EraseInterval[] = [[0, 2], [10, 12]];
    const b: EraseInterval[] = [[2, 4], [11, 15]];
    const ab = mergeIntervals([...a, ...b]);
    const ba = mergeIntervals([...b, ...a]);
    expect(ab).toEqual(ba);
    expect(ab).toEqual([[0, 4], [10, 15]]);
  });
});

describe("eraseStrokeWithTrail", () => {
  // A horizontal stroke at y=0, points at x = 0,10,20,30,40.
  const horiz = stroke([[0, 0], [10, 0], [20, 0], [30, 0], [40, 0]]);

  it("returns null when nothing is hit", () => {
    expect(eraseStrokeWithTrail(horiz, undefined, [[0, 1000]], 2)).toBeNull();
  });

  it("returns null for an empty trail or empty stroke", () => {
    expect(eraseStrokeWithTrail(horiz, undefined, [], 5)).toBeNull();
    expect(eraseStrokeWithTrail(stroke([]), undefined, [[0, 0]], 5)).toBeNull();
  });

  it("marks the contiguous run of points within reach of a single eraser point", () => {
    // eraser at x=10, radius 5 → only the point at x=10 (index 1) dies
    expect(eraseStrokeWithTrail(horiz, undefined, [[10, 0]], 5)).toEqual([[1, 1]]);
  });

  it("a trail SEGMENT catches points between its samples (no tunnelling)", () => {
    // one segment from x=5 to x=35 sweeps over indices 1,2,3 (x=10,20,30)
    expect(eraseStrokeWithTrail(horiz, undefined, [[5, 0], [35, 0]], 3)).toEqual([[1, 3]]);
  });

  it("includes the stroke half-size in its reach", () => {
    // eraser point at x=10,y=8; radius 3 alone (reach 3) misses (dist 8);
    // with stroke.size=12 → reach = 3 + 6 = 9 ≥ 8 → hits index 1
    const thick = stroke([[0, 0], [10, 0], [20, 0]], 12);
    expect(eraseStrokeWithTrail(thick, undefined, [[10, 8]], 3)).toEqual([[1, 1]]);
  });

  it("merges new hits with existing intervals", () => {
    // existing dead [0,0]; erase index 1 → merges to [0,1]
    expect(eraseStrokeWithTrail(horiz, [[0, 0]], [[10, 0]], 5)).toEqual([[0, 1]]);
  });

  it("returns null when the erase adds no new coverage (no-op guard)", () => {
    // index 1 already dead; erasing it again changes nothing
    expect(eraseStrokeWithTrail(horiz, [[1, 1]], [[10, 0]], 5)).toBeNull();
  });

  it("produces two intervals when the trail hits two separated runs", () => {
    // two single-point eraser dabs at x=0 and x=40
    const out = eraseStrokeWithTrail(horiz, undefined, [[0, 0]], 5);
    const out2 = eraseStrokeWithTrail(horiz, out ?? undefined, [[40, 0]], 5);
    expect(out2).toEqual([[0, 0], [4, 4]]);
  });
});

describe("visibleRuns (complement of erased)", () => {
  it("returns the whole stroke when nothing is erased", () => {
    expect(visibleRuns(5, undefined)).toEqual([[0, 4]]);
    expect(visibleRuns(5, [])).toEqual([[0, 4]]);
  });

  it("returns [] for an empty stroke", () => {
    expect(visibleRuns(0, undefined)).toEqual([]);
  });

  it("splits around a middle dead interval", () => {
    // points 0..6, dead [2,4] → survivors [0,1] and [5,6]
    expect(visibleRuns(7, [[2, 4]])).toEqual([[0, 1], [5, 6]]);
  });

  it("drops a leading and trailing dead interval", () => {
    expect(visibleRuns(7, [[0, 1], [5, 6]])).toEqual([[2, 4]]);
  });

  it("keeps single-point survivors (they render as dots)", () => {
    // dead [1,1] and [3,3] over 0..4 → survivors [0,0],[2,2],[4,4]
    expect(visibleRuns(5, [[1, 1], [3, 3]])).toEqual([[0, 0], [2, 2], [4, 4]]);
  });

  it("returns [] when every point is dead", () => {
    expect(visibleRuns(5, [[0, 4]])).toEqual([]);
  });
});

describe("isFullyErased", () => {
  it("is true only when the intervals cover the whole stroke", () => {
    expect(isFullyErased(5, [[0, 4]])).toBe(true);
    expect(isFullyErased(5, [[0, 3]])).toBe(false);
    expect(isFullyErased(5, undefined)).toBe(false);
  });
});
