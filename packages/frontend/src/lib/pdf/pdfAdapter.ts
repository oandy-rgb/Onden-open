// PDF host adapter — unifies PDF freehand annotations onto the ink data model.
//
// Capture is first-party (the ink engine over the page book's PDF pages — see
// pagebook/PageInkSurface), and the CANONICAL stored form is ink: per-page
// InkDocument inside an InkMultiPageDoc envelope on the PDF node's
// `ink_data` attribute. No bitmap is ever persisted — committed rendering
// is a vector SVG (PdfInkStrokes), so zoom stays crisp and every annotation
// is diffable/governable through the same diffInk the canvas uses.
//
// Coordinate contract: stroke points are stored in CAPTURE-FRAME-local px
// (the drawing's padded bounding rect at capture time, lib/pdf/capture.ts).
// We keep that frame per highlight: stroke points are stored frame-local,
// and the frame's rect rides in the companion highlight position
// (pdf_annotations keeps the position for placement; ink_data owns the
// strokes). A stroke's id IS its highlight id — one drawing gesture = one
// highlight = one ink stroke group.

import type { PdfDrawingStroke, PdfHighlightRecord, PdfShapeData } from "./coords";
import { inkHasContent, inkPageOrder, notePages, type InkEnvelope, decodeInk } from "@onden/markdown/ink";
import { describeInkDiff, diffInk, isEmptyInkDiff, type InkDiff, type InkDocument, type InkPoint, type InkStroke } from "../ink";

export type { PdfDrawingStroke, PdfShapeData } from "./coords";

/** The PDF's ink_data envelope (decoded by decodePdfInk below): per-page
 *  strokes and shapes, plus every highlight record (text, area, drawing frame,
 *  shape) — one attribute, so one PDF edit is one write and one event. */
export type InkMultiPageDoc = InkEnvelope<PdfHighlightRecord>;

export function emptyMultiPageDoc(): InkMultiPageDoc {
  return { version: 1, pages: {}, annotations: [] };
}

/** A PDF note's drawing state: its ink_data envelope, with the highlight
 *  records it carries. Envelopes saved before annotations moved in (W20) have
 *  none; their records still live in the legacy `pdf_annotations` attribute,
 *  read here and folded in — it is never written again, so the next save
 *  carries them in the envelope. */
export function decodePdfInk(inkRaw: string | null | undefined, legacyAnnotationsRaw: string | null | undefined): InkMultiPageDoc {
  const decoded = decodeInk<PdfHighlightRecord>(inkRaw);
  const doc: InkMultiPageDoc = decoded.kind === "pdf" ? decoded.doc : { version: 1, pages: {} };
  if (doc.annotations) return doc;
  let legacy: unknown = null;
  if (legacyAnnotationsRaw) { try { legacy = JSON.parse(legacyAnnotationsRaw); } catch { /* unreadable: none */ } }
  return { ...doc, annotations: Array.isArray(legacy) ? legacy as PdfHighlightRecord[] : [] };
}

/** stored stroke shape → ink. `groupId` is the highlight id; strokes within
 *  one drawing gesture get suffixed ids so each remains individually
 *  diffable. */
export function drawingStrokesToInk(groupId: string, strokes: PdfDrawingStroke[]): InkStroke[] {
  return strokes.map((s, i) => ({
    id: drawingStrokeId(groupId, i, strokes.length),
    points: s.points.map((p): InkPoint => (p.p === undefined ? [p.x, p.y] : [p.x, p.y, p.p])),
    color: s.color,
    size: s.width,
    toolId: s.toolId ?? "pen",
  }));
}

/** The stored id of stroke `index` of a drawing with `count` strokes. */
export function drawingStrokeId(groupId: string, index: number, count: number): string {
  return count === 1 ? groupId : `${groupId}:${index}`;
}

/** Upsert one drawing gesture's strokes into the page doc (immutable). */
export function addDrawingToPage(
  doc: InkMultiPageDoc,
  pageNumber: number,
  groupId: string,
  strokes: PdfDrawingStroke[],
  pageWidth = 1000,
): InkMultiPageDoc {
  const page = doc.pages[pageNumber] ?? { version: 1 as const, strokes: [], erased: {}, page: { width: pageWidth } };
  return {
    ...doc,
    pages: {
      ...doc.pages,
      [pageNumber]: { ...page, strokes: [...page.strokes, ...drawingStrokesToInk(groupId, strokes)] },
    },
  };
}

/** Upsert one shape annotation into the page doc (immutable). */
export function addShapeToPage(
  doc: InkMultiPageDoc,
  pageNumber: number,
  id: string,
  shape: PdfShapeData,
  pageWidth = 1000,
): InkMultiPageDoc {
  const page = doc.pages[pageNumber] ?? { version: 1 as const, strokes: [], erased: {}, page: { width: pageWidth } };
  const inkShape = {
    id,
    kind: shape.shapeType,
    start: [shape.startPoint?.x ?? 0, shape.startPoint?.y ?? 0] as [number, number],
    end: [shape.endPoint?.x ?? 1, shape.endPoint?.y ?? 1] as [number, number],
    color: shape.strokeColor,
    size: shape.strokeWidth,
  };
  return {
    ...doc,
    pages: {
      ...doc.pages,
      [pageNumber]: { ...page, shapes: [...(page.shapes ?? []), inkShape] },
    },
  };
}

/** Per-page diffs + the grand total, for evidence/history summaries. */
export function diffMultiPage(prev: InkMultiPageDoc | null, next: InkMultiPageDoc): Record<number, InkDiff> {
  const out: Record<number, InkDiff> = {};
  const pageNums = new Set([
    ...Object.keys(prev?.pages ?? {}).map(Number),
    ...Object.keys(next.pages).map(Number),
  ]);
  const empty: InkDocument = { version: 1, strokes: [], erased: {}, page: { width: 1000 } };
  for (const n of pageNums) {
    out[n] = diffInk(prev?.pages[n] ?? null, next.pages[n] ?? empty);
  }
  return out;
}

/** Highlight records added/removed between two envelopes, by id. */
function annotationDelta(prev: InkMultiPageDoc | null, next: InkMultiPageDoc | null): string | null {
  const before = new Set((prev?.annotations ?? []).map((a) => a.id));
  const after = new Set((next?.annotations ?? []).map((a) => a.id));
  const added = [...after].filter((id) => !before.has(id)).length;
  const removed = [...before].filter((id) => !after.has(id)).length;
  const parts: string[] = [];
  if (added) parts.push(`added ${added} highlight${added > 1 ? "s" : ""}`);
  if (removed) parts.push(`removed ${removed} highlight${removed > 1 ? "s" : ""}`);
  return parts.length ? parts.join(", ") : null;
}

/** Human summary of an ink_data value change, format-agnostic: handles both
 *  the PDF multi-page envelope and the single-page canvas/handwriting doc.
 *  This is what review surfaces show INSTEAD of raw JSON — the reader sees
 *  the gesture ("p.1: drew 2 strokes"), never the schema. */
export function describeInkValueChange(prevRaw: string | null, nextRaw: string | null): string {
  const prev = decodeInk<PdfHighlightRecord>(prevRaw);
  const next = decodeInk<PdfHighlightRecord>(nextRaw);
  const empty: InkDocument = { version: 1, strokes: [], erased: {}, page: { width: 1000 } };
  if (prev.kind === "pdf" || next.kind === "pdf") {
    const prevDoc = prev.kind === "pdf" ? prev.doc : null;
    const nextDoc = next.kind === "pdf" ? next.doc : null;
    const diffs = diffMultiPage(prevDoc, nextDoc ?? emptyMultiPageDoc());
    const parts = Object.entries(diffs)
      .filter(([, d]) => !isEmptyInkDiff(d))
      .map(([page, d]) => `p.${page}: ${describeInkDiff(d)}`);
    // Highlight records change with or without strokes (a drawing adds both;
    // a text highlight only a record) — report them either way.
    const highlights = annotationDelta(prevDoc, nextDoc);
    if (highlights) parts.push(highlights);
    return parts.length ? parts.join("; ") : "no ink change";
  }
  if (prev.kind === "none" && next.kind === "none") return "no ink change";
  // A handwriting note: its pages by key, numbered as they read.
  const was = notePages(prev.kind === "page" ? prev.doc : null);
  const now = notePages(next.kind === "page" ? next.doc : null);
  const keys = [...new Set([...inkPageOrder(now), ...inkPageOrder(was)])];
  const changed = keys.map((key, i) => ({ n: i + 1, d: diffInk(was.pages[key]?.doc ?? null, now.pages[key]?.doc ?? empty) }))
    .filter(({ d }) => !isEmptyInkDiff(d));
  if (keys.length <= 1 || changed.length === 0) return describeInkDiff(changed[0]?.d ?? diffInk(null, empty));
  return changed.map(({ n, d }) => `p.${n}: ${describeInkDiff(d)}`).join("; ");
}

/** Totals snapshot ("3 strokes, 1 shape on 2 pages") for surfaces that only
 *  have the AFTER value (event-history one-liners). Format-agnostic. */
export function summarizeInkValue(raw: string | null | undefined): string {
  const decoded = decodeInk(raw);
  const multi = decoded.kind === "pdf" ? decoded.doc : null;
  const notebook = decoded.kind === "page" ? Object.values(notePages(decoded.doc).pages).map((p) => p.doc) : [];
  const docs: InkDocument[] = multi ? Object.values(multi.pages) : notebook;
  const strokes = docs.reduce((n, d) => n + d.strokes.length, 0);
  const shapes = docs.reduce((n, d) => n + (d.shapes?.length ?? 0), 0);
  const parts: string[] = [];
  if (strokes) parts.push(`${strokes} stroke${strokes > 1 ? "s" : ""}`);
  if (shapes) parts.push(`${shapes} shape${shapes > 1 ? "s" : ""}`);
  if (parts.length === 0) return "empty";
  const pageCount = multi ? Object.keys(multi.pages).filter((k) => {
    const pg = multi.pages[Number(k)];
    return inkHasContent(pg);
  }).length : notebook.filter(inkHasContent).length;
  return pageCount > 1 ? `${parts.join(", ")} on ${pageCount} pages` : parts.join(", ");
}
