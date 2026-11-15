// PDF annotation stored format + scale math. Pure module — NO pdfjs import
// (pdfjs 6 needs DOMMatrix, absent in jsdom, so keeping this pure is what
// makes the rect math unit-testable).
//
// FORMAT LOCK: these types replicate the react-pdf-highlighter-plus
// `Highlight` shape byte-for-byte (the lib is gone — it pinned pdfjs-dist to
// the CVE-bearing 4.x line — but saved PDFs store this shape: the records
// now ride in the ink_data envelope's `annotations` (lib/pdf/pdfAdapter), and
// older PDFs in the legacy `pdf_annotations` attribute, read-only since W20 —
// so the format outlives the dependency and persisted data needs NO migration):
//
//   Scaled        — a rect captured in viewport CSS px at capture-time zoom,
//                   carrying the page viewport (width, height) it was
//                   measured against. Rendering rescales by the ratio
//                   current/stored, so positions are zoom-independent
//                   without ever storing normalized 0..1 coords.
//   ScaledPosition— boundingRect + per-line rects (text highlights).
//   content       — text quote / drawing strokes (capture-frame-local px,
//                   see capture.ts) / shape data, by highlight type.

import type { InkShapeFill, InkShapeKind } from "@onden/markdown/ink";

export interface LTWH {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LTWHP extends LTWH {
  /** 1-indexed page number. */
  pageNumber: number;
}

/** Capture-scale rect + the page viewport size it was measured in. */
export interface Scaled {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
  pageNumber: number;
}

export interface ScaledPosition {
  boundingRect: Scaled;
  /** Per-line rects for text highlights; empty for area/shape/drawing. */
  rects: Scaled[];
  /** Rare legacy flag: coordinates are PDF-space, not viewport-space. */
  usePdfCoordinates?: boolean;
}

/** One freehand polyline in capture-frame-local px (formerly the lib's
 *  DrawingStroke — kept structurally identical). */
export interface PdfDrawingStroke {
  /** `p` = stylus pressure (0..1), present only when the pen reported it;
   *  strokes saved before pressure was kept simply lack it. */
  points: Array<{ x: number; y: number; p?: number }>;
  color: string;
  width: number;
  /** "highlighter" = translucent marker band; absent or anything else = pen. */
  toolId?: string;
}

/** A PDF shape is any shape the ink format knows ("circle" is the older name
 *  of the ellipse). */
export type PdfShapeType = InkShapeKind;

export interface PdfShapeData {
  shapeType: PdfShapeType;
  strokeColor: string;
  strokeWidth: number;
  /** A tinted inside (INK_SHAPE_FILL_ALPHA); absent = none, as every record saved before fills. */
  fill?: InkShapeFill;
  /** Lines and arrows only: endpoints as 0..1 fractions of the bounding box. */
  startPoint?: { x: number; y: number };
  endPoint?: { x: number; y: number };
}

export interface PdfHighlightContent {
  text?: string;
  image?: string;
  strokes?: PdfDrawingStroke[];
  shape?: PdfShapeData;
  /** Drawing capture frame (the padded stroke bbox, px). Stored so the
   *  committed SVG can use it as a scale-free viewBox. Pre-unification
   *  records lack it — renderers recover it from stroke extents. */
  frame?: { w: number; h: number };
}

export type PdfHighlightType =
  | "text"
  | "area"
  | "freetext"
  | "image"
  | "drawing"
  | "shape";

/** One highlight record (the envelope's `annotations`; legacy pdf_annotations). */
export interface PdfHighlightRecord {
  id: string;
  type?: PdfHighlightType;
  content?: PdfHighlightContent;
  position: ScaledPosition;
}

/** The slice of a pdfjs PageViewport the math needs — duck-typed so tests
 *  can pass plain objects. */
export interface PageViewportLike {
  width: number;
  height: number;
  /** Only needed for the rare usePdfCoordinates legacy records. */
  convertToViewportRectangle?: (rect: number[]) => number[];
}

/** Capture: viewport-px rect → stored Scaled (tags the rect with the page
 *  viewport it was measured against). */
export function viewportToScaled(rect: LTWHP, viewport: PageViewportLike): Scaled {
  return {
    x1: rect.left,
    y1: rect.top,
    x2: rect.left + rect.width,
    y2: rect.top + rect.height,
    width: viewport.width,
    height: viewport.height,
    pageNumber: rect.pageNumber,
  };
}

/** Render: stored Scaled → current-viewport px. Scale-independent because
 *  both capture and render divide by their own viewport size. */
export function scaledToViewport(
  scaled: Scaled,
  viewport: PageViewportLike,
  usePdfCoordinates = false,
): LTWHP {
  if (usePdfCoordinates && viewport.convertToViewportRectangle) {
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
      scaled.x1, scaled.y1, scaled.x2, scaled.y2,
    ]);
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y1 - y2),
      pageNumber: scaled.pageNumber,
    };
  }
  const { width, height } = viewport;
  const x1 = (width * scaled.x1) / scaled.width;
  const y1 = (height * scaled.y1) / scaled.height;
  const x2 = (width * scaled.x2) / scaled.width;
  const y2 = (height * scaled.y2) / scaled.height;
  return {
    left: x1,
    top: y1,
    width: x2 - x1,
    height: y2 - y1,
    pageNumber: scaled.pageNumber,
  };
}

export function scaledPositionToViewport(
  position: ScaledPosition,
  viewport: PageViewportLike,
): { boundingRect: LTWHP; rects: LTWHP[] } {
  const convert = (s: Scaled) =>
    scaledToViewport(s, viewport, position.usePdfCoordinates ?? false);
  return {
    boundingRect: convert(position.boundingRect),
    rects: position.rects.map(convert),
  };
}

/** Union bbox of page-local rects (pageNumber taken from the first). */
export function boundingRectOf(rects: LTWHP[]): LTWHP {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.left);
    y0 = Math.min(y0, r.top);
    x1 = Math.max(x1, r.left + r.width);
    y1 = Math.max(y1, r.top + r.height);
  }
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0, pageNumber: rects[0].pageNumber };
}
