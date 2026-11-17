// The page envelope of a drawing: every page is `{ key, background, size, doc }`,
// whatever its background is (blank, a PDF page, later a slide). The writing
// layer — strokes, erasure, shapes — is one InkDocument per page in PAGE UNITS
// (`doc.page.width` = 1000 whatever the zoom), the same document a handwriting
// note stores, so one engine loads any page without converting.
//
// Where it lives: a PDF note's `ink_data` envelope carries it in `units`
// (`InkEnvelope.units`) next to the older per-PDF-page fields (`pages` +
// `annotations`), which are still written from it — see the "Two formats"
// section of inkFormat.ts. A handwriting note's `ink_data` IS its first page
// (key `page`), and every further page rides in that document's `morePages`
// (an InkPages without `page`), so an older app opens, edits and saves the first
// page and carries the rest along untouched (Format evolution, rule 1). Its
// InkPages is derived from that value and written back to it (`notePages`,
// `noteDoc`); nothing is stored twice.
//
// Page keys are the ones page_text uses (pageText.ts), so a text box and the
// strokes of one page share an address:
//   pdf:<n>      page n (1-based) of a PDF       background {kind:"pdf", page:n}
//   page         the one page of a handwriting note       {kind:"blank"}
//   slide:<id>   a slide of a deck (reserved)              {kind:"slide", slideId}
//   <uuid>       a further blank page of a notebook        {kind:"blank"}
// Sizes: a PDF page is 1000 wide and 1000·h/w tall; a handwriting page 1000 wide;
// a slide 1920×1080 (not drawn by this version).

import { INK_PAGE_KEY, pdfPageKey } from "./pageText.js";
import type { InkDocument } from "./inkFormat.js";

export type InkBackground =
  | { kind: "blank" }
  | { kind: "pdf"; page: number }
  | { kind: "slide"; slideId: string };

export interface InkPageSize { width: number; height: number }

export interface InkPageRecord {
  key: string;
  /** A newer app's background kind is kept as stored. */
  background: InkBackground | { kind: string };
  /** The page's own size in page units (the engine's `doc.page.width` is `width`). */
  size: InkPageSize;
  doc: InkDocument;
}

/** The pages of one drawing by key. Unknown fields of the envelope and of a
 *  page record travel with it (Format evolution, rule 1). */
export interface InkPages {
  version: 1;
  pages: Record<string, InkPageRecord>;
  /** Page keys top to bottom. Absent (every drawing before notebooks had
   *  several pages), or missing a key: see inkPageOrder. */
  order?: string[];
  /** The `page` of these pages is only a carrier (a notebook whose pages are described by `note_pages`, notePages.ts, has no
   *  first page of its own; `page` is stored empty so an older app can still open the value) and is not one of the pages. */
  carrier?: true;
}

/** A page's width in units: the one every host draws and stores. */
export const INK_PAGE_UNITS = 1000;

/** The height of a handwriting page before it has grown (the engine's minimum). */
export const INK_NOTE_MIN_HEIGHT = 1400;

export const emptyInkPages = (): InkPages => ({ version: 1, pages: {} });

/** The page of a PDF: 1000 units wide, `ratio` = page height / page width. `key`: the page's key when it is not `pdf:<page>`
 *  (a page of a note's page list, notePages.ts, is `<prefix>:<page>`). */
export function pdfPageRecord(page: number, doc: InkDocument, ratio: number, key = pdfPageKey(page)): InkPageRecord {
  return {
    key,
    background: { kind: "pdf", page },
    size: { width: INK_PAGE_UNITS, height: INK_PAGE_UNITS * ratio },
    doc,
  };
}

/** The page number a key addresses, or null when it is not a PDF page key. */
export function pdfPageOfKey(key: string): number | null {
  const m = /^pdf:(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** The keys of `pages` top to bottom: those `order` names first, in its order,
 *  then the rest — `page`, then PDF pages by number, then any other key in
 *  stored order. A key `order` names that has no page is skipped.
 *  `page` of a notebook marked `carrier` is not a page: it is left out. */
export function inkPageOrder(pages: InkPages): string[] {
  const keys = Object.keys(pages.pages).filter((key) => key !== INK_PAGE_KEY || !pages.carrier);
  const named = (pages.order ?? []).filter((key, i, all) => key in pages.pages && all.indexOf(key) === i);
  const rank = (key: string) => (key === INK_PAGE_KEY ? -1 : pdfPageOfKey(key) ?? Number.MAX_SAFE_INTEGER);
  const rest = keys.filter((key) => !named.includes(key)).map((key, i) => ({ key, i }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.i - b.i).map((x) => x.key);
  return [...named, ...rest];
}

/** A blank notebook page: 1000 × INK_NOTE_MIN_HEIGHT units, nothing drawn. */
export function blankPageRecord(key: string): InkPageRecord {
  return {
    key,
    background: { kind: "blank" },
    size: { width: INK_PAGE_UNITS, height: INK_NOTE_MIN_HEIGHT },
    doc: { version: 1, strokes: [], erased: {}, page: { width: INK_PAGE_UNITS } },
  };
}

/** `pages` with a blank page `key` added below the last one. The order is written out in full, so
 *  the new page is last whatever `inkPageOrder` would have said. A key that is already a page is
 *  left as it is. */
export function withPageAppended(pages: InkPages, key: string): InkPages {
  if (key in pages.pages) return pages;
  return { ...pages, pages: { ...pages.pages, [key]: blankPageRecord(key) }, order: [...inkPageOrder(pages), key] };
}

/** `pages` with the drawing of page `key` replaced; its background and size stay. The same object
 *  when `key` is not a page. */
export function withPageDoc(pages: InkPages, key: string, doc: InkDocument): InkPages {
  const record = pages.pages[key];
  if (!record) return pages;
  return { ...pages, pages: { ...pages.pages, [key]: { ...record, doc } } };
}

function contentHeight(doc: InkDocument): number {
  let maxY = 0;
  for (const s of doc.strokes) for (const p of s.points) if (p[1] > maxY) maxY = p[1];
  for (const s of doc.shapes ?? []) maxY = Math.max(maxY, s.start?.[1] ?? 0, s.end?.[1] ?? 0);
  return Math.max(INK_NOTE_MIN_HEIGHT, Math.ceil(maxY));
}

/** A handwriting note's drawing as pages: its first page, key `page`, then
 *  the pages its `morePages` holds. */
export function notePages(doc: InkDocument | null | undefined): InkPages {
  if (!doc) return emptyInkPages();
  const { morePages, ...first } = doc;
  const pages: InkPages = {
    version: 1,
    pages: {
      ...morePages?.pages,
      [INK_PAGE_KEY]: { key: INK_PAGE_KEY, background: { kind: "blank" }, size: { width: first.page.width, height: contentHeight(first) }, doc: first },
    },
  };
  if (morePages?.order) pages.order = morePages.order;
  if (morePages?.carrier) pages.carrier = true;
  return pages;
}

/** The drawing a handwriting note stores: its `page`, with every other page in
 *  `morePages` (null when it has no page at all). Pages but no `page` (a notebook whose first page is a PDF's): an empty
 *  carrier `page` is stored and `morePages` is marked `carrier`, which is what keeps it from being shown. */
export function noteDoc(pages: InkPages): InkDocument | null {
  const rest = Object.fromEntries(Object.entries(pages.pages).filter(([key]) => key !== INK_PAGE_KEY));
  const carrier = !pages.pages[INK_PAGE_KEY] && (pages.carrier === true || Object.keys(rest).length > 0);
  const first = pages.pages[INK_PAGE_KEY]?.doc ?? (carrier ? blankPageRecord(INK_PAGE_KEY).doc : null);
  if (!first) return null;
  const doc: InkDocument = { ...first };
  delete doc.morePages;
  // An app from before this format would show the empty carrier as a page and, saving it, drop the `carrier` mark: it must open
  // such a drawing read-only (the `requires` rule of ink.ts), so a notebook is never saved by one that cannot keep it.
  if (carrier) doc.requires = [...new Set([...(doc.requires ?? []), CARRIER_FEATURE])];
  if (Object.keys(rest).length === 0 && !pages.order && !carrier) return doc;
  const more: InkPages = { version: 1, pages: rest };
  if (pages.order) more.order = pages.order.filter((key) => !carrier || key !== INK_PAGE_KEY);
  if (carrier) more.carrier = true;
  return { ...doc, morePages: more };
}

/** The `requires` name of a drawing whose first page is a carrier (known to INK_KNOWN_FEATURES of this version on). */
const CARRIER_FEATURE = "note-pages";

// ── Does `units` still describe the older fields? ──────────────────────────
// An older app that edits a PDF note changes `pages` / `annotations` and keeps
// `units` as it found it, so `units` can be older than them. `unitsFrom` is the
// fingerprint of the older fields `units` was written with; a reader trusts
// `units` only while it still matches (otherwise it converts the older fields).

/** Stable JSON: object keys sorted, so a re-encoded value hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** cyrb53: a 53-bit string hash, as two 32-bit halves. */
function hash53(text: string): [number, number] {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return [h1 >>> 0, h2 >>> 0];
}

type LegacyFields = { pages?: Record<number, InkDocument>; annotations?: Array<{ id: string; type?: unknown }> };

/** What identifies a stroke: strokes are immutable once committed, so its id,
 *  style and extent say everything an edit could change (the points themselves
 *  are not hashed: a save of a long drawing would cost more than the drawing). */
function strokeKey(s: { id?: unknown; color?: unknown; size?: unknown; toolId?: unknown; points?: unknown }): unknown {
  const pts = Array.isArray(s.points) ? s.points : [];
  return [s.id, s.color, s.size, s.toolId, pts.length, pts[0], pts[pts.length - 1]];
}

/** A drawing record without its points (see strokeKey); any other record whole. */
function recordKey(r: Record<string, unknown>): unknown {
  const content = r.content as Record<string, unknown> | undefined;
  if (!content || !Array.isArray(content.strokes)) return r;
  return { ...r, content: { ...content, strokes: content.strokes.map(strokeKey) } };
}

/** Fingerprint of what the older fields say about drawings: every page's
 *  strokes, erasure and shapes, and the drawing and shape records (not the text
 *  and area records). Independent of order. */
export function legacyFingerprint(env: LegacyFields): string {
  let count = 0, a = 0, b = 0;
  const add = (text: string) => {
    const [h1, h2] = hash53(text);
    count++;
    a = (a + h1) >>> 0;
    b = (b + h2) >>> 0;
  };
  for (const [n, page] of Object.entries(env.pages ?? {})) {
    for (const s of page.strokes ?? []) add(`s${n}${canonical(strokeKey(s))}`);
    for (const s of page.shapes ?? []) add(`h${n}${canonical(s)}`);
    for (const [id, iv] of Object.entries(page.erased ?? {})) add(`e${n}${id}${canonical(iv)}`);
  }
  for (const r of env.annotations ?? []) if (r && (r.type === "drawing" || r.type === "shape")) add(`a${canonical(recordKey(r as Record<string, unknown>))}`);
  return `${count.toString(36)}.${a.toString(36)}.${b.toString(36)}`;
}

/** The pages of `env.units`, or null when there are none or they no longer
 *  match the older fields. */
export function currentUnits(env: LegacyFields & { units?: InkPages; unitsFrom?: string }): InkPages | null {
  return env.units && env.unitsFrom === legacyFingerprint(env) ? env.units : null;
}
