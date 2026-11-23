// Strokes just finished on a page, as a drawing in the surface's own format that holds only them: what the surface's
// saver keeps on the device at pen-up (lib/ink/surfaceSaver keepAdded) and, should the page die before its save, what is
// sent as a save made from nothing. The server merges that the way it merges any save (@onden/markdown/ink mergeInk):
// what it holds stays, these strokes are added (test/inkAdditionsMerge.test.ts). The cost is the size of what was added,
// never of the whole drawing: nothing here reads or copies the other strokes. A PDF note's envelope: lib/pdf pdfWithOnly.

import type { InkPages } from "@onden/markdown/ink";
import { INK_PAGE_KEY } from "@onden/markdown/page-text";
import type { InkDocument, InkShape, InkStroke } from "./types";

export type InkAdded = { strokes: InkStroke[]; shapes: InkShape[] };

/** One page (a board's pen layer, a page of a notebook) holding only `added`, with the page's own settings (`page`), so the
 *  merge sees them unchanged. */
export function pageWithOnly(page: InkDocument["page"], added: InkAdded): InkDocument {
  return { version: 1, strokes: added.strokes, erased: {}, page, ...(added.shapes.length ? { shapes: added.shapes } : {}) };
}

/** A handwriting note's pages holding only `added` on page `key` (its first page kept, empty, so the note's own first page
 *  merges as unchanged); the records are the note's own, so their settings and order merge as unchanged. The host stores
 *  pages the way it stores its own (noteDoc, or a page list's pagesToStore first). */
export function notebookWithOnly(pages: InkPages, key: string, added: InkAdded): InkPages | null {
  const record = pages.pages[key];
  if (!record) return null;
  const blank = (doc: InkDocument): InkDocument => ({ version: 1, strokes: [], erased: {}, page: doc.page });
  const first = pages.pages[INK_PAGE_KEY];
  return {
    ...pages,
    pages: {
      ...(first && key !== INK_PAGE_KEY ? { [INK_PAGE_KEY]: { ...first, doc: blank(first.doc) } } : {}),
      [key]: { ...record, doc: pageWithOnly(record.doc.page, added) },
    },
  };
}
