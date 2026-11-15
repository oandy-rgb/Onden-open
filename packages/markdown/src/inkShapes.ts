// The geometry of a stored shape (InkShape): every kind as polylines in the
// shape's own coordinates. One source for each place that draws a shape — the
// ink engine's canvases, the PDF page overlay, the static SVG (review cards,
// embeds, the published site) — so a shape looks the same wherever it shows.
//
// Pure and DOM-free. A kind this version does not know has no geometry (null):
// the renderers skip it and the format keeps it as stored (inkFormat.ts).

import type { InkShape } from "./inkFormat.js";

export type ShapePoint = [number, number];
/** An open or closed outline; a closed one repeats its first point at the end. */
export type ShapePolyline = ShapePoint[];

const ELLIPSE_STEPS = 64;
const CORNER_STEPS = 8;

/** The shape's polylines (stroke centre lines), or null for a kind that is
 *  unknown or has unusable geometry. `size` is only used to scale an arrowhead. */
export function inkShapePolylines(shape: Pick<InkShape, "kind" | "start" | "end" | "size">): ShapePolyline[] | null {
  const { start, end } = shape;
  if (!isPair(start) || !isPair(end)) return null;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const left = Math.min(x1, x2), right = Math.max(x1, x2);
  const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
  const w = right - left, h = bottom - top;
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const closed = (pts: ShapePoint[]): ShapePolyline => [...pts, pts[0]!];
  switch (shape.kind) {
    case "line":
      return [[[x1, y1], [x2, y2]]];
    case "arrow": {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const size = Number.isFinite(shape.size) && shape.size > 0 ? shape.size : 4;
      const head = Math.min(len / 2, Math.max(10, size * 4));
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const barb = (da: number): ShapePoint => [x2 - head * Math.cos(angle + da), y2 - head * Math.sin(angle + da)];
      return [[[x1, y1], [x2, y2]], [barb(Math.PI / 7), [x2, y2], barb(-Math.PI / 7)]];
    }
    case "rectangle":
      return [closed([[left, top], [right, top], [right, bottom], [left, bottom]])];
    case "roundedRectangle": {
      const r = Math.min(w, h) * 0.25;
      const pts: ShapePoint[] = [];
      const corner = (ox: number, oy: number, from: number) => {
        for (let i = 0; i <= CORNER_STEPS; i++) {
          const a = from + (Math.PI / 2) * (i / CORNER_STEPS);
          pts.push([ox + r * Math.cos(a), oy + r * Math.sin(a)]);
        }
      };
      corner(right - r, top + r, -Math.PI / 2);
      corner(right - r, bottom - r, 0);
      corner(left + r, bottom - r, Math.PI / 2);
      corner(left + r, top + r, Math.PI);
      return [closed(pts)];
    }
    case "ellipse":
    case "circle": {
      const pts: ShapePoint[] = [];
      for (let i = 0; i < ELLIPSE_STEPS; i++) {
        const a = (2 * Math.PI * i) / ELLIPSE_STEPS;
        pts.push([cx + (w / 2) * Math.cos(a), cy + (h / 2) * Math.sin(a)]);
      }
      return [closed(pts)];
    }
    case "triangle":
      return [closed([[cx, top], [right, bottom], [left, bottom]])];
    case "diamond":
      return [closed([[cx, top], [right, cy], [cx, bottom], [left, cy]])];
    case "star": {
      const pts: ShapePoint[] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (Math.PI * i) / 5;
        const k = i % 2 === 0 ? 1 : 0.4;
        pts.push([cx + (w / 2) * k * Math.cos(a), cy + (h / 2) * k * Math.sin(a)]);
      }
      return [closed(pts)];
    }
    default:
      return null;
  }
}

/** The polylines as one SVG path `d` (fixed-precision numbers only), or "". */
export function inkShapePathD(shape: Pick<InkShape, "kind" | "start" | "end" | "size">): string {
  const lines = inkShapePolylines(shape);
  if (!lines) return "";
  return lines
    .map((line) => line.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" "))
    .join(" ");
}

/** Opacity of a filled shape's inside: the outline stays at full strength on
 *  top, so a fill is a tint, never a block that hides what is under it. One
 *  value for the canvases, the PDF overlay and the static SVG. */
export const INK_SHAPE_FILL_ALPHA = 0.25;

/** Whether a shape's inside is drawn: it asks for a solid fill and the kind
 *  has an inside (a line or arrow does not). */
export function inkShapeIsFilled(shape: Pick<InkShape, "kind" | "fill">): boolean {
  return shape.fill === "solid" && shape.kind !== "line" && shape.kind !== "arrow";
}

/** The inside of a filled shape as one closed polygon (the shape's own outline
 *  line), or null when it has none or is not filled. */
export function inkShapeFillPolygon(shape: Pick<InkShape, "kind" | "start" | "end" | "size" | "fill">): ShapePoint[] | null {
  if (!inkShapeIsFilled(shape)) return null;
  const lines = inkShapePolylines(shape);
  const outline = lines?.[0];
  return outline && outline.length >= 4 ? outline : null;
}

function isPair(v: unknown): v is ShapePoint {
  return Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);
}

/** Smallest a shape may be: each side of a box kind, the length of a line or
 *  arrow (document units). A drag below it is a tap, not a shape. */
export const INK_SHAPE_MIN_SIDE = 10;

/** Whether a drag from `start` to `end` is big enough to keep as this kind. */
export function inkShapeIsDrawable(kind: string, start: ShapePoint, end: ShapePoint): boolean {
  const w = Math.abs(end[0] - start[0]), h = Math.abs(end[1] - start[1]);
  return kind === "line" || kind === "arrow"
    ? Math.hypot(w, h) >= INK_SHAPE_MIN_SIDE
    : w >= INK_SHAPE_MIN_SIDE && h >= INK_SHAPE_MIN_SIDE;
}

const ARC_STEP = Math.PI / 10;

/** The filled outline of a polyline drawn `width` wide with round joins and
 *  round ends, as one polygon (fill it with the non-zero rule). A shape's
 *  corners stay square-edged and its closing point stays closed, which the
 *  freehand outline (made for a moving pen) does not do. */
export function polylineOutline(points: ReadonlyArray<ShapePoint>, width: number): ShapePoint[] {
  const r = Math.max(width, 0.1) / 2;
  const pts: ShapePoint[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) pts.push([p[0], p[1]]);
  }
  const circle = (c: ShapePoint): ShapePoint[] =>
    Array.from({ length: 20 }, (_, i) => [c[0] + r * Math.cos((i * Math.PI) / 10), c[1] + r * Math.sin((i * Math.PI) / 10)] as ShapePoint);
  if (pts.length < 2) return pts.length === 1 ? circle(pts[0]!) : [];

  /** Points on the circle round `c`, from angle `from` sweeping `delta`. */
  const arc = (c: ShapePoint, from: number, delta: number): ShapePoint[] => {
    const n = Math.max(1, Math.ceil(Math.abs(delta) / ARC_STEP));
    return Array.from({ length: n + 1 }, (_, i) => {
      const a = from + (delta * i) / n;
      return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)] as ShapePoint;
    });
  };
  /** One side of the line, walking `chain` and offsetting to its left (the
   *  other side is the same walk over the reversed chain). */
  const side = (chain: ShapePoint[]): ShapePoint[] => {
    const out: ShapePoint[] = [];
    const heading = (a: ShapePoint, b: ShapePoint) => Math.atan2(b[1] - a[1], b[0] - a[0]);
    const off = (p: ShapePoint, h: number): ShapePoint => [p[0] + r * Math.sin(h), p[1] - r * Math.cos(h)];
    for (let i = 0; i < chain.length - 1; i++) {
      const h = heading(chain[i]!, chain[i + 1]!);
      if (i === 0) out.push(off(chain[0]!, h));
      if (i > 0) {
        const prev = heading(chain[i - 1]!, chain[i]!);
        let turn = h - prev;
        while (turn > Math.PI) turn -= 2 * Math.PI;
        while (turn < -Math.PI) turn += 2 * Math.PI;
        // Straight back the way it came: neither side is the outside, and -π would cross through
        // the vertex on both walks, leaving the tip uncapped. Round it, as an end is.
        if (Math.PI - Math.abs(turn) < 1e-9) turn = Math.PI;
        const vertex = chain[i]!;
        if (turn > 0) {
          // Turning away from this side: round the outside of the corner.
          out.push(...arc(vertex, prev - Math.PI / 2, turn));
        } else {
          // Turning toward it: cross through the vertex so the fill stays whole.
          out.push(off(vertex, prev), vertex, off(vertex, h));
        }
      }
      out.push(off(chain[i + 1]!, h));
    }
    return out;
  };
  const forward = side(pts);
  const back = side([...pts].reverse());
  const end = pts[pts.length - 1]!;
  const start = pts[0]!;
  const endHeading = Math.atan2(end[1] - pts[pts.length - 2]![1], end[0] - pts[pts.length - 2]![0]);
  const startHeading = Math.atan2(pts[0]![1] - pts[1]![1], pts[0]![0] - pts[1]![0]);
  return [
    ...forward,
    ...arc(end, endHeading - Math.PI / 2, Math.PI),
    ...back,
    ...arc(start, startHeading - Math.PI / 2, Math.PI),
  ];
}
