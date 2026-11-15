// Property-based hardening of the ink erase geometry + document model
// (lib/ink/erase.ts, lib/ink/model.ts). Pure / DOM-free.
//
// Fixed fc seed (CI determinism), capped runs.
//
//   • erase intervals always lie within the stroke's index bounds, sorted,
//     non-overlapping and non-adjacent after merge
//   • erasing twice with the same trail is erasing once (idempotent union)
//   • merge order doesn't matter (union is commutative)
//   • visibleRuns is the exact complement of the erased intervals
//   • undo of an erase op restores the exact prior interval set; redo
//     restores the post-erase set

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { mergeIntervals, eraseStrokeWithTrail, visibleRuns, isFullyErased } from "../../lib/ink/erase";
import { InkModel } from "../../lib/ink/model";
import { extractInkClip, placeInkClip } from "../../lib/ink/clip";
import type { EraseInterval, InkStroke } from "../../lib/ink/types";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };
// vitest's 5 s default is a fixed budget for a run count that is not fixed:
// the nightly PROPS_RUNS=5000 (and a loaded CI box) outgrow it. Budget 20 ms per
// run (measured ~0.4 ms/run idle) so the limit scales with the work.
const PROPS_TIMEOUT_MS = Math.max(5_000, PROPS_RUNS * 20);

// ── Generators ───────────────────────────────────────────────────────────────

const coord = fc.double({ min: 0, max: 1000, noNaN: true });

const strokeArb: fc.Arbitrary<InkStroke> = fc
  .record({
    points: fc.array(fc.tuple(coord, coord), { minLength: 1, maxLength: 80 }),
    size: fc.double({ min: 1, max: 24, noNaN: true }),
  })
  .map(({ points, size }, ) => ({
    id: "s1",
    points: points.map(([x, y]) => [x, y] as [number, number]),
    color: "#000",
    size,
    toolId: "pen" as const,
  }));

const trailArb = fc.array(fc.tuple(coord, coord), { minLength: 1, maxLength: 20 })
  .map((t) => t.map(([x, y]) => [x, y] as const));

const radiusArb = fc.double({ min: 1, max: 80, noNaN: true });

// Raw (unsorted, possibly overlapping) interval sets over a point count.
function rawIntervalsArb(pointCount: number): fc.Arbitrary<EraseInterval[]> {
  const idx = fc.integer({ min: 0, max: Math.max(0, pointCount - 1) });
  return fc.array(
    fc.tuple(idx, idx).map(([a, b]) => (a <= b ? [a, b] : [b, a]) as EraseInterval),
    { maxLength: 8 },
  );
}

/** Reference implementation: the set of covered indices. */
function coveredSet(intervals: EraseInterval[]): Set<number> {
  const s = new Set<number>();
  for (const [a, b] of intervals) for (let i = a; i <= b; i++) s.add(i);
  return s;
}

function assertCanonical(intervals: EraseInterval[], pointCount: number): void {
  for (let i = 0; i < intervals.length; i++) {
    const [a, b] = intervals[i];
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(b).toBeLessThanOrEqual(pointCount - 1);
    if (i > 0) expect(a).toBeGreaterThan(intervals[i - 1][1] + 1); // sorted, disjoint, non-adjacent
  }
}

// ── Properties ───────────────────────────────────────────────────────────────

describe("ink erase geometry properties", { timeout: PROPS_TIMEOUT_MS }, () => {
  it("mergeIntervals: canonical output, exact same coverage, idempotent, order-independent", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }).chain((n) =>
        fc.tuple(fc.constant(n), rawIntervalsArb(n)),
      ), ([n, raw]) => {
        const merged = mergeIntervals(raw);
        assertCanonical(merged, n);
        expect(coveredSet(merged)).toEqual(coveredSet(raw));
        // idempotent
        expect(mergeIntervals(merged)).toEqual(merged);
        // commutative (order of inputs irrelevant)
        expect(mergeIntervals([...raw].reverse())).toEqual(merged);
      }),
      fcOpts,
    );
  });

  it("eraseStrokeWithTrail: result is canonical, within bounds, and grows coverage monotonically", () => {
    fc.assert(
      fc.property(strokeArb, trailArb, radiusArb, (stroke, trail, radius) => {
        const out = eraseStrokeWithTrail(stroke, undefined, trail, radius);
        if (out === null) return; // trail hit nothing — fine
        assertCanonical(out, stroke.points.length);
        // a second pass over the merged result must report "no change"
        const again = eraseStrokeWithTrail(stroke, out, trail, radius);
        expect(again).toBeNull();
      }),
      fcOpts,
    );
  });

  it("erase union is order-independent: trail A then B === trail B then A", () => {
    fc.assert(
      fc.property(strokeArb, trailArb, trailArb, radiusArb, (stroke, t1, t2, radius) => {
        const apply = (trails: Array<typeof t1>): EraseInterval[] => {
          let acc: EraseInterval[] | undefined;
          for (const t of trails) {
            const next = eraseStrokeWithTrail(stroke, acc, t, radius);
            if (next !== null) acc = next;
          }
          return acc ?? [];
        };
        expect(apply([t1, t2])).toEqual(apply([t2, t1]));
      }),
      fcOpts,
    );
  });

  it("visibleRuns is the exact complement of the erased set", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }).chain((n) =>
        fc.tuple(fc.constant(n), rawIntervalsArb(n)),
      ), ([n, raw]) => {
        const erased = mergeIntervals(raw);
        const runs = visibleRuns(n, erased);
        assertCanonical(runs, n);
        const dead = coveredSet(erased);
        const alive = coveredSet(runs);
        for (let i = 0; i < n; i++) {
          expect(alive.has(i)).toBe(!dead.has(i));
        }
        expect(isFullyErased(n, erased)).toBe(alive.size === 0);
      }),
      fcOpts,
    );
  });
});

describe("ink model undo/redo properties", { timeout: PROPS_TIMEOUT_MS }, () => {
  const strokesArb = fc.array(
    fc.tuple(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 9 })),
    { minLength: 1, maxLength: 4 },
  ).map((specs) =>
    specs.map(([n, k], i): InkStroke => ({
      id: `s${i}-${k}`,
      points: Array.from({ length: n }, (_, j) => [j * 10, (i + 1) * 5] as [number, number]),
      color: "#000",
      size: 4,
      toolId: "pen",
    })),
  );

  it("undo of an erase restores the EXACT prior interval set; redo restores the merged after-set", () => {
    fc.assert(
      fc.property(
        strokesArb,
        fc.array(fc.nat(), { maxLength: 6 }),
        (strokes, seedInts) => {
          const model = new InkModel();
          for (const s of strokes) model.addStroke(s);

          // First erase: seed some prior state on stroke 0.
          const s0 = strokes[0];
          const n0 = s0.points.length;
          const prior = seedInts.length > 0
            ? mergeIntervals(seedInts.map((v): EraseInterval => {
                const a = v % n0;
                return [a, Math.min(n0 - 1, a + (v % 3))];
              }))
            : [];
          if (prior.length > 0) model.applyErase({ [s0.id]: prior });
          const beforeSnapshot = JSON.parse(JSON.stringify(model.erased));

          // Second erase: arbitrary (raw, unmerged) intervals on stroke 0.
          const raw: EraseInterval[] = [[0, Math.min(2, n0 - 1)], ...prior];
          model.applyErase({ [s0.id]: raw });
          const afterSnapshot = JSON.parse(JSON.stringify(model.erased));
          // model normalizes via mergeIntervals
          expect(model.erased[s0.id]).toEqual(mergeIntervals(raw));

          // undo → exact prior state
          expect(model.undo()).toBe(true);
          expect(JSON.parse(JSON.stringify(model.erased))).toEqual(beforeSnapshot);

          // redo → exact post-erase state
          expect(model.redo()).toBe(true);
          expect(JSON.parse(JSON.stringify(model.erased))).toEqual(afterSnapshot);

          // serialize→load round-trips the erased map (undo history cleared)
          const doc = model.serialize();
          const m2 = new InkModel();
          m2.load(doc);
          expect(JSON.parse(JSON.stringify(m2.erased))).toEqual(afterSnapshot);
          expect(m2.canUndo()).toBe(false);
        },
      ),
      fcOpts,
    );
  });

  it("undo/redo never throws and is self-consistent under random op sequences", () => {
    const op = fc.constantFrom("add", "erase", "undo", "redo");
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
        const model = new InkModel();
        let counter = 0;
        for (const o of ops) {
          if (o === "add") {
            model.addStroke({
              id: `s${counter++}`,
              points: [[0, 0], [10, 10]],
              color: "#000",
              size: 4,
              toolId: "pen",
            });
          } else if (o === "erase" && model.strokes.length > 0) {
            const target = model.strokes[model.strokes.length - 1];
            model.applyErase({ [target.id]: [[0, 0]] });
          } else if (o === "undo") {
            model.undo();
          } else if (o === "redo") {
            model.redo();
          }
          // invariant: every erased id refers to canonical intervals
          for (const [id, ivs] of Object.entries(model.erased)) {
            expect(mergeIntervals(ivs)).toEqual(ivs);
            const stroke = model.strokes.find((s) => s.id === id);
            if (stroke) assertCanonical(ivs, stroke.points.length);
          }
        }
      }),
      fcOpts,
    );
  });
});

// ── Board copy/paste (lib/ink/clip.ts) ───────────────────────────────────────

describe("ink clip (board copy/paste)", () => {
  it("pasting a copy adds fresh ids, keeps the shape of every visible run, and one undo per item restores the drawing", () => {
    fc.assert(
      fc.property(strokeArb, trailArb, radiusArb, fc.integer({ min: -500, max: 500 }), fc.integer({ min: -500, max: 500 }), (stroke, trail, radius, dx, dy) => {
        const model = new InkModel();
        model.addStroke(stroke);
        const erased = eraseStrokeWithTrail(stroke, undefined, trail, radius);
        if (erased) model.applyErase({ [stroke.id]: erased }, new Set());
        const clip = extractInkClip(model, { strokeIds: [stroke.id], shapeIds: [] });
        const runs = visibleRuns(stroke.points.length, model.erased[stroke.id]);
        // Every visible run is one new stroke with the same points.
        expect(clip.strokes.map((s) => s.points)).toEqual(runs.map(([a, b]) => stroke.points.slice(a, b + 1)));
        let n = 0;
        const placed = placeInkClip(clip, dx, dy, () => `new-${n++}`);
        expect(new Set(placed.strokes.map((s) => s.id)).size).toBe(placed.strokes.length);
        placed.strokes.forEach((s, i) => s.points.forEach((p, j) => {
          expect(p[0]).toBeCloseTo(clip.strokes[i]!.points[j]![0] + dx, 6);
          expect(p[1]).toBeCloseTo(clip.strokes[i]!.points[j]![1] + dy, 6);
        }));
        // The source is untouched by the copy.
        expect(model.strokes).toHaveLength(1);
        for (const s of placed.strokes) model.addStroke(s);
        expect(model.strokes).toHaveLength(1 + placed.strokes.length);
        for (let i = 0; i < placed.strokes.length; i++) model.undo();
        expect(model.strokes.map((s) => s.id)).toEqual([stroke.id]);
      }),
      fcOpts,
    );
  }, PROPS_TIMEOUT_MS);
});
