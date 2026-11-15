// A drawing as a static picture: stroke outlines (the live engine's geometry)
// and the self-contained SVG every read-only surface shows — a review card,
// a `![[drawing]]` embed in the app's preview and editor, and the published
// site (the server inlines it at serve time, modules/website/publishing/drawingEmbeds).
// One renderer, so a drawing looks the same wherever it is shown.
//
// Pure and DOM-free: same document → same string, and it runs on the server.
// Reached through `@onden/markdown/ink`; the local-DB worker imports none of
// the ink modules (frontend test/workerImports.test.ts).
//
// Outline parameters are the production-proven tldraw/Excalidraw set, pinned
// by the handwriting spec:
//   - simulatePressure = (pointerType !== 'pen') — i.e. simulate exactly when
//     the points carry no real pressure samples.
//   - mouse/touch: thinning 0.5, streamline 0.62, smoothing 0.62, easeOutSine
//   - pen (real pressure): thinning 0.62, streamline 0.62, smoothing 0.62,
//     size = 1 + size * 1.2, identity easing
// The highlighter is a fixed-width band (thinning 0) drawn translucent.

import { getStroke } from "./vendor/perfect-freehand/index.js";
import type { StrokeOptions, Vec2 } from "./vendor/perfect-freehand/index.js";
import { INK_SHAPE_FILL_ALPHA, inkShapeIsFilled, inkShapePathD, inkShapePolylines, polylineOutline } from "./inkShapes.js";
import { inkPageOrder, notePages, type InkPageRecord, type InkPages } from "./inkPages.js";
import { INK_PAGE_KEY, decodePageText } from "./pageText.js";
import { decodePageImages } from "./pageImages.js";
import { clampInkRegion, type InkRegion } from "./inkRegion.js";
import { decodeInk, type EraseInterval, type InkDocument, type InkPoint, type InkShape, type InkStroke } from "./inkFormat.js";

export type { StrokeOptions, Vec2 };

export function easeOutSine(t: number): number {
  return Math.sin((t * Math.PI) / 2);
}

/** Whether a stroke's recorded points carry real pressure samples. The
 *  presence of a third element is the persisted form of "pointerType was
 *  'pen' at capture time". */
export function hasRealPressure(points: ReadonlyArray<InkPoint>): boolean {
  return points.length > 0 && points[0]!.length >= 3;
}

/** The toolId of the polylines the ink engine makes out of a stored shape to
 *  draw it with the stroke renderers (exact width, see strokeOutline). Never
 *  stored on a stroke. */
export const SHAPE_TOOL_ID = "shape";
/** The inside of a filled shape, as the engine hands it to the stroke
 *  renderers: its points are the closed polygon itself, filled translucent
 *  (INK_SHAPE_FILL_ALPHA). Never stored on a stroke. */
export const SHAPE_FILL_TOOL_ID = "shape-fill";

/** The toolId of a stroke drawn as a plain round line of constant width: what a
 *  PDF drawing saved before pressure was kept (no tool at all) becomes when it
 *  is read as page units. The toolbar never draws it. */
export const UNIFORM_TOOL_ID = "uniform";

export interface OutlineParams {
  /** "highlighter" is a marker band; any other (including a tool a newer app
   *  saved) draws as a pen. */
  toolId: string;
  size: number;
  /** True when points carry real stylus pressure. */
  realPressure: boolean;
  /** Incomplete (wet) strokes get last:false so the tail stays live. */
  last: boolean;
}

export function strokeOptionsFor({ toolId, size, realPressure, last }: OutlineParams): StrokeOptions {
  if (toolId === "highlighter") {
    // Fixed-width band: pressure must not modulate a marker.
    return { size: size * 2.4, thinning: 0, streamline: 0.62, smoothing: 0.62, simulatePressure: false, easing: (t) => t, last };
  }
  if (realPressure) {
    return { size: 1 + size * 1.2, thinning: 0.62, streamline: 0.62, smoothing: 0.62, simulatePressure: false, easing: (t) => t, last };
  }
  return { size, thinning: 0.5, streamline: 0.62, smoothing: 0.62, simulatePressure: true, easing: easeOutSine, last };
}

/** Outline polygon for a (sub-)run of stroke points. Deterministic: same
 *  points + same options → same polygon. */
export function strokeOutline(
  points: ReadonlyArray<InkPoint>,
  stroke: Pick<InkStroke, "toolId" | "size">,
  last: boolean,
): Vec2[] {
  // A shape's centre line is filled exactly (square-edged corners, closed ends),
  // not smoothed like a pen stroke.
  if (stroke.toolId === SHAPE_FILL_TOOL_ID) return points.map((p): Vec2 => [p[0], p[1]]);
  if (stroke.toolId === SHAPE_TOOL_ID || stroke.toolId === UNIFORM_TOOL_ID) return polylineOutline(points.map((p): [number, number] => [p[0], p[1]]), stroke.size);
  return getStroke(points as InkPoint[], strokeOptionsFor({
    toolId: stroke.toolId,
    size: stroke.size,
    realPressure: hasRealPressure(points),
    last,
  }));
}

/** The visible (non-erased) index runs of a stroke with `pointCount` points,
 *  given its sorted, merged dead intervals. */
export function visibleRuns(pointCount: number, intervals: EraseInterval[] | undefined): EraseInterval[] {
  if (pointCount <= 0) return [];
  if (!intervals || intervals.length === 0) return [[0, pointCount - 1]];
  const runs: EraseInterval[] = [];
  let cursor = 0;
  for (const [a, b] of intervals) {
    if (a > cursor) runs.push([cursor, Math.min(a - 1, pointCount - 1)]);
    cursor = Math.max(cursor, b + 1);
    if (cursor >= pointCount) break;
  }
  if (cursor <= pointCount - 1) runs.push([cursor, pointCount - 1]);
  return runs;
}

// ── Static SVG ─────────────────────────────────────────────────────────────

/** Tldraw-style polygon → SVG path "d" (quadratic-smoothed closed outline).
 *  Exported so the PDF page overlay draws its strokes with the same path. */
export function outlineToPath(points: number[][]): string {
  if (points.length < 2) return "";
  let d = `M ${points[0]![0]!.toFixed(1)} ${points[0]![1]!.toFixed(1)} Q`;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i] as [number, number];
    const [x1, y1] = points[(i + 1) % points.length] as [number, number];
    d += ` ${x0.toFixed(1)} ${y0.toFixed(1)} ${((x0 + x1) / 2).toFixed(1)} ${((y0 + y1) / 2).toFixed(1)}`;
  }
  return d + " Z";
}

// stroke.color is attacker-controllable (it rides the ink_data attribute) and
// the SVG string is injected as markup (innerHTML in the app) — an unescaped
// color like `red" onload="…` would break out of the fill="" attribute
// (stored XSS). Allow only real CSS color syntax; anything else falls back to
// black. The path `d` is built from .toFixed() numbers, so it needs no
// sanitising.
const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$|^rgba?\([\d.,%\s/]+\)$|^hsla?\([\d.,%\s/]+\)$|^[a-zA-Z]+$/;
function safeColor(c: unknown): string {
  return typeof c === "string" && SAFE_COLOR.test(c.trim()) ? c.trim() : "#000";
}

type Filled = { d: string; color: string; highlighter: boolean };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

const grow = (b: Bounds, x: number, y: number) => {
  if (x < b.minX) b.minX = x;
  if (y < b.minY) b.minY = y;
  if (x > b.maxX) b.maxX = x;
  if (y > b.maxY) b.maxY = y;
};

const emptyBounds = (): Bounds => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
const mergeBounds = (into: Bounds, b: Bounds) => { grow(into, b.minX, b.minY); grow(into, b.maxX, b.maxY); };
type Rect = { x: number; y: number; w: number; h: number };
const meets = (b: Bounds, r: Rect) => b.maxX >= r.x && b.minX <= r.x + r.w && b.maxY >= r.y && b.minY <= r.y + r.h;
const inRect = (x: number, y: number, r: Rect) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** Whether the segment (ax,ay)–(bx,by) passes through `r` (Liang–Barsky). */
function segmentMeets(ax: number, ay: number, bx: number, by: number, r: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - r.x], [dx, r.x + r.w - ax], [-dy, ay - r.y], [dy, r.y + r.h - ay]] as const) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

/** Whether (x, y) is inside the closed polygon (even–odd). */
function insidePolygon(x: number, y: number, poly: ReadonlyArray<readonly number[]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as [number, number], [xj, yj] = poly[j] as [number, number];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether the filled outline (a closed polygon) puts ink inside `r`: a corner of it in `r` or an edge crossing `r` —
 *  not merely its bounding box reaching `r`. (An area smaller than one stroke's width, wholly inside the ink, is not
 *  found: the smallest area is wider than any pen.) */
function outlineTouches(outline: ReadonlyArray<readonly number[]>, r: Rect): boolean {
  for (let i = 0; i < outline.length; i++) {
    const [x, y] = outline[i] as [number, number], [x2, y2] = outline[(i + 1) % outline.length] as [number, number];
    if (inRect(x, y, r) || segmentMeets(x, y, x2, y2, r)) return true;
  }
  return false;
}

/** Whether a run of points, grown by the pen's width, could reach `r`. */
function runNear(pts: ReadonlyArray<readonly number[]>, size: number, r: Rect): boolean {
  const pad = (Number.isFinite(size) ? size : 4) * 2 + 8;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { const x = p[0]!, y = p[1]!; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  return maxX + pad >= r.x && minX - pad <= r.x + r.w && maxY + pad >= r.y && minY - pad <= r.y + r.h;
}

/** Filled outline paths for every visible stroke run; `bounds` grows by their
 *  outlines. */
function renderPaths(doc: InkDocument, bounds: Bounds, within?: Rect): Filled[] {
  const paths: Filled[] = [];
  for (const stroke of doc.strokes) {
    if (!stroke || !Array.isArray(stroke.points)) continue;
    const runs = visibleRuns(stroke.points.length, doc.erased?.[stroke.id]);
    for (const [a, b] of runs) {
      const pts = stroke.points.slice(a, b + 1);
      if (pts.length < 2) continue;
      // Cheap first: a run whose points (grown by the pen's width) are nowhere near the area is not shaped at all.
      if (within && !runNear(pts, stroke.size, within)) continue;
      const outline = strokeOutline(pts, stroke, true) as number[][];
      if (outline.length < 2) continue;
      const d = outlineToPath(outline);
      if (!d) continue;
      const mine = emptyBounds();
      for (const [x, y] of outline as Array<[number, number]>) grow(mine, x, y);
      if (within && !outlineTouches(outline, within)) continue;
      paths.push({ d, color: stroke.color, highlighter: stroke.toolId === "highlighter" });
      mergeBounds(bounds, mine);
    }
  }
  return paths;
}

const n1 = (n: number) => n.toFixed(1);

/** One shape as SVG markup, growing `bounds` by what it covers (stroke width
 *  included). A kind this version does not know (a newer app's) or malformed
 *  geometry is skipped, never an error. Every value is a fixed-precision number
 *  or goes through safeColor. */
function shapeMarkup(shape: InkShape, bounds: Bounds): string {
  if (!shape) return "";
  const lines = inkShapePolylines(shape);
  if (!lines) return "";
  const width = Number.isFinite(shape.size) && shape.size > 0 ? shape.size : 4;
  for (const line of lines) for (const [x, y] of line) {
    grow(bounds, x - width / 2, y - width / 2);
    grow(bounds, x + width / 2, y + width / 2);
  }
  // A filled shape tints its inside with its own colour; the outline stays full strength.
  const fill = inkShapeIsFilled(shape) ? ` fill="${safeColor(shape.color)}" fill-opacity="${INK_SHAPE_FILL_ALPHA}"` : ' fill="none"';
  return `<path d="${inkShapePathD(shape)}"${fill} stroke="${safeColor(shape.color)}" stroke-width="${n1(width)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** Whether a shape draws anything inside `r`: its lines (as wide as the shape's pen) pass through it, or a filled
 *  shape's inside covers it. `bounds` is what shapeMarkup measured. */
function shapeTouches(shape: InkShape, bounds: Bounds, r: Rect): boolean {
  if (!meets(bounds, r)) return false;
  const lines = inkShapePolylines(shape);
  if (!lines) return false;
  const grown: Rect = { x: r.x - shape.size / 2, y: r.y - shape.size / 2, w: r.w + shape.size, h: r.h + shape.size };
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const [x, y] = line[i]!;
      if (inRect(x, y, grown)) return true;
      const next = line[i + 1];
      if (next && segmentMeets(x, y, next[0], next[1], grown)) return true;
    }
  }
  return inkShapeIsFilled(shape) && lines.some((line) => insidePolygon(r.x + r.w / 2, r.y + r.h / 2, line));
}

/** A drawing as a self-contained `<svg>` string, cropped to what is drawn
 *  (strokes and shapes, plus a small margin), or null when there is nothing to draw: no strokes or
 *  shapes, every stroke erased, an empty/unreadable value, or a PDF's envelope (its
 *  strokes belong on the PDF's pages). Accepts the stored `ink_data` value or
 *  a decoded page. `width`/`height` are the drawing's own size in document
 *  units, so an `<img>` of it has a natural size; hosts scale it with CSS
 *  (`width: 100%; height: auto` keeps the aspect ratio). Pure. */
export function inkToSvg(ink: string | InkDocument | null | undefined): string | null {
  return inkToSvgFrame(ink)?.svg ?? null;
}

/** inkToSvg plus where the picture sits: `x`/`y`/`width`/`height` are its
 *  viewBox in the drawing's own units, rounded to whole units (the frame an
 *  exporter places the picture at, e.g. a JSON Canvas file node). */
export type InkSvgFrame = { svg: string; x: number; y: number; width: number; height: number };

export function inkToSvgFrame(ink: string | InkDocument | null | undefined): InkSvgFrame | null {
  const drawn = drawDocument(ink);
  if (!drawn) return null;
  const { body, bounds } = drawn;
  const pad = 8;
  const x = bounds.minX - pad;
  const y = bounds.minY - pad;
  const w = Math.max(1, bounds.maxX - bounds.minX + pad * 2);
  const h = Math.max(1, bounds.maxY - bounds.minY + pad * 2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
  return { svg, x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}

/** The sheet a published handwriting page is drawn on, whatever the site's
 *  theme: ink colours are stored for a light page (the palette's dark ink is
 *  inverted at render time in dark mode), so a transparent picture would lose
 *  its strokes on a dark site. */
export const INK_PAPER_COLOR = "#fbfaf6";
const INK_PAPER_EDGE = "#d8d4c8";
/** Blank space kept under the last stroke of a published page. */
const PAGE_BOTTOM_MARGIN = 48;
const PAGE_MIN_HEIGHT = 320;

/** One page of a drawing as a picture of the whole sheet: `page.size.width`
 *  wide from x = 0 (not cropped to the strokes, so every page of a note has
 *  the same width and the same scale), on paper, as tall as its ink plus a
 *  margin (at most `page.size.height`, so a short note is not a mostly empty
 *  sheet). Null when there is nothing to draw, as inkToSvg. Pure. */
export function inkPageToSvg(page: Pick<InkPageRecord, "size" | "doc">): string | null {
  const drawn = drawDocument(page.doc);
  if (!drawn) return null;
  const width = Math.max(1, Math.round(page.size.width));
  const height = Math.max(1, Math.min(Math.round(page.size.height), Math.max(PAGE_MIN_HEIGHT, Math.ceil(drawn.bounds.maxY + PAGE_BOTTOM_MARGIN))));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">`
    + `<path d="M0 0H${width}V${height}H0Z" fill="${INK_PAPER_COLOR}"/>${drawn.body}`
    + `<path d="M1 1H${width - 1}V${height - 1}H1Z" fill="none" stroke="${INK_PAPER_EDGE}" stroke-width="2"/></svg>`;
}

/** A text box as drawn on an overlay page (the fields of pageText's PageTextBox
 *  this picture needs). */
export type InkOverlayText = { x: number; y: number; w: number; text: string; size: number; color: string; align: string };

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Roughly how wide a character sets: a wide (CJK) one a full em, others about half. */
const charEm = (ch: string) => ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.55);

/** The lines a box's text breaks into: at its newlines, and where a line would
 *  pass the box's width (the page's own wrapping is the browser's; this is an
 *  estimate good enough for a picture of the page). */
function wrapText(text: string, width: number, size: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "", used = 0;
    for (const ch of paragraph) {
      const em = charEm(ch) * size;
      if (used + em > width && line) { lines.push(line); line = ""; used = 0; }
      line += ch;
      used += em;
    }
    lines.push(line);
  }
  return lines;
}

function textMarkup(box: InkOverlayText): string {
  const size = Number.isFinite(box.size) && box.size > 0 ? box.size : 22;
  const lines = wrapText(box.text, Math.max(1, box.w), size);
  const anchor = box.align === "center" ? "middle" : box.align === "right" ? "end" : "start";
  const x = box.align === "center" ? box.x + box.w / 2 : box.align === "right" ? box.x + box.w : box.x;
  const spans = lines.map((line, i) => `<tspan x="${x.toFixed(1)}" dy="${i === 0 ? 0 : (size * 1.3).toFixed(1)}">${escapeXml(line)}</tspan>`).join("");
  return `<text x="${x.toFixed(1)}" y="${(box.y + size).toFixed(1)}" font-size="${size}" font-family="sans-serif" text-anchor="${anchor}" fill="${safeColor(box.color)}">${spans}</text>`;
}

/** One page's strokes, shapes and text boxes alone, on a transparent sheet of
 *  the page's size (a PDF page without the PDF: the picture goes next to
 *  the page it was drawn on). Null when there is nothing on it. Pure. */
export function inkOverlayToSvg(page: Pick<InkPageRecord, "size" | "doc">, texts: readonly InkOverlayText[] = []): string | null {
  const drawn = drawDocument(page.doc);
  const words = texts.filter((t) => t.text.trim() !== "").map(textMarkup).join("");
  if (!drawn && !words) return null;
  const width = Math.max(1, Math.round(page.size.width));
  const height = Math.max(1, Math.round(page.size.height));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">${drawn?.body ?? ""}${words}</svg>`;
}

/** Bump when inkPageToSvg / drawDocument change what they draw: a published
 *  page's file is named by the drawing's hash and this number, not by the
 *  picture (the server must not draw 10 000 strokes just to find a name), so an
 *  old file would otherwise be served for the new renderer. The pinned hash in
 *  handwritingPage.test.ts fails until it is bumped. */
export const INK_PAGE_RENDER_VERSION = 1;

/** A page of a handwriting note, found without drawing it. */
export type InkNotePage = {
  /** The page's key in the drawing: stable for as long as the page is. */
  key: string;
  /** The picture of the whole sheet (inkPageToSvg; a page whose strokes are all
   *  erased is a blank sheet). Costs the drawing: ~2 s for 10 000 strokes. */
  draw: () => string;
};

/** A handwriting note's pages, top to bottom (inkPageOrder); a page with
 *  nothing on it is skipped. Reads the stored drawing but draws nothing (see
 *  `draw`). `ink_data` of a PDF, an empty or unreadable value: none. */
export function inkPages(ink: string | null | undefined): InkNotePage[] {
  const decoded = decodeInk(ink);
  if (decoded.kind !== "page") return [];
  const notebook = notePages(decoded.doc);
  return inkPageOrder(notebook).flatMap((key) => {
    const page = notebook.pages[key]!;
    if (!(page.doc.strokes?.length || page.doc.shapes?.length)) return [];
    return [{ key, draw: () => inkPageToSvg(page) ?? blankPageSvg(page.size.width) }];
  });
}

function blankPageSvg(width: number): string {
  const w = Math.max(1, Math.round(width));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${PAGE_MIN_HEIGHT}" viewBox="0 0 ${w} ${PAGE_MIN_HEIGHT}" preserveAspectRatio="xMidYMid meet">`
    + `<path d="M0 0H${w}V${PAGE_MIN_HEIGHT}H0Z" fill="${INK_PAPER_COLOR}"/>`
    + `<path d="M1 1H${w - 1}V${PAGE_MIN_HEIGHT - 1}H1Z" fill="none" stroke="${INK_PAPER_EDGE}" stroke-width="2"/></svg>`;
}

/** The strokes and shapes of a document as SVG markup, with the bounds they
 *  cover; null when there is nothing visible. */
function drawDocument(ink: string | InkDocument | null | undefined, within?: Rect): { body: string; bounds: Bounds } | null {
  let doc: InkDocument | null;
  if (typeof ink === "string" || ink == null) {
    const decoded = decodeInk(ink);
    doc = decoded.kind === "page" ? decoded.doc : null;
  } else doc = ink;
  if (!doc) return null;
  const strokes = Array.isArray(doc.strokes) ? doc : { ...doc, strokes: [] };
  const bounds = emptyBounds();
  const paths = renderPaths(strokes, bounds, within);
  const shapes = (Array.isArray(doc.shapes) ? doc.shapes : []).map((shape) => {
    const mine = emptyBounds();
    const markup = shapeMarkup(shape, mine);
    if (!markup || (within && !shapeTouches(shape, mine, within))) return "";
    mergeBounds(bounds, mine);
    return markup;
  }).filter(Boolean);
  if ((paths.length === 0 && shapes.length === 0) || !Number.isFinite(bounds.minX)) return null;
  const body = paths
    .map((p) => `<path d="${p.d}" fill="${safeColor(p.color)}"${p.highlighter ? ' fill-opacity="0.4"' : ""}/>`)
    .join("") + shapes.join("");
  return { body, bounds };
}

/** What a quoted region of a handwriting note shows: its picture, or why there is none.
 *  `notInk`: the note holds no handwriting (a text note, a PDF, nothing stored). `page`: the note has no such page
 *  (deleted, or never was). `empty`: the page is there but nothing is drawn or written inside the rectangle now.
 *  `outside`: the rectangle lies off the page. */
export type InkRegionPicture =
  | { kind: "picture"; svg: string; width: number; height: number }
  | { kind: "notInk" | "page" | "empty" | "outside" };

/** What else is on the page besides ink, as the note stores it (the raw `page_text` and `page_images` attributes). */
export type InkRegionLayers = {
  text?: string | null;
  images?: string | null;
  /** Draw the pictures too. Off where the picture cannot load another file (an SVG used as an image: the published site). */
  withImages?: boolean;
  /** How a picture's stored address (`/api/media/<id>`) is reached from where the SVG is shown (the app's API origin). */
  imageSrc?: (src: string) => string;
};

// A page's decoded notebook, kept for the last few drawings read: every quoted area of one drawing in a note (and
// each redraw after a stroke) would otherwise parse the same stored value again.
const decodedPages = new Map<string, InkPages>();
function pagesOf(ink: string): InkPages | null {
  const cached = decodedPages.get(ink);
  if (cached) { decodedPages.delete(ink); decodedPages.set(ink, cached); return cached; }
  const decoded = decodeInk(ink);
  if (decoded.kind !== "page") return null;
  const pages = notePages(decoded.doc);
  decodedPages.set(ink, pages);
  if (decodedPages.size > 4) decodedPages.delete(decodedPages.keys().next().value!);
  return pages;
}

/** How far down a page reaches: a notebook's first page is as tall as its ink (the stored value keeps no height for
 *  it, and the sheet shown may be taller than what is left after erasing), so no bottom edge is assumed for it; the
 *  others have a stored size. */
const pageHeightOf = (key: string, record: InkPageRecord): number => (key === INK_PAGE_KEY ? 1e6 : record.size.height);

/** The part of one page of a handwriting note inside `region`, as a self-contained `<svg>`: the region (clamped to the
 *  page, inkRegion.ts) is the viewBox, so strokes crossing its edge are cut there, and the picture is as wide as the
 *  region is in page units (hosts scale it with CSS, as inkToSvg's). What counts as being in the region is what is
 *  actually drawn inside it — strokes, shapes, text boxes and (`withImages`) pictures — not the box around a stroke
 *  that merely passes by. Transparent and coloured as stored, like a whole-drawing embed. Pure. */
export function inkRegionToSvg(ink: string | null | undefined, region: InkRegion, layers: InkRegionLayers = {}): InkRegionPicture {
  const pages = ink ? pagesOf(ink) : null;
  if (!pages) return { kind: "notInk" };
  const record = pages.pages[region.page];
  if (!record) return { kind: "page" };
  const rect = clampInkRegion(region, { width: record.size.width, height: pageHeightOf(region.page, record) });
  if (!rect) return { kind: "outside" };
  const drawn = drawDocument(record.doc, rect);
  const texts = layers.text ? decodePageText(layers.text).pages[region.page]?.boxes ?? [] : [];
  const words = texts.filter((box) => box.text.trim() !== "" && meets(textBounds(box), rect)).map(textMarkup).join("");
  const pictures = layers.withImages && layers.images
    ? (decodePageImages(layers.images).pages[region.page]?.images ?? []).filter((image) => meets({ minX: image.x, minY: image.y, maxX: image.x + image.w, maxY: image.y + image.h }, rect))
    : [];
  if (!drawn && !words && pictures.length === 0) return { kind: "empty" };
  const w = Math.max(1, Math.round(rect.w)), h = Math.max(1, Math.round(rect.h));
  const images = pictures.map((p) => `<image href="${escapeXml(layers.imageSrc ? layers.imageSrc(p.src) : p.src)}" x="${n1(p.x)}" y="${n1(p.y)}" width="${n1(p.w)}" height="${n1(p.h)}" preserveAspectRatio="none"/>`).join("");
  return {
    kind: "picture", width: w, height: h,
    // Pictures under the strokes, text over them: the page's own order.
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${n1(rect.x)} ${n1(rect.y)} ${n1(rect.w)} ${n1(rect.h)}" preserveAspectRatio="xMidYMid meet">${images}${drawn?.body ?? ""}${words}</svg>`,
  };
}

/** A text box's extent on the page (its height is its lines', as textMarkup sets them). */
function textBounds(box: InkOverlayText): Bounds {
  const size = Number.isFinite(box.size) && box.size > 0 ? box.size : 22;
  const lines = wrapText(box.text, Math.max(1, box.w), size).length;
  return { minX: box.x, minY: box.y, maxX: box.x + box.w, maxY: box.y + size * (1 + (lines - 1) * 1.3) * 1.15 };
}
