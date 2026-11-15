// What a save changed in a handwriting note, for History: a count in words ("added 12, erased 3") and the
// picture of just that change. Two saves of one `ink_data` are compared page by page (a handwriting note
// has its pages, a PDF note one per PDF page) with the same set arithmetic the app uses (inkDiff.ts):
// strokes and shapes by id, erasure by interval. Pure; the server counts, the app draws the picture.

import { diffInk } from "./inkDiff.js";
import type { InkDiff } from "./inkDiff.js";
import { decodeInk } from "./inkFormat.js";
import type { InkDocument, InkShape, InkStroke } from "./inkFormat.js";
import { inkPageOrder, notePages } from "./inkPages.js";

export type InkChangeSummary = {
  /** Strokes and shapes drawn. */
  added: number;
  /** Strokes and shapes taken out whole, plus strokes partly erased (a stroke counts once however many spans). */
  erased: number;
};

/** The drawing's pages top to bottom, by key: a handwriting note's in page
 *  order, a PDF's by page number. */
const pagesOf = (raw: string | null | undefined): Map<string, InkDocument> => {
  const decoded = decodeInk(raw);
  if (decoded.kind === "page") {
    const pages = notePages(decoded.doc);
    return new Map(inkPageOrder(pages).map((key) => [key, pages.pages[key]!.doc]));
  }
  if (decoded.kind === "pdf") {
    return new Map(Object.keys(decoded.doc.pages).map(Number).sort((a, b) => a - b).map((n) => [String(n), decoded.doc.pages[n]!]));
  }
  return new Map();
};

const EMPTY_PAGE: InkDocument = { version: 1, strokes: [], erased: {}, page: { width: 1 } };

type PageChange = { page: string; before: InkDocument | null; after: InkDocument; diff: InkDiff; summary: InkChangeSummary };

function summaryOf(before: InkDocument | null, after: InkDocument, diff: InkDiff): InkChangeSummary {
  // A stroke drawn and partly erased within the change counts as drawn only.
  const kept = new Set(before?.strokes.map((s) => s.id));
  const partlyErased = Object.keys(diff.newlyErased).filter((id) => kept.has(id) && after.strokes.some((s) => s.id === id));
  return {
    added: diff.addedStrokes.length + diff.addedShapes.length,
    erased: diff.removedStrokes.length + diff.removedShapes.length + partlyErased.length,
  };
}

/** Every page with a change, in page order. */
function changedPages(before: string | null | undefined, after: string | null | undefined): PageChange[] {
  const was = pagesOf(before);
  const now = pagesOf(after);
  const out: PageChange[] = [];
  for (const page of new Set([...now.keys(), ...was.keys()])) {
    const b = was.get(page) ?? null;
    const a = now.get(page) ?? EMPTY_PAGE;
    const diff = diffInk(b, a);
    const summary = summaryOf(b, a, diff);
    if (summary.added + summary.erased > 0) out.push({ page, before: b, after: a, diff, summary });
  }
  return out;
}

/** How many strokes and shapes `after` drew and erased against `before` (null: nothing was drawn yet),
 *  all pages added up. An unreadable value counts as an empty drawing. */
export function inkChangeSummary(before: string | null | undefined, after: string | null | undefined): InkChangeSummary {
  const total: InkChangeSummary = { added: 0, erased: 0 };
  for (const { summary } of changedPages(before, after)) {
    total.added += summary.added;
    total.erased += summary.erased;
  }
  return total;
}

/** What the picture shows of strokes that are gone: pale grey, so the drawn part stands out. */
const GONE_COLOR = "rgba(148,163,184,0.5)";

/** One page showing only the change: what was drawn in its own colours on top of what was erased in pale
 *  grey (a stroke as it was before; a stroke only partly erased shows whole). The rest of the drawing is
 *  left out. With several changed pages, the one that changed most. null when nothing changed. */
export function inkChangeView(before: string | null | undefined, after: string | null | undefined): InkDocument | null {
  const pages = changedPages(before, after);
  if (pages.length === 0) return null;
  const { before: was, after: now, diff } = pages.reduce((best, p) => (p.summary.added + p.summary.erased > best.summary.added + best.summary.erased ? p : best));
  const wasStrokes = new Map((was?.strokes ?? []).map((s) => [s.id, s]));
  const gone: InkStroke[] = [
    ...diff.removedStrokes,
    ...Object.keys(diff.newlyErased).flatMap((id) => wasStrokes.get(id) ?? []).filter((s) => now.strokes.some((n) => n.id === s.id)),
  ].map((s) => ({ ...s, color: GONE_COLOR }));
  const goneShapes: InkShape[] = diff.removedShapes.map((s) => ({ ...s, color: GONE_COLOR }));
  const erased = { ...Object.fromEntries(gone.flatMap((s) => (was?.erased[s.id] ? [[s.id, was.erased[s.id]!]] : []))) };
  for (const s of diff.addedStrokes) if (now.erased[s.id]) erased[s.id] = now.erased[s.id]!;
  return {
    version: 1,
    strokes: [...gone, ...diff.addedStrokes],
    erased,
    shapes: [...goneShapes, ...diff.addedShapes],
    page: now.page,
  };
}
