// A note whose pages are listed in `note_pages` (@onden/markdown/note-pages), as the page book shows and saves it. Pure.
//
//   list (note_pages) + the strokes stored in note_ink + what is known of each PDF file (page count and page shapes)
//     → the pages to show: one record per page, in the list's order (a PDF page at its file's shape, a blank page as stored);
//   the pages as edited → the pages to store: only pages that have strokes (an empty page has no record in note_ink), in the
//     list's order, under a carrier first page (no page of its own, notePages in inkPages.ts).
//
// A PDF file that is not on this device (its page count is unknown) cannot say which pages a run to its end has: the pages of
// that run that already have strokes are still listed (they are in note_ink), and kept when saving, so a save made without the
// file never drops strokes.
//
// A save never deletes a page's strokes because the list does not name the page (another device took the page out of the list
// while someone drew on it; the list write was refused or lost; the notebook had pages of its own before it had a list): such a
// page is shown after the listed ones, labelled "not in the page list" (`unlisted`), and kept as stored. Strokes leave a note_ink
// only when the person who drew them removes them on their own screen.

import { expandNotePages, notePagesFiles, parsePdfPageKey, type NotePageEntry, type NotePages } from "@onden/markdown/note-pages";
import { INK_PAGE_KEY } from "@onden/markdown/page-text";
import { blankPageRecord, inkHasContent, inkPageOrder, pdfPageRecord, type InkPageRecord, type InkPages, type InkPageSize } from "@onden/markdown/ink";

interface FileShape { count: number; ratio(n: number): number }
export type FileState = { status: "loading" } | { status: "missing" } | { status: "ready"; shape: FileShape };

interface NoteBook {
  /** The pages to show; its `order` is the list's. */
  pages: InkPages;
  /** What is behind each page: for a PDF page, its file and its number in it. */
  entries: Map<string, NotePageEntry>;
  /** The size the file decides for each PDF page. */
  sizes: Record<string, InkPageSize>;
  /** Pages that have strokes (or are a notebook's own first page) but are not in the list; shown after the listed ones. */
  unlisted: Set<string>;
  /** Files that could not be opened here. */
  missing: string[];
  /** Every file is either open or known to be missing: the pages can be laid out. */
  settled: boolean;
}

export function buildNoteBook(list: NotePages, stored: InkPages, files: Readonly<Record<string, FileState>>): NoteBook {
  const states = notePagesFiles(list).map((file) => files[file] ?? { status: "loading" as const });
  const settled = states.every((s) => s.status !== "loading");
  const missing = notePagesFiles(list).filter((file) => files[file]?.status === "missing");
  const shapeOf = (file: string) => { const s = files[file]; return s?.status === "ready" ? s.shape : null; };
  const { entries: expanded } = expandNotePages(list, (file) => shapeOf(file)?.count ?? null);

  const entries = new Map<string, NotePageEntry>();
  const sizes: Record<string, InkPageSize> = {};
  const records: Record<string, InkPageRecord> = {};
  const order: string[] = [];
  const show = (entry: NotePageEntry, record: InkPageRecord) => { entries.set(entry.key, entry); records[entry.key] = record; order.push(entry.key); };
  // Pages of runs whose file is not open: those that have strokes.
  const unresolvedByRun = new Map<string, NotePageEntry[]>();
  for (const run of list.runs) {
    if (run.kind !== "pdf" || shapeOf(run.file)) continue;
    const prefix = run.keyPrefix ?? run.id;
    const found = Object.keys(stored.pages)
      .map((key) => ({ key, n: parsePdfPageKey(key)?.prefix === prefix ? parsePdfPageKey(key)!.page : NaN }))
      .filter(({ n }) => Number.isInteger(n) && n >= run.from && (run.to === null || n <= run.to))
      .sort((x, y) => x.n - y.n)
      .map(({ key, n }): NotePageEntry => ({ key, runId: run.id, pdf: { file: run.file, page: n } }));
    unresolvedByRun.set(run.id, found);
  }
  for (const run of list.runs) {
    const mine = run.kind === "blank" ? expanded.filter((e) => e.key === run.id) : expanded.filter((e) => e.runId === run.id);
    for (const entry of mine) {
      const record = stored.pages[entry.key];
      if (!entry.pdf) { show(entry, record ? { ...record, key: entry.key, background: { kind: "blank" } } : blankPageRecord(entry.key)); continue; }
      const shape = shapeOf(entry.pdf.file);
      if (!shape) continue; // its file is not open: the pages of it that have strokes are listed below
      const doc = record?.doc ?? blankPageRecord(entry.key).doc;
      const shown = pdfPageRecord(entry.pdf.page, doc, shape.ratio(entry.pdf.page), entry.key);
      sizes[entry.key] = shown.size;
      show(entry, shown);
    }
    for (const entry of unresolvedByRun.get(run.id) ?? []) {
      const record = stored.pages[entry.key]!;
      show(entry, { ...record, key: entry.key });
    }
  }
  // Strokes the list does not name: shown, not hidden. The carrier `page` is not a page unless something was drawn on it.
  const unlisted = new Set<string>();
  const first = stored.pages[INK_PAGE_KEY];
  const candidates = [...(first && (!stored.carrier || inkHasContent(first.doc)) ? [INK_PAGE_KEY] : []), ...inkPageOrder(stored).filter((key) => key !== INK_PAGE_KEY)];
  for (const key of candidates) {
    if (order.includes(key) || !stored.pages[key]) continue;
    unlisted.add(key);
    records[key] = stored.pages[key]!;
    order.push(key);
  }
  return { pages: { version: 1, pages: records, order, carrier: true }, entries, sizes, unlisted, missing, settled };
}

/** The pages to store for the pages as edited: the listed ones that have strokes, in the list's order, a PDF page at its file's shape;
 *  the unlisted ones as they are; any other page the person drew on. A page is left out only when it has no strokes and the list
 *  names it (an empty page has no record in note_ink), never because the list does not name it. */
export function pagesToStore(edited: InkPages, book: NoteBook): InkPages {
  const kept: string[] = [];
  const records: Record<string, InkPageRecord> = {};
  for (const key of edited.order ?? []) {
    const record = edited.pages[key];
    if (!record || key === INK_PAGE_KEY && !book.unlisted.has(key)) continue;
    if (!book.unlisted.has(key) && !inkHasContent(record.doc)) continue;
    records[key] = book.sizes[key] ? { ...record, size: book.sizes[key]! } : record;
    kept.push(key);
  }
  return { version: 1, pages: records, order: kept, carrier: true };
}
