// A stored shape (InkShape) as the stroke renderers draw it: its outline
// polylines become strokes of the engine-internal "shape" tool (exact width, no
// smoothing — @onden/markdown strokeOptionsFor), so the Canvas2D and SVG
// committed renderers need no shape code of their own. Shapes are immutable, so
// the strokes are made once per shape object.

import { SHAPE_FILL_TOOL_ID, SHAPE_TOOL_ID, inkShapeFillPolygon, inkShapePolylines } from "@onden/markdown/ink";
import type { InkPoint, InkShape, InkStroke } from "./types";

const SAMPLE_STEP = 6; // doc units between points along a long edge

const cache = new WeakMap<InkShape, InkStroke[]>();

/** The line width (doc units) a pen of toolbar size `size` draws at — what a
 *  shape made with that size (or from a stroke of it) is stored with, so a
 *  shape and a stroke of the same size look equally thick. */
export const shapeWidthFor = (size: number): number => 1 + size * 1.2;

/** A stored shape this version can try to draw: a record, not a hand-edit's null. */
const isShape = (shape: unknown): shape is InkShape => !!shape && typeof shape === "object";

function densify(line: Array<[number, number]>): InkPoint[] {
  const out: InkPoint[] = [[line[0]![0], line[0]![1]]];
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1]!;
    const [bx, by] = line[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / SAMPLE_STEP));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/** The strokes that draw `shape` (none for a kind this version cannot draw). */
export function shapeStrokes(shape: InkShape): InkStroke[] {
  if (!isShape(shape)) return [];
  const cached = cache.get(shape);
  if (cached) return cached;
  const lines = inkShapePolylines(shape) ?? [];
  const size = Number.isFinite(shape.size) && shape.size > 0 ? shape.size : 4;
  const strokes = lines.map((line, i): InkStroke => ({
    id: `${shape.id}:${i}`,
    points: densify(line),
    color: shape.color,
    size,
    toolId: SHAPE_TOOL_ID,
  }));
  // The inside goes first, so the outline is drawn over it.
  const inside = inkShapeFillPolygon(shape);
  if (inside) strokes.unshift({ id: `${shape.id}:fill`, points: inside.map(([x, y]): InkPoint => [x, y]), color: shape.color, size, toolId: SHAPE_FILL_TOOL_ID });
  cache.set(shape, strokes);
  return strokes;
}

function distanceToSegment(px: number, py: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function pointInPolygon(px: number, py: number, polygon: ReadonlyArray<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!, [xj, yj] = polygon[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether a point is within `radius` of the shape's outline (the eraser). */
export function shapeTouches(shape: InkShape, x: number, y: number, radius: number): boolean {
  if (!isShape(shape)) return false;
  const lines = inkShapePolylines(shape);
  if (!lines) return false;
  const reach = radius + (Number.isFinite(shape.size) ? shape.size / 2 : 2);
  if (lines.some((line) => line.some((p, i) => i > 0 && distanceToSegment(x, y, line[i - 1]!, p) <= reach))) return true;
  // A filled shape is also erased by touching its inside.
  const inside = inkShapeFillPolygon(shape);
  return inside !== null && pointInPolygon(x, y, inside);
}

/** The lowest point of the shape (page growth and content height). */
export function shapeMaxY(shape: InkShape): number {
  if (!isShape(shape)) return 0;
  const lines = inkShapePolylines(shape);
  return lines ? Math.max(0, ...lines.flat().map((p) => p[1])) : 0;
}
