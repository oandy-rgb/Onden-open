// Canvas2D painting: stroke → outline polygon → Path2D fill.
// Pure geometry lives in outline.ts / erase.ts; this module is the only one
// that touches a 2d context, and every entry point tolerates a null context
// (jsdom) so the engine stays constructible in unit tests.

import { themedStrokeColor } from "./color";
import { visibleRuns } from "./erase";
import { strokeOutline } from "./outline";
import type { EraseInterval, InkStroke } from "./types";
import { INK_SHAPE_FILL_ALPHA, SHAPE_FILL_TOOL_ID, type Vec2 } from "@onden/markdown/ink";

/** Marker opacity — the canvas fill and the PDF page's SVG agree on it. */
export const HIGHLIGHTER_ALPHA = 0.45;

/** How opaque a stroke is filled: the marker and a shape's inside are translucent. */
export function strokeAlpha(stroke: Pick<InkStroke, "toolId">): number {
  if (stroke.toolId === "highlighter") return HIGHLIGHTER_ALPHA;
  return stroke.toolId === SHAPE_FILL_TOOL_ID ? INK_SHAPE_FILL_ALPHA : 1;
}

function outlineToPath(outline: Vec2[]): Path2D {
  const path = new Path2D();
  if (outline.length === 0) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    path.lineTo(outline[i][0], outline[i][1]);
  }
  path.closePath();
  return path;
}

/** A stroke's fill geometry in document coordinates: one closed outline per
 *  surviving run, plus its bounding box. Independent of zoom / pan / theme,
 *  so a committed renderer can cache it and re-fill under any transform. */
export interface StrokeGeometry {
  paths: Path2D[];
  /** [minX, minY, maxX, maxY] in document units (outline included). */
  bbox: [number, number, number, number];
}

export function strokeGeometry(
  stroke: InkStroke,
  erased: EraseInterval[] | undefined,
  wet = false,
): StrokeGeometry {
  const paths: Path2D[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [a, b] of visibleRuns(stroke.points.length, erased)) {
    const pts = stroke.points.slice(a, b + 1);
    const isTail = wet && b === stroke.points.length - 1;
    const outline = strokeOutline(pts, stroke, !isTail);
    if (outline.length < 3) continue;
    for (const [x, y] of outline) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    paths.push(outlineToPath(outline));
  }
  return { paths, bbox: [minX, minY, maxX, maxY] };
}

/** Fill precomputed geometry with the stroke's (themed) colour. */
export function fillStrokeGeometry(
  ctx: CanvasRenderingContext2D,
  stroke: InkStroke,
  geometry: StrokeGeometry,
  dark: boolean,
): void {
  if (geometry.paths.length === 0) return;
  ctx.save();
  ctx.fillStyle = themedStrokeColor(stroke.color, dark);
  ctx.globalAlpha = strokeAlpha(stroke);
  for (const path of geometry.paths) ctx.fill(path);
  ctx.restore();
}

/** Paint one stroke (or its surviving sub-runs after erasure). `wet` keeps
 *  the live tail of a wet stroke from rounding off prematurely. */
export function paintStroke(
  ctx: CanvasRenderingContext2D,
  stroke: InkStroke,
  erased: EraseInterval[] | undefined,
  opts: { dark: boolean; wet?: boolean },
): void {
  fillStrokeGeometry(ctx, stroke, strokeGeometry(stroke, erased, opts.wet === true), opts.dark);
}

export interface PaintSceneOptions {
  dark: boolean;
  /** doc → device-pixel scale (already includes devicePixelRatio). */
  scale: number;
  /** Device-pixel translation of the doc origin (pan), default 0 — used by
   *  hosts whose camera pans (React Flow canvas wet surface). */
  offsetX?: number;
  offsetY?: number;
}

/** Repaint the wet-ink canvas with just what is being drawn now: the
 *  in-progress stroke, or the strokes of a shape preview. `halo` draws a soft
 *  wide glow under them (a stroke that just snapped to a shape). */
export function paintWet(
  canvas: HTMLCanvasElement,
  live: InkStroke | InkStroke[] | null,
  { dark, scale, offsetX = 0, offsetY = 0, halo = false }: PaintSceneOptions & { halo?: boolean },
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const strokes = Array.isArray(live) ? live : live ? [live] : [];
  if (strokes.every((stroke) => stroke.points.length === 0)) return;
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
  // The halo is the stroke as a marker band: translucent and about twice as wide.
  if (halo) for (const stroke of strokes) paintStroke(ctx, { ...stroke, toolId: "highlighter", size: stroke.size * 0.9 }, undefined, { dark, wet: true });
  for (const stroke of strokes) paintStroke(ctx, stroke, undefined, { dark, wet: true });
}
