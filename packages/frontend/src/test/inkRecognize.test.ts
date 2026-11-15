import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { inkShapePolylines } from "@onden/markdown/ink";
import { recognizeShape, type RecognizedKind } from "../lib/ink/recognize";
import type { InkPoint } from "../lib/ink/types";

type Pt = [number, number];

/** A hand-drawn version of a polyline: walked from `phase` (closed ones wrap),
 *  sampled like a pen (uneven steps), with smooth jitter of `wobble` × size. */
function drawn(line: Pt[], opts: { phase: number; reverse: boolean; wobble: number; seed: number; overshoot?: number; closed: boolean }): InkPoint[] {
  const pts = opts.reverse ? [...line].reverse() : line;
  const segs = pts.slice(1).map((p, i) => ({ a: pts[i]!, b: p, len: Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]) }));
  const total = segs.reduce((s, x) => s + x.len, 0);
  const at = (d: number): Pt => {
    let rest = opts.closed ? ((d % total) + total) % total : Math.min(total, Math.max(0, d));
    for (const s of segs) {
      if (rest <= s.len) { const t = s.len ? rest / s.len : 0; return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]; }
      rest -= s.len;
    }
    return segs[segs.length - 1]!.b;
  };
  const xs = line.map((p) => p[0]), ys = line.map((p) => p[1]);
  const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const out: InkPoint[] = [];
  const steps = Math.max(24, Math.round(total / 6));
  const span = opts.closed ? total * (1 + (opts.overshoot ?? 0)) : total;
  const start = opts.closed ? opts.phase * total : 0;
  for (let i = 0; i <= steps; i++) {
    const p = at(start + (span * i) / steps);
    const w = opts.wobble * size;
    out.push([p[0] + w * Math.sin(i * 0.9 + opts.seed), p[1] + w * Math.cos(i * 0.7 + opts.seed * 2)]);
  }
  return out;
}

const box = fc.record({
  x: fc.integer({ min: 0, max: 600 }), y: fc.integer({ min: 0, max: 600 }),
  w: fc.integer({ min: 90, max: 420 }), h: fc.integer({ min: 90, max: 420 }),
});
const hand = fc.record({
  phase: fc.double({ min: 0, max: 1, noNaN: true }), reverse: fc.boolean(),
  wobble: fc.double({ min: 0, max: 0.012, noNaN: true }), seed: fc.double({ min: 0, max: 6, noNaN: true }),
  overshoot: fc.double({ min: 0, max: 0.06, noNaN: true }),
});

const closedShape = (kind: string, b: { x: number; y: number; w: number; h: number }) =>
  inkShapePolylines({ kind: kind as "rectangle", start: [b.x, b.y], end: [b.x + b.w, b.y + b.h], size: 1 })![0]!;

describe("recognizeShape: closed shapes", () => {
  const kinds: Array<[RecognizedKind, string]> = [["rectangle", "rectangle"], ["ellipse", "ellipse"], ["triangle", "triangle"], ["diamond", "diamond"]];
  for (const [kind, template] of kinds) {
    it(`a wobbly ${kind}, from any starting point and direction, is recognised with its box`, () => {
      fc.assert(fc.property(box, hand, (b, h) => {
        const stroke = drawn(closedShape(template, b), { ...h, closed: true });
        const got = recognizeShape(stroke);
        expect(got?.kind).toBe(kind);
        const [x1, y1] = got!.start, [x2, y2] = got!.end;
        const tol = 0.06 * Math.hypot(b.w, b.h) + (kind === "ellipse" ? Math.abs(b.w - b.h) * 0.07 : 0);
        expect(Math.abs(Math.min(x1, x2) - b.x)).toBeLessThanOrEqual(tol);
        expect(Math.abs(Math.min(y1, y2) - b.y)).toBeLessThanOrEqual(tol);
        expect(Math.abs(Math.max(x1, x2) - (b.x + b.w))).toBeLessThanOrEqual(tol);
        expect(Math.abs(Math.max(y1, y2) - (b.y + b.h))).toBeLessThanOrEqual(tol);
      }), { numRuns: 120 });
    });
  }

  it("a near-square ellipse comes back as a circle (equal sides)", () => {
    const b = { x: 100, y: 100, w: 200, h: 214 };
    const got = recognizeShape(drawn(closedShape("ellipse", b), { phase: 0.3, reverse: false, wobble: 0.004, seed: 1, closed: true }))!;
    expect(Math.abs(got.end[0] - got.start[0])).toBeCloseTo(Math.abs(got.end[1] - got.start[1]), 5);
  });
});

describe("recognizeShape: lines and arrows", () => {
  const point = fc.record({ x: fc.integer({ min: 0, max: 800 }), y: fc.integer({ min: 0, max: 800 }) });
  const apart = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) > 120;

  it("a wobbly straight stroke is a line between its ends", () => {
    fc.assert(fc.property(point, point, hand, (a, b, h) => {
      fc.pre(apart(a, b));
      const stroke = drawn([[a.x, a.y], [b.x, b.y]], { ...h, wobble: Math.min(h.wobble, 0.008), closed: false });
      const got = recognizeShape(stroke);
      expect(got?.kind).toBe("line");
      const tol = 0.05 * Math.hypot(a.x - b.x, a.y - b.y) + 12;
      expect(Math.hypot(got!.start[0] - stroke[0]![0], got!.start[1] - stroke[0]![1])).toBeLessThanOrEqual(tol);
    }));
  });

  it("a stroke within 6° of horizontal or vertical is made exactly so", () => {
    const h = recognizeShape(drawn([[100, 100], [400, 112]], { phase: 0, reverse: false, wobble: 0, seed: 0, closed: false }))!;
    expect(h.start[1]).toBe(h.end[1]);
    const v = recognizeShape(drawn([[100, 100], [108, 400]], { phase: 0, reverse: false, wobble: 0, seed: 0, closed: false }))!;
    expect(v.start[0]).toBe(v.end[0]);
  });

  it("a shaft with two barbs at the tip is an arrow pointing at the tip", () => {
    fc.assert(fc.property(point, fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }), fc.integer({ min: 150, max: 450 }), fc.double({ min: 0.18, max: 0.32, noNaN: true }), (a, angle, len, headRatio) => {
      const tip: Pt = [a.x + len * Math.cos(angle), a.y + len * Math.sin(angle)];
      const head = len * headRatio;
      const barb = (da: number): Pt => [tip[0] - head * Math.cos(angle + da), tip[1] - head * Math.sin(angle + da)];
      const path: Pt[] = [[a.x, a.y], tip, barb(0.5), tip, barb(-0.5)];
      const stroke = drawn(path, { phase: 0, reverse: false, wobble: 0.003, seed: 1, closed: false });
      const got = recognizeShape(stroke);
      expect(got?.kind).toBe("arrow");
      const tol = 0.1 * len;
      expect(Math.hypot(got!.start[0] - a.x, got!.start[1] - a.y)).toBeLessThanOrEqual(tol);
    }), { numRuns: 80 });
  });
});

describe("recognizeShape: what must be left alone", () => {
  const stroke = (pts: Pt[]) => drawn(pts, { phase: 0, reverse: false, wobble: 0, seed: 0, closed: false });

  it("a dot or a short tick", () => {
    expect(recognizeShape([[5, 5]])).toBeNull();
    expect(recognizeShape([[5, 5], [6, 6], [7, 6], [8, 8]])).toBeNull();
    expect(recognizeShape(stroke([[0, 0], [30, 8]]))).toBeNull();
  });

  it("a zigzag, an S and a wave", () => {
    expect(recognizeShape(stroke([[0, 0], [80, 80], [0, 160], [80, 240], [0, 320]]))).toBeNull();
    const s: Pt[] = Array.from({ length: 40 }, (_, i) => [60 * Math.sin(i / 3), i * 6]);
    expect(recognizeShape(stroke(s))).toBeNull();
  });

  it("a tilted rectangle, a tilted ellipse and a half circle", () => {
    const rot = (pts: Pt[], deg: number): Pt[] => {
      const r = (deg * Math.PI) / 180;
      return pts.map(([x, y]) => [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)]);
    };
    const rect = closedShape("rectangle", { x: 0, y: 0, w: 320, h: 120 });
    expect(recognizeShape(drawn(rot(rect, 25), { phase: 0, reverse: false, wobble: 0, seed: 0, closed: true }))).toBeNull();
    const ell = closedShape("ellipse", { x: 0, y: 0, w: 340, h: 120 });
    expect(recognizeShape(drawn(rot(ell, 30), { phase: 0, reverse: false, wobble: 0, seed: 0, closed: true }))).toBeNull();
    const half = ell.slice(0, 32);
    expect(recognizeShape(stroke(half))).toBeNull();
  });

  it("any random walk: never throws, and an answer has finite corners", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: -300, max: 300 }), fc.integer({ min: -300, max: 300 })), { maxLength: 80 }), (pts) => {
      const got = recognizeShape(pts as InkPoint[]);
      if (got) expect([...got.start, ...got.end].every(Number.isFinite)).toBe(true);
    }));
  });
});
