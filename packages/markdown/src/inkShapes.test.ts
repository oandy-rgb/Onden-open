import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { INK_SHAPE_KINDS, decodeInk, inkShapeFillPolygon, inkShapeIsFilled, inkShapePathD, inkShapePolylines, type InkShape } from "./ink.js";
import { polylineOutline } from "./inkShapes.js";

const shape = (kind: string, start: [number, number], end: [number, number]): InkShape => ({ id: "s", kind, start, end, color: "#000", size: 4 });
const corners = fc.tuple(fc.integer({ min: -500, max: 500 }), fc.integer({ min: -500, max: 500 }), fc.integer({ min: 20, max: 400 }), fc.integer({ min: 20, max: 400 }));

describe("inkShapePolylines", () => {
  it("every kind the shape button offers has geometry, with finite points", () => {
    fc.assert(fc.property(corners, fc.constantFrom(...INK_SHAPE_KINDS), ([x, y, w, h], kind) => {
      const lines = inkShapePolylines(shape(kind, [x, y], [x + w, y + h]));
      expect(lines).not.toBeNull();
      for (const line of lines!) for (const p of line) expect(p.every(Number.isFinite)).toBe(true);
    }));
  });

  it("closed kinds end where they start; lines and arrows are open", () => {
    for (const kind of INK_SHAPE_KINDS) {
      const [first] = inkShapePolylines(shape(kind, [0, 0], [100, 60]))!;
      const closed = first![0]!.join() === first![first!.length - 1]!.join();
      expect(closed, kind).toBe(kind !== "line" && kind !== "arrow");
    }
  });

  it("box kinds stay inside the dragged corners, whichever corner is dragged first", () => {
    fc.assert(fc.property(corners, fc.constantFrom("rectangle", "roundedRectangle", "ellipse", "triangle", "diamond", "star"), ([x, y, w, h], kind) => {
      for (const [a, b] of [[[x, y], [x + w, y + h]], [[x + w, y + h], [x, y]], [[x + w, y], [x, y + h]]] as Array<[[number, number], [number, number]]>) {
        for (const line of inkShapePolylines(shape(kind, a, b))!) for (const [px, py] of line) {
          expect(px).toBeGreaterThanOrEqual(x - 1e-6);
          expect(px).toBeLessThanOrEqual(x + w + 1e-6);
          expect(py).toBeGreaterThanOrEqual(y - 1e-6);
          expect(py).toBeLessThanOrEqual(y + h + 1e-6);
        }
      }
    }));
  });

  it("the older name 'circle' draws the same as 'ellipse'", () => {
    expect(inkShapePathD(shape("circle", [0, 0], [50, 30]))).toBe(inkShapePathD(shape("ellipse", [0, 0], [50, 30])));
  });

  it("an unknown kind has no geometry, and is kept by the codec", () => {
    expect(inkShapePolylines(shape("spiral", [0, 0], [5, 5]))).toBeNull();
    expect(inkShapePathD(shape("spiral", [0, 0], [5, 5]))).toBe("");
    const raw = JSON.stringify({ version: 1, strokes: [], erased: {}, page: { width: 1000 }, shapes: [shape("spiral", [0, 0], [5, 5])] });
    const decoded = decodeInk(raw);
    expect(decoded.kind === "page" && decoded.doc.shapes?.[0]?.kind).toBe("spiral");
  });
});

describe("polylineOutline (a shape's filled line)", () => {
  type P = [number, number];
  const windingNumber = (p: P, poly: P[]): number => {
    let w = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      const cross = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
      if (a[1] <= p[1]) { if (b[1] > p[1] && cross > 0) w++; }
      else if (b[1] <= p[1] && cross < 0) w--;
    }
    return w;
  };
  const distToPolyline = (p: P, line: P[]): number => {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1]!, [bx, by] = line[i]!;
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / len2));
      best = Math.min(best, Math.hypot(p[0] - (ax + t * (bx - ax)), p[1] - (ay + t * (by - ay))));
    }
    return best;
  };
  const line = fc.array(fc.tuple(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 200 })), { minLength: 2, maxLength: 8 });

  it("covers what is within the line's width and nothing beyond it, at any corner or end", () => {
    fc.assert(fc.property(line, fc.integer({ min: 2, max: 20 }), fc.array(fc.tuple(fc.integer({ min: -30, max: 230 }), fc.integer({ min: -30, max: 230 })), { minLength: 20, maxLength: 20 }), (pts, width, probes) => {
      fc.pre(pts.some((p, i) => i > 0 && (p[0] !== pts[i - 1]![0] || p[1] !== pts[i - 1]![1])));
      const poly = polylineOutline(pts as P[], width);
      for (const probe of probes) {
        const d = distToPolyline(probe as P, pts as P[]);
        if (d < width / 2 - 0.6) expect(windingNumber(probe as P, poly), `inside at ${d}`).not.toBe(0);
        if (d > width / 2 + 0.6) expect(windingNumber(probe as P, poly), `outside at ${d}`).toBe(0);
      }
    }), { numRuns: 150 });
  });

  // Found by the property above (seed 1892924566): the turn is exactly -π on both walks.
  it("a line that turns straight back on itself is rounded at the tip, whichever way it points", () => {
    for (const tip of [[99, 160], [-99, -160], [99, -160], [-99, 160], [50, 0], [-50, 0], [0, 50], [0, -50]] as P[]) {
      const line: P[] = [[0, 0], tip, [0, 0], [-7, 3]];
      const len = Math.hypot(tip[0], tip[1]);
      const beyond: P = [tip[0] + (2 * tip[0]) / len, tip[1] + (2 * tip[1]) / len];
      expect(windingNumber(beyond, polylineOutline(line, 6)), `tip ${tip.join(",")}`).not.toBe(0);
    }
  });

  it("a closed outline (a rectangle) has square-edged corners: the corner pixel just inside the stroke is filled", () => {
    const box: P[] = [[0, 0], [100, 0], [100, 60], [0, 60], [0, 0]];
    const poly = polylineOutline(box, 8);
    expect(windingNumber([100.2, 0.2], poly)).not.toBe(0);
    expect(windingNumber([50, 50], poly)).toBe(0); // the middle stays empty
  });

  it("a single point is a dot; nothing is nothing", () => {
    expect(windingNumber([0, 0], polylineOutline([[0, 0], [0, 0]], 6))).not.toBe(0);
    expect(polylineOutline([], 6)).toEqual([]);
  });
});

describe("shape fill", () => {
  const filled = (kind: string): InkShape => ({ ...shape(kind, [10, 20], [110, 90]), fill: "solid" });

  it("an old shape without the field, and an unknown value, are not filled", () => {
    expect(inkShapeIsFilled(shape("rectangle", [0, 0], [50, 50]))).toBe(false);
    expect(inkShapeIsFilled({ ...shape("rectangle", [0, 0], [50, 50]), fill: "none" })).toBe(false);
    expect(inkShapeIsFilled({ ...shape("rectangle", [0, 0], [50, 50]), fill: "hatched" })).toBe(false);
    expect(inkShapeFillPolygon(shape("rectangle", [0, 0], [50, 50]))).toBeNull();
  });

  it("every closed kind has an inside to fill; a line or arrow has none", () => {
    for (const kind of INK_SHAPE_KINDS) {
      const polygon = inkShapeFillPolygon(filled(kind));
      if (kind === "line" || kind === "arrow") expect(polygon, kind).toBeNull();
      else {
        expect(polygon, kind).not.toBeNull();
        expect(polygon![0], kind).toEqual(polygon![polygon!.length - 1]); // closed
      }
    }
    expect(inkShapeFillPolygon({ ...shape("spiral", [0, 0], [50, 50]), fill: "solid" })).toBeNull(); // a newer app's kind
  });

  it("the fill survives the codec, and a shape without it stays without it", () => {
    const doc = { version: 1 as const, strokes: [], erased: {}, page: { width: 1000 }, shapes: [filled("star"), shape("diamond", [0, 0], [40, 40])] };
    const back = decodeInk(JSON.stringify(doc));
    expect(back.kind === "page" && back.doc.shapes?.map((s) => s.fill)).toEqual(["solid", undefined]);
  });
});
