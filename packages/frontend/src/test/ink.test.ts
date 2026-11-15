import { describe, expect, it } from "vitest";
import { InkModel } from "../lib/ink/model";
import {
  eraseStrokeWithTrail,
  mergeIntervals,
  visibleRuns,
  isFullyErased,
} from "../lib/ink/erase";
import {
  easeOutSine,
  hasRealPressure,
  shouldSimulatePressure,
  strokeOptionsFor,
  strokeOutline,
} from "../lib/ink/outline";
import { invertLightness, themedStrokeColor } from "../lib/ink/color";
import { emptyInkDocument, type InkStroke } from "../lib/ink/types";

function penStroke(id: string, points: Array<[number, number]>, size = 4): InkStroke {
  return { id, points, color: "#15130d", size, toolId: "pen" };
}

// ── Stroke → polygon (vendored perfect-freehand) ─────────────────────────────

describe("strokeOutline", () => {
  const points: Array<[number, number]> = [
    [10, 10], [20, 12], [35, 18], [50, 30], [70, 45], [90, 55],
  ];

  it("is deterministic: same input → identical polygon", () => {
    const a = strokeOutline(points, { toolId: "pen", size: 4 }, true);
    const b = strokeOutline(points, { toolId: "pen", size: 4 }, true);
    expect(a.length).toBeGreaterThan(3);
    expect(b).toEqual(a);
  });

  it("produces a closed-loop polygon of finite coordinates", () => {
    const outline = strokeOutline(points, { toolId: "pen", size: 4 }, true);
    for (const [x, y] of outline) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it("size changes the polygon", () => {
    const small = strokeOutline(points, { toolId: "pen", size: 2.5 }, true);
    const big = strokeOutline(points, { toolId: "pen", size: 7 }, true);
    expect(big).not.toEqual(small);
  });
});

// ── Pressure parameter selection (tldraw/Excalidraw production set) ──────────

describe("pressure params by pointerType", () => {
  it("simulates pressure exactly when pointerType is not 'pen'", () => {
    expect(shouldSimulatePressure("mouse")).toBe(true);
    expect(shouldSimulatePressure("touch")).toBe(true);
    expect(shouldSimulatePressure("pen")).toBe(false);
  });

  it("mouse params: thinning .5, streamline/smoothing .62, easeOutSine, simulated", () => {
    const opts = strokeOptionsFor({ toolId: "pen", size: 4, realPressure: false, last: true });
    expect(opts.simulatePressure).toBe(true);
    expect(opts.thinning).toBe(0.5);
    expect(opts.streamline).toBe(0.62);
    expect(opts.smoothing).toBe(0.62);
    expect(opts.size).toBe(4);
    expect(opts.easing).toBe(easeOutSine);
    expect(easeOutSine(0.5)).toBeCloseTo(Math.sin(Math.PI / 4), 10);
  });

  it("pen params: thinning .62, size 1 + size*1.2, real per-point pressure", () => {
    const opts = strokeOptionsFor({ toolId: "pen", size: 4, realPressure: true, last: true });
    expect(opts.simulatePressure).toBe(false);
    expect(opts.thinning).toBe(0.62);
    expect(opts.streamline).toBe(0.62);
    expect(opts.smoothing).toBe(0.62);
    expect(opts.size).toBeCloseTo(1 + 4 * 1.2, 10);
  });

  it("highlighter is a fixed-width band (thinning 0, no simulation)", () => {
    const opts = strokeOptionsFor({ toolId: "highlighter", size: 4, realPressure: false, last: true });
    expect(opts.thinning).toBe(0);
    expect(opts.simulatePressure).toBe(false);
  });

  it("persisted pressure presence is the real-pressure signal", () => {
    expect(hasRealPressure([[1, 2, 0.7], [3, 4, 0.8]])).toBe(true);
    expect(hasRealPressure([[1, 2], [3, 4]])).toBe(false);
    expect(hasRealPressure([])).toBe(false);
  });
});

// ── Erase interval computation ────────────────────────────────────────────────

describe("mergeIntervals", () => {
  it("merges overlapping intervals", () => {
    expect(mergeIntervals([[0, 4], [2, 8]])).toEqual([[0, 8]]);
  });

  it("merges directly adjacent intervals", () => {
    expect(mergeIntervals([[0, 2], [3, 5]])).toEqual([[0, 5]]);
  });

  it("keeps gapped intervals separate and sorts them", () => {
    expect(mergeIntervals([[7, 9], [0, 2]])).toEqual([[0, 2], [7, 9]]);
  });
});

describe("eraseStrokeWithTrail", () => {
  // Horizontal polyline: points at x = 0,10,20,...,90 on y=0.
  const stroke = penStroke("s1", Array.from({ length: 10 }, (_, i) => [i * 10, 0] as [number, number]));

  it("hit: trail crossing the middle kills the touched indices", () => {
    // Vertical trail crossing between x=40 and x=50 → radius 12+2 reaches 40 and 50.
    const next = eraseStrokeWithTrail(stroke, undefined, [[45, -20], [45, 20]], 12);
    expect(next).toEqual([[4, 5]]);
  });

  it("miss: trail far away returns null (no change)", () => {
    expect(eraseStrokeWithTrail(stroke, undefined, [[500, 500], [510, 510]], 12)).toBeNull();
  });

  it("does not tunnel between trail samples (segment hit-testing)", () => {
    // Two samples straddle the stroke vertically — the segment between them
    // crosses it even though neither endpoint is within radius.
    const next = eraseStrokeWithTrail(stroke, undefined, [[45, -200], [45, 200]], 5);
    expect(next).not.toBeNull();
  });

  it("merge-adjacent: a second pass next to an existing interval merges", () => {
    const first = eraseStrokeWithTrail(stroke, undefined, [[45, -20], [45, 20]], 12);
    expect(first).toEqual([[4, 5]]);
    const second = eraseStrokeWithTrail(stroke, first!, [[65, -20], [65, 20]], 12);
    // [4,5] + [6,7] are adjacent → one interval.
    expect(second).toEqual([[4, 7]]);
  });

  it("re-erasing already-dead segments reports no change", () => {
    const first = eraseStrokeWithTrail(stroke, undefined, [[45, -20], [45, 20]], 12);
    const again = eraseStrokeWithTrail(stroke, first!, [[45, -20], [45, 20]], 12);
    expect(again).toBeNull();
  });
});

describe("visibleRuns", () => {
  it("full stroke when nothing is erased", () => {
    expect(visibleRuns(5, undefined)).toEqual([[0, 4]]);
    expect(visibleRuns(5, [])).toEqual([[0, 4]]);
  });

  it("splits around a middle interval", () => {
    expect(visibleRuns(10, [[3, 5]])).toEqual([[0, 2], [6, 9]]);
  });

  it("clips intervals at the edges", () => {
    expect(visibleRuns(10, [[0, 2], [8, 9]])).toEqual([[3, 7]]);
  });

  it("fully erased stroke has no runs", () => {
    expect(visibleRuns(4, [[0, 3]])).toEqual([]);
    expect(isFullyErased(4, [[0, 3]])).toBe(true);
    expect(isFullyErased(4, [[1, 3]])).toBe(false);
  });
});

// ── Undo / redo ───────────────────────────────────────────────────────────────

describe("InkModel undo/redo", () => {
  it("add → undo removes, redo restores (round-trip)", () => {
    const m = new InkModel();
    const s = penStroke("a", [[0, 0], [10, 10]]);
    m.addStroke(s);
    expect(m.strokes).toHaveLength(1);
    expect(m.canUndo()).toBe(true);

    m.undo();
    expect(m.strokes).toHaveLength(0);
    expect(m.canRedo()).toBe(true);

    m.redo();
    expect(m.strokes).toHaveLength(1);
    expect(m.strokes[0].id).toBe("a");
  });

  it("erase → undo restores prior intervals, redo reapplies", () => {
    const m = new InkModel();
    m.addStroke(penStroke("a", Array.from({ length: 10 }, (_, i) => [i, 0] as [number, number])));
    m.applyErase({ a: [[2, 4]] });
    expect(m.erased.a).toEqual([[2, 4]]);

    m.applyErase({ a: [[2, 4], [5, 7]] }); // second drag, adjacent → merged
    expect(m.erased.a).toEqual([[2, 7]]);

    m.undo();
    expect(m.erased.a).toEqual([[2, 4]]);
    m.undo();
    expect(m.erased.a ?? []).toEqual([]);
    m.redo();
    expect(m.erased.a).toEqual([[2, 4]]);
    m.redo();
    expect(m.erased.a).toEqual([[2, 7]]);
  });

  it("new op clears the redo stack", () => {
    const m = new InkModel();
    m.addStroke(penStroke("a", [[0, 0], [1, 1]]));
    m.undo();
    m.addStroke(penStroke("b", [[2, 2], [3, 3]]));
    expect(m.canRedo()).toBe(false);
    expect(m.strokes.map((s) => s.id)).toEqual(["b"]);
  });

  it("strokes stay immutable: erase never touches points", () => {
    const m = new InkModel();
    const pts: Array<[number, number]> = [[0, 0], [10, 0], [20, 0]];
    m.addStroke(penStroke("a", pts));
    m.applyErase({ a: [[1, 1]] });
    expect(m.strokes[0].points).toHaveLength(3);
  });
});

// ── Serialize / load round-trip ───────────────────────────────────────────────

describe("InkModel serialize/load", () => {
  it("round-trips strokes, erased intervals, and page", () => {
    const m = new InkModel();
    m.addStroke({ id: "p1", points: [[1, 2, 0.6], [3, 4, 0.8]], color: "#7a2e33", size: 2.5, toolId: "pen" });
    m.addStroke({ id: "h1", points: [[5, 6], [7, 8]], color: "#c2871d", size: 7, toolId: "highlighter" });
    m.applyErase({ p1: [[0, 0]] });

    const doc = m.serialize();
    expect(doc.version).toBe(1);
    expect(doc.page.width).toBe(1000);

    const m2 = new InkModel();
    m2.load(JSON.parse(JSON.stringify(doc)));
    expect(m2.serialize()).toEqual(doc);
    // Loaded docs start with a clean history (cross-session undo = event restore).
    expect(m2.canUndo()).toBe(false);
  });

  it("serialize deep-copies (later mutations don't leak into the snapshot)", () => {
    const m = new InkModel();
    m.addStroke(penStroke("a", [[0, 0], [1, 1]]));
    const doc = m.serialize();
    m.applyErase({ a: [[0, 0]] });
    expect(doc.erased.a).toBeUndefined();
  });

  it("load tolerates null/garbage by falling back to an empty doc", () => {
    const m = new InkModel();
    m.load(null);
    expect(m.serialize()).toEqual(emptyInkDocument());
    m.load({} as never);
    expect(m.serialize()).toEqual(emptyInkDocument());
  });

  it("contentHeight grows with ink, never below the minimum", () => {
    const m = new InkModel();
    expect(m.contentHeight(1400, 200)).toBe(1400);
    m.addStroke(penStroke("a", [[10, 2000], [20, 2050]]));
    expect(m.contentHeight(1400, 200)).toBe(2250);
  });
});

// ── Dark-mode HSL lightness inversion (Saber model) ──────────────────────────

describe("invertLightness", () => {
  it("inverts L only: black ↔ white", () => {
    expect(invertLightness("#000000")).toBe("#ffffff");
    expect(invertLightness("#ffffff")).toBe("#000000");
  });

  it("near-black warm ink becomes near-white, hue preserved", () => {
    const out = invertLightness("#15130d"); // Gallery heading ink, L≈0.07
    const [r, g, b] = [out.slice(1, 3), out.slice(3, 5), out.slice(5, 7)].map((h) => parseInt(h, 16));
    expect((r + g + b) / 3).toBeGreaterThan(220); // light now
    expect(r).toBeGreaterThanOrEqual(b); // warm hue survives (red ≥ blue)
  });

  it("mid-lightness colors barely move (hue/sat preserved)", () => {
    // Pure-ish red at L=0.5 inverts onto itself.
    expect(invertLightness("#ff0000").toLowerCase()).toBe("#ff0000");
  });

  it("is its own inverse (round-trip)", () => {
    for (const c of ["#7a2e33", "#315f8f", "#c2871d"]) {
      const there = invertLightness(c);
      const back = invertLightness(there);
      // Allow ±1 per channel for rounding.
      const [r1, g1, b1] = [c.slice(1, 3), c.slice(3, 5), c.slice(5, 7)].map((h) => parseInt(h, 16));
      const [r2, g2, b2] = [back.slice(1, 3), back.slice(3, 5), back.slice(5, 7)].map((h) => parseInt(h, 16));
      expect(Math.abs(r1 - r2)).toBeLessThanOrEqual(2);
      expect(Math.abs(g1 - g2)).toBeLessThanOrEqual(2);
      expect(Math.abs(b1 - b2)).toBeLessThanOrEqual(2);
    }
  });

  it("non-hex input passes through unchanged", () => {
    expect(invertLightness("not-a-color")).toBe("not-a-color");
  });

  it("themedStrokeColor: canonical in light, inverted in dark", () => {
    expect(themedStrokeColor("#15130d", false)).toBe("#15130d");
    expect(themedStrokeColor("#15130d", true)).toBe(invertLightness("#15130d"));
  });
});
