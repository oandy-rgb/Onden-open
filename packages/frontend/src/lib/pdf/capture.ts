// Capture-time math: browser measurements → stored PdfHighlightRecord.
// Pure module (no DOM types beyond duck-typed rects, no pdfjs) — every
// function here is the unit-testable half of an interaction in PdfNodeView.
//
// ORIGIN CONTRACT (same as the retired highlighter lib, so legacy records
// keep aligning): page-local px are measured against the page div's
// getBoundingClientRect() — and because the viewer is created with
// removePageBorders, the page's border box, the canvas origin and the
// overlay-layer origin all coincide.

import { INK_SHAPE_MIN_SIDE, inkShapeIsDrawable, type InkShapeFill } from "@onden/markdown/ink";
import {
  boundingRectOf,
  viewportToScaled,
  type LTWH,
  type LTWHP,
  type PageViewportLike,
  type PdfDrawingStroke,
  type PdfHighlightRecord,
  type PdfShapeData,
  type PdfShapeType,
  type ScaledPosition,
} from "./coords";

/** Duck-typed DOMRect (client coordinates). */
export interface ClientRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PageRef {
  number: number;
  rect: ClientRectLike;
}

/** Map selection client rects onto pages: keep only rects fully inside a
 *  page (and meaningfully smaller than it — a rect spanning the whole page
 *  is the text-layer container, not a text line), rebased to page-local px. */
export function clientRectsToPageRects(
  rects: ClientRectLike[],
  pages: PageRef[],
): LTWHP[] {
  const out: LTWHP[] = [];
  for (const r of rects) {
    if (r.width <= 0 || r.height <= 0) continue;
    for (const page of pages) {
      const p = page.rect;
      const inside =
        r.left >= p.left &&
        r.top >= p.top &&
        r.left + r.width <= p.left + p.width &&
        r.top + r.height <= p.top + p.height;
      if (!inside || r.width >= p.width || r.height >= p.height) continue;
      out.push({
        left: r.left - p.left,
        top: r.top - p.top,
        width: r.width,
        height: r.height,
        pageNumber: page.number,
      });
      break;
    }
  }
  return out;
}

const LINE_Y_MARGIN = 5; // same-line tolerance, px
const LINE_X_GAP = 10; // merge rects this close on one line

function sameLine(a: LTWHP, b: LTWHP): boolean {
  return (
    a.pageNumber === b.pageNumber &&
    Math.abs(a.top - b.top) < LINE_Y_MARGIN &&
    Math.abs(a.height - b.height) < LINE_Y_MARGIN
  );
}

/** Browsers report one client rect per text span — a selected line in the
 *  pdfjs text layer arrives as dozens of overlapping fragments. Collapse
 *  them: drop rects contained in others, then merge same-line neighbours. */
export function mergeLineRects(rects: LTWHP[]): LTWHP[] {
  // Dedupe + drop contained rects (containment non-strict so duplicates
  // collapse; index tiebreak keeps exactly one of an identical pair).
  const contained = (a: LTWHP, b: LTWHP) =>
    a.pageNumber === b.pageNumber &&
    a.left >= b.left &&
    a.top >= b.top &&
    a.left + a.width <= b.left + b.width &&
    a.top + a.height <= b.top + b.height;
  const kept = rects.filter((r, i) =>
    !rects.some((o, j) => {
      if (i === j || !contained(r, o)) return false;
      // mutual containment == identical: keep the first occurrence only
      return contained(o, r) ? j < i : true;
    }),
  );
  const sorted = [...kept].sort((a, b) =>
    a.pageNumber - b.pageNumber || a.top - b.top || a.left - b.left,
  );
  const out: LTWHP[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    if (
      prev &&
      sameLine(prev, r) &&
      r.left <= prev.left + prev.width + LINE_X_GAP
    ) {
      const right = Math.max(prev.left + prev.width, r.left + r.width);
      const bottom = Math.max(prev.top + prev.height, r.top + r.height);
      prev.width = right - prev.left;
      prev.top = Math.min(prev.top, r.top);
      prev.height = bottom - prev.top;
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

/** Text selection → stored position. Clamped to the FIRST page the
 *  selection touches: cross-page selections were already broken in the old
 *  pipeline (all rects scaled by page 1's viewport), so rather than persist
 *  garbage we keep the well-defined part. */
export function textSelectionPosition(
  pageRects: LTWHP[],
  viewport: PageViewportLike,
): ScaledPosition | null {
  if (pageRects.length === 0) return null;
  const page = pageRects[0].pageNumber;
  const rects = pageRects.filter((r) => r.pageNumber === page);
  return {
    boundingRect: viewportToScaled(boundingRectOf(rects), viewport),
    rects: rects.map((r) => viewportToScaled(r, viewport)),
  };
}

/** Padding around a drawing's stroke bbox so round line caps aren't clipped.
 *  Same rule the old capture used (maxStrokeWidth × 2) — legacy frames and
 *  new frames stay in one geometry family. */
export function drawingFramePadding(strokes: PdfDrawingStroke[]): number {
  return Math.max(...strokes.map((s) => s.width)) * 2;
}

/** Freehand gesture group (page-local px at capture zoom) → stored record:
 *  points become frame-local (rebased to the padded bbox min corner), the
 *  frame rides in content, the padded bbox in position. */
export function drawingRecord(
  id: string,
  pageNumber: number,
  strokes: PdfDrawingStroke[],
  viewport: PageViewportLike,
): PdfHighlightRecord | null {
  const pts = strokes.flatMap((s) => s.points);
  if (pts.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const pad = drawingFramePadding(strokes);
  // Clamp at the page edge like the old capture did — the frame may be
  // asymmetric near the top-left corner, which is exactly why points are
  // stored frame-local instead of "bbox-local plus a known pad".
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX += pad;
  maxY += pad;
  const frame = { w: maxX - minX, h: maxY - minY };
  const local = strokes.map((s) => ({
    ...s,
    points: s.points.map((p) => ({ ...p, x: p.x - minX, y: p.y - minY })),
  }));
  const boundingRect: LTWHP = {
    left: minX,
    top: minY,
    width: frame.w,
    height: frame.h,
    pageNumber,
  };
  return {
    id,
    type: "drawing",
    content: { strokes: local, frame },
    position: { boundingRect: viewportToScaled(boundingRect, viewport), rects: [] },
  };
}

/** A bounding box side grown (about its middle) to at least `min`. */
function atLeast(origin: number, size: number, min: number): [number, number] {
  return size >= min ? [origin, size] : [origin - (min - size) / 2, min];
}

/** Shape drag (page-local px) → stored record. A drag too small to be a shape
 *  (inkShapeIsDrawable) is none. Lines and arrows remember their endpoints as
 *  bbox fractions so direction survives the bbox; a horizontal or vertical
 *  one gets a bbox thick enough to hold it. */
export function shapeRecord(
  id: string,
  pageNumber: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
  shape: { shapeType: PdfShapeType; strokeColor: string; strokeWidth: number; fill?: InkShapeFill },
  viewport: PageViewportLike,
): PdfHighlightRecord | null {
  if (!inkShapeIsDrawable(shape.shapeType, [start.x, start.y], [end.x, end.y])) return null;
  const directed = shape.shapeType === "line" || shape.shapeType === "arrow";
  const [minX, width] = atLeast(Math.min(start.x, end.x), Math.abs(end.x - start.x), directed ? INK_SHAPE_MIN_SIDE : 0);
  const [minY, height] = atLeast(Math.min(start.y, end.y), Math.abs(end.y - start.y), directed ? INK_SHAPE_MIN_SIDE : 0);
  const data: PdfShapeData = { ...shape };
  if (directed) {
    data.startPoint = { x: (start.x - minX) / width, y: (start.y - minY) / height };
    data.endPoint = { x: (end.x - minX) / width, y: (end.y - minY) / height };
  }
  const boundingRect: LTWHP = { left: minX, top: minY, width, height, pageNumber };
  return {
    id,
    type: "shape",
    content: { shape: data },
    position: { boundingRect: viewportToScaled(boundingRect, viewport), rects: [] },
  };
}

const MIN_AREA_SIZE = 8; // px — an alt-click or a twitch shouldn't mint an annotation

/** Alt+drag area selection (page-local px) → stored record. No screenshot:
 *  the old pipeline stored a PNG dataUrl nothing ever read — the rendered
 *  highlight is a translucent box either way. */
export function areaRecord(
  id: string,
  pageNumber: number,
  rect: LTWH,
  viewport: PageViewportLike,
): PdfHighlightRecord | null {
  if (rect.width < MIN_AREA_SIZE || rect.height < MIN_AREA_SIZE) return null;
  const boundingRect: LTWHP = { ...rect, pageNumber };
  return {
    id,
    type: "area",
    content: {},
    position: { boundingRect: viewportToScaled(boundingRect, viewport), rects: [] },
  };
}
