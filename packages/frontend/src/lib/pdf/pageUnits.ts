// A PDF note's drawing as pages in PAGE UNITS, and the older form written from
// them. Pure module (no DOM, no pdfjs): the unit-testable half of PDF drawing.
//
// The pages are the handwriting page's own format (@onden/markdown/ink
// InkPages): per page one InkDocument whose coordinates are page units (the
// page is 1000 wide at any zoom), so a page's InkEngine loads it as is and
// `serialize()` gives the page back. They are stored in the envelope's `units`
// beside the older fields (`pages[n]` strokes in record frames + the `drawing`
// and `shape` records), which are still written from them so an older app shows
// and edits the same drawing. Reading prefers `units`; when they are missing
// (a note saved before this format) or stale (an older app edited the older
// fields since) the older fields are converted again. Nothing is migrated: the
// conversion runs on read, and a note is rewritten only by the next edit.
//
// Reading the older form (pagesFromLegacy), per drawing record:
//   units = (record placement in the capture viewport + stroke point × frame
//            scale) × 1000 / capture-viewport width
// — the record's `boundingRect` carries the viewport it was captured in
// (`width`/`height`), `content.frame` the px box its points are local to (a
// record without one: recordFrame). A stroke keeps its id (drawingStrokeId),
// pressure, tool and erased intervals; its size scales like its points. A
// stroke that named no tool (saved before pressure was kept) was drawn as a
// constant-width line and stays one: tool "uniform". A shape record becomes an
// InkShape at the same units, a box shape inset by half its line width (as the
// engine always drew it). Text and area records are not drawings and are left
// alone. Strokes that only `pages[n]` holds (the record is gone) are kept as
// stored: they have no placement to convert.
//
// Writing the older form (setPdfPageDoc): drawing and shape records that are
// still whole are kept as they are (strokes and shapes never change once
// committed); each other stroke becomes a record of its own named by the stroke
// id, so ids are the same in both forms; a record the page no longer has is
// dropped. Records are placed in a reference viewport 1000 wide (and 1000·ratio
// tall), which the older app scales to the page like any other.

import {
  INK_PAGE_UNITS, UNIFORM_TOOL_ID, currentUnits, inkHasContent, legacyFingerprint, pdfPageOfKey, pdfPageRecord,
  type EraseInterval, type InkDocument, type InkPages, type InkShape, type InkStroke,
} from "@onden/markdown/ink";
import { pdfPageKey } from "@onden/markdown/page-text";
import { drawingRecord, shapeRecord } from "./capture";
import type { PdfDrawingStroke, PdfHighlightRecord, PdfShapeType } from "./coords";
import { addDrawingToPage, addShapeToPage, decodePdfInk, drawingStrokeId, drawingStrokesToInk, emptyMultiPageDoc, type InkMultiPageDoc } from "./pdfAdapter";
import { pageWithOnly, type InkAdded } from "../ink";

/** Page height / width when nothing on a page says (A4). */
const DEFAULT_RATIO = Math.SQRT2;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isDirected = (kind: string) => kind === "line" || kind === "arrow";
const isInk = (a: PdfHighlightRecord) => a.type === "drawing" || a.type === "shape";
const pageOf = (a: PdfHighlightRecord) => a.position?.boundingRect?.pageNumber;

/** The record's capture frame (px). Older records carry none: recover it from
 *  the stroke extents, as the renderer always did. */
export function recordFrame(record: PdfHighlightRecord): { w: number; h: number } {
  const stored = record.content?.frame;
  if (stored) return stored;
  const strokes = record.content?.strokes ?? [];
  return {
    w: Math.max(1, ...strokes.flatMap((s) => s.points.map((p) => p.x))),
    h: Math.max(1, ...strokes.flatMap((s) => s.points.map((p) => p.y))),
  };
}

export const emptyPageDoc = (): InkDocument => ({ version: 1, strokes: [], erased: {}, page: { width: INK_PAGE_UNITS } });

// ── Older form → page units ────────────────────────────────────────────────

/** A placed record's geometry: its capture rect (px) and the units per px. */
function placement(record: PdfHighlightRecord) {
  const r = record.position?.boundingRect;
  if (!r || !finite(r.x1) || !finite(r.y1) || !finite(r.x2) || !finite(r.y2) || !finite(r.width) || r.width <= 0 || !finite(r.height) || r.height <= 0) return null;
  const width = r.x2 - r.x1, height = r.y2 - r.y1;
  if (!(width > 0) || !(height > 0)) return null;
  return { left: r.x1, top: r.y1, width, height, k: INK_PAGE_UNITS / r.width, ratio: r.height / r.width };
}

function strokesOfRecord(record: PdfHighlightRecord): InkStroke[] {
  const stored = record.content?.strokes ?? [];
  const at = placement(record);
  if (stored.length === 0 || !at) return [];
  const frame = recordFrame(record);
  const sx = at.width / frame.w, sy = at.height / frame.h;
  return drawingStrokesToInk(record.id, stored).map((s, i) => ({
    ...s,
    toolId: stored[i]!.toolId === undefined ? UNIFORM_TOOL_ID : s.toolId,
    size: s.size * sx * at.k,
    points: s.points.map((p) => {
      const x = (at.left + p[0] * sx) * at.k, y = (at.top + p[1] * sy) * at.k;
      return p.length >= 3 ? [x, y, p[2]!] : [x, y];
    }),
  }));
}

function shapeOfRecord(record: PdfHighlightRecord): InkShape | null {
  const data = record.content?.shape;
  const at = placement(record);
  if (!data || !at) return null;
  const width = finite(data.strokeWidth) ? data.strokeWidth : 2;
  const from = data.startPoint, to = data.endPoint;
  const directed = isDirected(data.shapeType) && from && to;
  const inset = Math.min(width / 2, at.width / 2, at.height / 2);
  const point = (x: number, y: number): [number, number] => [x * at.k, y * at.k];
  return {
    id: record.id,
    kind: data.shapeType,
    start: directed ? point(at.left + from.x * at.width, at.top + from.y * at.height) : point(at.left + inset, at.top + inset),
    end: directed ? point(at.left + to.x * at.width, at.top + to.y * at.height) : point(at.left + at.width - inset, at.top + at.height - inset),
    color: data.strokeColor ?? "#315f8f",
    size: width * at.k,
    ...(data.fill === "solid" ? { fill: "solid" as const } : {}),
  };
}

const copyIntervals = (iv: EraseInterval[]): EraseInterval[] => iv.map((x): EraseInterval => [x[0], x[1]]);

/** The pages of the older fields, in page units (see the header). */
export function pagesFromLegacy(env: InkMultiPageDoc): InkPages {
  const numbers = new Set<number>(Object.keys(env.pages).map(Number));
  for (const a of env.annotations ?? []) if (isInk(a) && finite(pageOf(a))) numbers.add(pageOf(a)!);
  const out: InkPages = { version: 1, pages: {} };
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const legacy = env.pages[n];
    const doc = emptyPageDoc();
    const shapes: InkShape[] = [];
    const seen = new Set<string>();
    let ratio: number | null = null;
    for (const record of env.annotations ?? []) {
      if (pageOf(record) !== n || !isInk(record)) continue;
      ratio ??= placement(record)?.ratio ?? null;
      if (record.type === "shape") {
        const shape = shapeOfRecord(record);
        if (shape && !seen.has(shape.id)) { seen.add(shape.id); shapes.push(shape); }
        continue;
      }
      for (const s of strokesOfRecord(record)) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        doc.strokes.push(s);
      }
    }
    // What only pages[n] holds (its record is gone) has no placement: as stored.
    for (const s of legacy?.strokes ?? []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      doc.strokes.push(s);
    }
    for (const s of legacy?.shapes ?? []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      shapes.push(s);
    }
    for (const s of doc.strokes) {
      const iv = legacy?.erased[s.id];
      if (iv?.length) doc.erased[s.id] = copyIntervals(iv);
    }
    if (shapes.length > 0) doc.shapes = shapes;
    if (inkHasContent(doc)) out.pages[pdfPageKey(n)] = pdfPageRecord(n, doc, ratio ?? DEFAULT_RATIO);
  }
  return out;
}

/** The envelope with `units` that describe its older fields: as is when they
 *  already do, converted from the older fields otherwise (a note saved before
 *  this format, or edited since by an older app). Pages of other kinds in a
 *  stale `units` are kept. The older fields are never changed. */
export function withUnits(env: InkMultiPageDoc): InkMultiPageDoc {
  if (currentUnits(env)) return env;
  const carried = Object.entries(env.units?.pages ?? {}).filter(([key]) => pdfPageOfKey(key) === null);
  const derived = pagesFromLegacy(env);
  return {
    ...env,
    units: { ...env.units, version: 1, pages: { ...Object.fromEntries(carried), ...derived.pages } },
    unitsFrom: legacyFingerprint(env),
  };
}

/** A PDF note's stored drawing: its envelope with the pages in page units. */
export function readPdfInk(inkRaw: string | null | undefined, legacyAnnotationsRaw: string | null | undefined): InkMultiPageDoc {
  return withUnits(decodePdfInk(inkRaw, legacyAnnotationsRaw));
}

/** Page `n`'s drawing in page units, or undefined when it has none. */
export function pdfPageDoc(env: InkMultiPageDoc, n: number): InkDocument | undefined {
  return withUnits(env).units?.pages[pdfPageKey(n)]?.doc;
}

// ── Page units → older form ─────────────────────────────────────────────────

const toDrawingStroke = (s: InkStroke): PdfDrawingStroke => ({
  points: s.points.map((p) => (p.length >= 3 ? { x: p[0], y: p[1], p: p[2] } : { x: p[0], y: p[1] })),
  color: s.color,
  width: s.size,
  toolId: s.toolId === UNIFORM_TOOL_ID ? undefined : s.toolId,
});

/** A shape as a record: a box shape's record box is the outer edge of its line. */
function recordOfShape(shape: InkShape, page: number, viewport: { width: number; height: number }): PdfHighlightRecord | null {
  const grow = isDirected(shape.kind) ? 0 : shape.size / 2;
  const [x1, x2] = [Math.min(shape.start[0], shape.end[0]), Math.max(shape.start[0], shape.end[0])];
  const [y1, y2] = [Math.min(shape.start[1], shape.end[1]), Math.max(shape.start[1], shape.end[1])];
  return shapeRecord(
    shape.id,
    page,
    isDirected(shape.kind) ? { x: shape.start[0], y: shape.start[1] } : { x: x1 - grow, y: y1 - grow },
    isDirected(shape.kind) ? { x: shape.end[0], y: shape.end[1] } : { x: x2 + grow, y: y2 + grow },
    { shapeType: shape.kind as PdfShapeType, strokeColor: shape.color, strokeWidth: shape.size, ...(shape.fill === "solid" ? { fill: "solid" as const } : {}) },
    viewport,
  );
}

/** The older fields of page `n` as `doc` says them (see the header). */
function writeLegacyPage(env: InkMultiPageDoc, n: number, doc: InkDocument, ratio: number): InkMultiPageDoc {
  const viewport = { width: INK_PAGE_UNITS, height: INK_PAGE_UNITS * ratio };
  const strokeIds = new Set(doc.strokes.map((s) => s.id));
  const shapeIds = new Set((doc.shapes ?? []).map((s) => s.id));
  const old = env.pages[n];
  const annotations: PdfHighlightRecord[] = [];
  const kept: PdfHighlightRecord[] = [];
  const owned = new Set<string>(); // ids the records of this page hold, now or before
  const oldOwned = new Set<string>();
  for (const a of env.annotations ?? []) {
    if (pageOf(a) !== n || !isInk(a)) { annotations.push(a); continue; }
    const stored = a.content?.strokes ?? [];
    const ids = a.type === "shape" ? [a.id] : stored.map((_, i) => drawingStrokeId(a.id, i, stored.length));
    ids.forEach((id) => oldOwned.add(id));
    const still = a.type === "shape" ? shapeIds : strokeIds;
    if (ids.length > 0 && ids.every((id) => still.has(id) && !owned.has(id))) {
      ids.forEach((id) => owned.add(id));
      annotations.push(a);
      kept.push(a);
    }
  }
  // An orphan (in pages[n], no record ever held it) stays one: it has no placement.
  const oldStrokeIds = new Set((old?.strokes ?? []).map((s) => s.id));
  const oldShapeIds = new Set((old?.shapes ?? []).map((s) => s.id));
  const orphan = (id: string, held: Set<string>) => !oldOwned.has(id) && held.has(id);
  const added: PdfHighlightRecord[] = [];
  for (const s of doc.strokes) {
    if (owned.has(s.id) || orphan(s.id, oldStrokeIds)) continue;
    const record = drawingRecord(s.id, n, [toDrawingStroke(s)], viewport);
    if (record) added.push(record);
  }
  for (const s of doc.shapes ?? []) {
    if (owned.has(s.id) || orphan(s.id, oldShapeIds)) continue;
    const record = recordOfShape(s, n, viewport);
    if (record) added.push(record);
  }

  const base: InkDocument = {
    ...(old ?? emptyPageDoc()),
    strokes: (old?.strokes ?? []).filter((s) => strokeIds.has(s.id) && !oldOwned.has(s.id)),
    erased: {},
  };
  const orphanShapes = (old?.shapes ?? []).filter((s) => shapeIds.has(s.id) && !oldOwned.has(s.id));
  if (orphanShapes.length > 0 || old?.shapes) base.shapes = orphanShapes;
  else delete base.shapes;
  // The page's older copy, written the way the older app writes it.
  let next: InkMultiPageDoc = { ...env, pages: { ...env.pages, [n]: base } };
  for (const record of [...kept, ...added]) {
    if (record.type === "shape") next = addShapeToPage(next, n, record.id, record.content!.shape!);
    else next = addDrawingToPage(next, n, record.id, record.content?.strokes ?? []);
  }
  const page = next.pages[n]!;
  const erased: InkDocument["erased"] = {};
  for (const s of page.strokes) {
    const iv = doc.erased[s.id];
    if (iv?.length) erased[s.id] = copyIntervals(iv);
  }
  return { ...next, annotations: [...annotations, ...added], pages: { ...next.pages, [n]: { ...page, erased } } };
}

/** The envelope with page `n`'s drawing replaced by `doc` (page units; what the
 *  page's engine serialized), in both forms: `units`, and the older fields
 *  generated from it. `ratio` = the page's height / width. Same object when the
 *  page had no drawing and `doc` has none. */
export function setPdfPageDoc(envelope: InkMultiPageDoc, n: number, doc: InkDocument, ratio: number): InkMultiPageDoc {
  const env = withUnits(envelope);
  const key = pdfPageKey(n);
  const had = env.units!.pages[key];
  if (!had && !inkHasContent(doc)) return env;
  const written = writeLegacyPage(env, n, doc, ratio);
  return {
    ...written,
    units: { ...env.units!, pages: { ...env.units!.pages, [key]: { ...had, ...pdfPageRecord(n, doc, ratio) } } },
    unitsFrom: legacyFingerprint(written),
  };
}

/** A PDF note's envelope holding only `added` on page `key` (strokes just finished: lib/ink/additions), in both forms
 *  through setPdfPageDoc, the page's settings taken from the note's own envelope. What the saver keeps at pen-up; merged
 *  from nothing it adds exactly those strokes (test/inkAdditionsMerge.test.ts). `ratio` = the page's height / width. */
export function pdfWithOnly(envelope: InkMultiPageDoc, key: string, added: InkAdded, ratio: number): InkMultiPageDoc | null {
  const n = pdfPageOfKey(key);
  if (n === null) return null;
  const page = envelope.units?.pages[key]?.doc.page ?? emptyPageDoc().page;
  return setPdfPageDoc(emptyMultiPageDoc(), n, pageWithOnly(page, added), ratio);
}
