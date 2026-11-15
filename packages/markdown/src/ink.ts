// The stored drawing format (`ink_data`) and its three-way merge — one module
// for the app (lib/ink, which draws and saves it) and the server (which merges
// a save into what another device stored meanwhile, services/attributeWrites).
// Pure: no DOM, no pipeline imports, so the backend and any bundle can load it
// (`@onden/markdown/ink`).
//
// ink_data holds one of two shapes: a single page (handwriting note, canvas
// layer) or the PDF envelope {version:1, pages, annotations} — the PDF's
// per-page strokes AND its highlight/drawing records, so one PDF edit is one
// attribute write.
//
// The model is append-shaped by construction: strokes and shapes are
// immutable once committed (added or removed whole, by id) and erasure only
// adds dead index intervals. So two saves made from the same base merge
// exactly: strokes/shapes/records three-way by id, erasure as interval sets.
//
// The stored format itself (types, decode/encode) is inkFormat.ts and the
// drawing as a picture (stroke outlines, the static SVG) is inkSvg.ts; both
// are re-exported here so `@onden/markdown/ink` is the one ink entry.
//
// ── Format evolution (T1-0): an old app must never destroy a newer one's data ─
// Offline installs lag by weeks, so a reader regularly loads, edits and saves a
// drawing written by a newer version. The rules:
//   1. PRESERVE. An unknown stroke `toolId`, shape `kind`, or field at any level
//      (stroke, shape, page, document, PDF envelope) is kept exactly as stored
//      through decode → encode and through mergeInk. Unknown fields of an item
//      travel with the item; unknown document / page / envelope fields merge as
//      plain values, three-way (incoming wins when both sides changed one).
//      Rendering may DEGRADE (an unknown tool draws as a pen, an unknown shape
//      kind is skipped) but the stored data is never rewritten or dropped —
//      a rewrite would read as "changed on this side" and win the merge.
//      Only malformed values (wrong types, NaN) are still repaired or dropped,
//      and only known fields ever reach the SVG, with colours through SAFE_COLOR.
//   2. `features` / `requires`. A document (and the PDF envelope, and each of
//      its pages) may carry two string lists:
//        features — everything the writer used (informational, grows only);
//        requires — the subset a reader MUST understand to edit the drawing
//                   without damaging it (e.g. strokes whose meaning depends on
//                   a new field). Always a subset of `features` by convention.
//      A reader that finds a name in `requires` outside INK_KNOWN_FEATURES opens
//      the drawing READ-ONLY (isInkReadOnly): it renders it and never saves it.
//      An unknown name in `features` alone changes nothing — rule 1 already
//      keeps that data safe. A writer adds to `requires` only when preserving
//      is NOT enough for an old editor to stay correct. Merging unions both lists.
//      This version writes neither list, so existing data is unaffected;
//      INK_KNOWN_FEATURES is the set this version can edit (today: none yet).

import { mergeById, sameJson } from "./jsonMerge.js";
import { emptyInkPages, legacyFingerprint } from "./inkPages.js";
import { INK_PAGE_KEY } from "./pageText.js";
import type { InkPageRecord, InkPages } from "./inkPages.js";
import { INK_DEFAULT_PAGE_WIDTH, decodeInk, encodeInk, isRecord, mergeIntervals, subtractIntervals } from "./inkFormat.js";
import type { EraseInterval, ErasedIntervals, InkDocument, InkEnvelope } from "./inkFormat.js";

export {
  emptyInkPages, pdfPageRecord, pdfPageOfKey, inkPageOrder, notePages, noteDoc, blankPageRecord, withPageAppended, withPageDoc, legacyFingerprint, currentUnits, INK_PAGE_UNITS, INK_NOTE_MIN_HEIGHT,
  type InkBackground, type InkPageSize, type InkPageRecord, type InkPages,
} from "./inkPages.js";
export {
  INK_DEFAULT_PAGE_WIDTH, INK_KNOWN_FEATURES, inkUnknownRequirements, isInkReadOnly, inkHasContent, mergeIntervals, decodeInk, encodeInk,
} from "./inkFormat.js";
export { INK_DATA_ATTR, BOARD_INK_ATTR, NOTE_INK_ATTR, HANDWRITING_LAYOUT, INK_PAGE_ATTRS, isInkPageAttr, INK_SHAPE_KINDS, INK_KINDS, INK_KIND_ATTR, isInkKind, type InkKind } from "./sharedContract.js";
export { diffInk, isEmptyInkDiff, type InkDiff } from "./inkDiff.js";
export { inkChangeSummary, inkChangeView, type InkChangeSummary } from "./inkChange.js";
export { INK_REGION_MIN, clampInkRegion, formatInkRegion, parseInkRegion, type InkRegion } from "./inkRegion.js";
export { INK_SHAPE_FILL_ALPHA, INK_SHAPE_MIN_SIDE, inkShapeFillPolygon, inkShapeIsDrawable, inkShapeIsFilled, inkShapePathD, inkShapePolylines } from "./inkShapes.js";
export type { ShapePoint, ShapePolyline } from "./inkShapes.js";
export type {
  InkPoint, InkToolId, InkStroke, EraseInterval, ErasedIntervals, InkPage, InkShapeKind, InkShapeFill, InkShape, InkDocument,
  InkAnnotation, InkEnvelope, DecodedInk,
} from "./inkFormat.js";

// ── Three-way merge ────────────────────────────────────────────────────────

/** Something both sides changed differently. The merge still decides (the
 *  incoming save wins, nothing is dropped that either side changed); the
 *  caller records it so a person can look. */
export type InkMergeConflict = {
  /** stroke / shape / annotation: one item by id; page: a page's settings
   *  (width, background); format: stored and incoming are different shapes
   *  (page vs PDF envelope), so the incoming value replaced the stored one. */
  kind: "stroke" | "shape" | "annotation" | "page" | "format";
  id?: string;
  /** The PDF page the item is on. */
  page?: number;
  /** The handwriting page the item is on when it is not the first (its key in
   *  `morePages`). */
  pageKey?: string;
};

export type InkMergeResult = { value: string; conflicts: InkMergeConflict[] };

type Located = Omit<InkMergeConflict, "kind" | "id">;

/** mergeById (jsonMerge.ts) for one kind of item, each conflict located. */
function mergeItems<T extends { id: string }>(
  base: readonly T[], stored: readonly T[], incoming: readonly T[],
  kind: InkMergeConflict["kind"], at: Located, conflicts: InkMergeConflict[],
): T[] {
  return mergeById(base, stored, incoming, (id) => conflicts.push({ kind, id, ...at }));
}

/** Points covered by both sorted interval lists. */
function intersect(a: EraseInterval[], b: EraseInterval[]): EraseInterval[] {
  const out: EraseInterval[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]![0], b[j]![0]);
    const end = Math.min(a[i]![1], b[j]![1]);
    if (start <= end) out.push([start, end]);
    if (a[i]![1] < b[j]![1]) i++; else j++;
  }
  return out;
}

const intervalsOf = (erased: ErasedIntervals, id: string): EraseInterval[] =>
  Array.isArray(erased[id]) ? mergeIntervals(erased[id]!.filter((iv) => Array.isArray(iv) && iv.length === 2) as EraseInterval[]) : [];

/** Erasure as point sets: what either side newly erased, plus what the base
 *  had erased and neither side restored (undo of an erase is a removal). */
function mergeErased(base: ErasedIntervals, stored: ErasedIntervals, incoming: ErasedIntervals, strokeIds: Iterable<string>): ErasedIntervals {
  const out: ErasedIntervals = {};
  for (const id of strokeIds) {
    const b = intervalsOf(base, id), s = intervalsOf(stored, id), i = intervalsOf(incoming, id);
    const merged = mergeIntervals([...intersect(intersect(b, s), i), ...subtractIntervals(s, b), ...subtractIntervals(i, b)]);
    if (merged.length > 0) out[id] = merged;
  }
  return out;
}

/** A plain value (a page's settings) three ways: the side that changed it;
 *  incoming when both did, reported. */
function mergeValue<T>(base: T, stored: T, incoming: T, conflict: () => void): T {
  if (sameJson(incoming, base)) return stored;
  if (!sameJson(stored, base) && !sameJson(stored, incoming)) conflict();
  return incoming;
}

function emptyPage(width = INK_DEFAULT_PAGE_WIDTH): InkDocument {
  return { version: 1, strokes: [], erased: {}, page: { width } };
}

const union = (...lists: Array<readonly string[] | undefined>): string[] | undefined =>
  lists.some(Array.isArray) ? [...new Set(lists.flatMap((l) => l ?? []))] : undefined;

/** Fields this version does not manage, merged as plain values three-way (the
 *  side that changed one wins; incoming when both did). `managed` are the keys
 *  the caller merges itself. Applied to `target` in place. */
function mergeUnknownFields(
  target: Record<string, unknown>, base: object, stored: object, incoming: object, managed: ReadonlySet<string>,
): void {
  const b = base as Record<string, unknown>, s = stored as Record<string, unknown>, i = incoming as Record<string, unknown>;
  for (const key of new Set([...Object.keys(b), ...Object.keys(s), ...Object.keys(i)])) {
    if (managed.has(key)) continue;
    const value = mergeValue(b[key], s[key], i[key], () => {});
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
}

const UNITS_MANAGED: ReadonlySet<string> = new Set(["version", "pages"]);
const RECORD_MANAGED: ReadonlySet<string> = new Set(["key", "background", "size", "doc"]);
const PAGE_MANAGED: ReadonlySet<string> = new Set(["version", "strokes", "erased", "page", "shapes", "morePages", "features", "requires"]);
const MORE_MANAGED: ReadonlySet<string> = new Set(["version", "pages", "order"]);
const ENVELOPE_MANAGED: ReadonlySet<string> = new Set(["version", "pages", "annotations", "units", "unitsFrom", "features", "requires"]);

function mergeFeatureLists(target: { features?: string[]; requires?: string[] }, base: typeof target, stored: typeof target, incoming: typeof target): void {
  for (const key of ["features", "requires"] as const) {
    const merged = union(incoming[key], stored[key], base[key]);
    if (merged) target[key] = merged;
    else delete target[key];
  }
}

function mergePage(base: InkDocument, stored: InkDocument, incoming: InkDocument, at: Located, conflicts: InkMergeConflict[]): InkDocument {
  const strokes = mergeItems(base.strokes, stored.strokes, incoming.strokes, "stroke", at, conflicts);
  const hasShapes = [base, stored, incoming].some((d) => Array.isArray(d.shapes));
  const shapes = hasShapes ? mergeItems(base.shapes ?? [], stored.shapes ?? [], incoming.shapes ?? [], "shape", at, conflicts) : undefined;
  const page = mergeValue(base.page, stored.page, incoming.page, () => conflicts.push({ kind: "page", ...at }));
  const erased = mergeErased(base.erased, stored.erased, incoming.erased, strokes.map((s) => s.id));
  const merged: InkDocument = { ...incoming, version: 1, strokes, erased, page };
  if (shapes) merged.shapes = shapes;
  else delete merged.shapes;
  mergeUnknownFields(merged as unknown as Record<string, unknown>, base, stored, incoming, PAGE_MANAGED);
  mergeFeatureLists(merged, base, stored, incoming);
  return merged;
}

/** The pages `side`'s `units` stand for, or null when they are not known to
 *  match its older fields. A side that wrote its `units` (their fingerprint
 *  matches its older fields) stands for them; one whose older fields are the
 *  base's changed nothing there, so it stands for the base's pages (whatever
 *  stale `units` it carries). Anything else edited the older fields without
 *  touching `units` (an older app). */
function unitsOf(side: InkEnvelope, base: InkEnvelope): InkPages | null {
  const mine = legacyFingerprint(side);
  if (side.units && side.unitsFrom === mine) return side.units;
  const was = legacyFingerprint(base);
  if (mine !== was) return null;
  if (base.units && base.unitsFrom === was) return base.units;
  // Computed here, not at module load: a top-level call would keep this module's imports in a bundle that only wants its re-exports.
  return was === legacyFingerprint({}) ? emptyInkPages() : null;
}

function emptyRecord(key: string, from: InkPageRecord): InkPageRecord {
  return { key, background: from.background, size: from.size, doc: emptyPage(from.doc.page.width) };
}

/** `units` of the merged envelope (`merged` already holds the merged older
 *  fields). Pages merge by key, a page's strokes and shapes by id like any
 *  other drawing; two sides that cannot both be trusted leave `units` stale
 *  (`unitsFrom` dropped), so readers convert the merged older fields instead,
 *  which hold everything either side drew. Conflicts are reported by the older
 *  fields, not twice. */
function mergeUnits(base: InkEnvelope, stored: InkEnvelope, incoming: InkEnvelope, merged: InkEnvelope): void {
  if (![base, stored, incoming].some((d) => d.units)) return;
  const b = unitsOf(base, base), s = unitsOf(stored, base), i = unitsOf(incoming, base);
  if (!b || !s || !i) {
    if (incoming.units) merged.units = incoming.units; else delete merged.units;
    delete merged.unitsFrom;
    return;
  }
  const pages: InkPages["pages"] = {};
  const quiet: InkMergeConflict[] = [];
  for (const key of new Set([...Object.keys(s.pages), ...Object.keys(i.pages)])) {
    pages[key] = mergeRecord(key, b.pages[key], s.pages[key], i.pages[key], {}, quiet);
  }
  merged.units = { ...i, version: 1, pages };
  mergeUnknownFields(merged.units as unknown as Record<string, unknown>, b, s, i, UNITS_MANAGED);
  merged.unitsFrom = legacyFingerprint(merged);
}

/** One page record three ways (its drawing by id, its settings as values). */
function mergeRecord(key: string, br: InkPageRecord | undefined, sr: InkPageRecord | undefined, ir: InkPageRecord | undefined,
  at: Located, conflicts: InkMergeConflict[]): InkPageRecord {
  const from = (ir ?? sr)!;
  const blank = () => emptyRecord(key, from).doc;
  const record: InkPageRecord = {
    ...from,
    background: mergeValue(br?.background ?? from.background, sr?.background ?? from.background, ir?.background ?? from.background, () => {}),
    size: mergeValue(br?.size ?? from.size, sr?.size ?? from.size, ir?.size ?? from.size, () => {}),
    doc: mergePage(br?.doc ?? blank(), sr?.doc ?? blank(), ir?.doc ?? blank(), at, conflicts),
  };
  mergeUnknownFields(record as unknown as Record<string, unknown>, br ?? {}, sr ?? {}, ir ?? {}, RECORD_MANAGED);
  return record;
}

/** A handwriting note's further pages three ways, by key. A page either side
 *  added stays; a page one side removed goes when the other left it as the
 *  base had it, and stays whole as the other side has it when that side drew
 *  on it (nothing drawn is lost). A page both kept merges like the first page,
 *  its conflicts located by `pageKey`. `order` is one value: the side that
 *  changed it, incoming when both did; keys of pages that went are dropped. */
function mergeMorePages(base: InkPages | undefined, stored: InkPages | undefined, incoming: InkPages | undefined,
  conflicts: InkMergeConflict[]): InkPages | undefined {
  if (!base && !stored && !incoming) return undefined;
  const b = base?.pages ?? {}, s = stored?.pages ?? {}, i = incoming?.pages ?? {};
  const pages: InkPages["pages"] = {};
  for (const key of new Set([...Object.keys(s), ...Object.keys(i)])) {
    const br = b[key], sr = s[key], ir = i[key];
    if (br && (!sr || !ir)) {
      const kept = (sr ?? ir)!;
      if (!sameJson(kept, br)) pages[key] = kept;
      continue;
    }
    pages[key] = mergeRecord(key, br, sr, ir, { pageKey: key }, conflicts);
  }
  const out: InkPages = { ...(incoming ?? stored), version: 1, pages };
  mergeUnknownFields(out as unknown as Record<string, unknown>, base ?? {}, stored ?? {}, incoming ?? {}, MORE_MANAGED);
  const order = mergeValue(base?.order, stored?.order, incoming?.order, () => {});
  if (order) out.order = order.filter((key) => key === INK_PAGE_KEY || key in pages);
  else delete out.order;
  return Object.keys(pages).length > 0 || out.order ? out : undefined;
}

/** A handwriting note's stored document three ways: its first page, then its
 *  further pages. */
function mergeNote(base: InkDocument, stored: InkDocument, incoming: InkDocument, conflicts: InkMergeConflict[]): InkDocument {
  const merged = mergePage(base, stored, incoming, {}, conflicts);
  const more = mergeMorePages(base.morePages, stored.morePages, incoming.morePages, conflicts);
  if (more) merged.morePages = more;
  else delete merged.morePages;
  return merged;
}

function mergeEnvelope(base: InkEnvelope, stored: InkEnvelope, incoming: InkEnvelope, conflicts: InkMergeConflict[]): InkEnvelope {
  const pages: InkEnvelope["pages"] = {};
  const numbers = new Set([...Object.keys(stored.pages), ...Object.keys(incoming.pages)].map(Number));
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const s = stored.pages[n], i = incoming.pages[n];
    const width = (i ?? s)!.page.width;
    pages[n] = mergePage(base.pages[n] ?? emptyPage(width), s ?? emptyPage(width), i ?? emptyPage(width), { page: n }, conflicts);
  }
  // A side without records (an envelope saved before they moved in) did not
  // change them: read it as the base's, never as "all removed".
  const baseRecords = base.annotations ?? [];
  const storedRecords = stored.annotations ?? baseRecords;
  const incomingRecords = incoming.annotations ?? baseRecords;
  const hasRecords = [base, stored, incoming].some((d) => Array.isArray(d.annotations));
  const merged: InkEnvelope = { ...incoming, version: 1, pages };
  if (hasRecords) merged.annotations = mergeItems(baseRecords, storedRecords, incomingRecords, "annotation", {}, conflicts);
  mergeUnknownFields(merged as unknown as Record<string, unknown>, base, stored, incoming, ENVELOPE_MANAGED);
  mergeFeatureLists(merged, base, stored, incoming);
  mergeUnits(base, stored, incoming, merged);
  return merged;
}

/** Merge a drawing save into what is stored. `base` is the drawing the
 *  incoming save was made from (what its device loaded or last saved); `stored`
 *  is the current value, which another device may have changed since. Strokes,
 *  shapes and highlight records merge three-way by id and erasure as interval
 *  sets, so a stroke drawn on either device survives and a stroke undone on
 *  one stays gone. Pure and deterministic. Values that are not the same kind
 *  of drawing (a page against a PDF envelope) cannot merge: the incoming value
 *  is kept and a "format" conflict reported. An unreadable or empty base
 *  merges as an empty drawing (keep everything either side has). */
export function mergeInk(base: string | null | undefined, stored: string | null | undefined, incoming: string): InkMergeResult {
  const conflicts: InkMergeConflict[] = [];
  const s = decodeInk(stored);
  const i = decodeInk(incoming);
  if (i.kind === "none" || s.kind === "none") return { value: incoming, conflicts };
  if (s.kind !== i.kind) return { value: incoming, conflicts: [{ kind: "format" }] };
  const b = decodeInk(base);
  if (i.kind === "page" && s.kind === "page") {
    const from = b.kind === "page" ? b.doc : emptyPage(i.doc.page.width);
    return { value: encodeInk(mergeNote(from, s.doc, i.doc, conflicts)), conflicts };
  }
  if (i.kind === "pdf" && s.kind === "pdf") {
    const from: InkEnvelope = b.kind === "pdf" ? b.doc : { version: 1, pages: {} };
    return { value: encodeInk(mergeEnvelope(from, s.doc, i.doc, conflicts)), conflicts };
  }
  return { value: incoming, conflicts };
}

// ── Reverting a merge conflict ─────────────────────────────────────────────

/** The overridden side's version of `id` in place of the merged one: swapped
 *  in place, removed when that side had none, appended when only it had it. */
function takeItem<T extends { id: string }>(merged: readonly T[], overridden: readonly T[], id: string): T[] {
  const theirs = overridden.find((item) => isRecord(item) && item.id === id);
  const at = merged.findIndex((item) => isRecord(item) && item.id === id);
  if (at < 0) return theirs ? [...merged, theirs] : [...merged];
  const out = [...merged];
  if (theirs) out[at] = theirs;
  else out.splice(at, 1);
  return out;
}

/** One conflict on one page: the stroke (with its erasure), the shape, or the
 *  page settings as the overridden side had them. */
function revertOnPage(page: InkDocument, overridden: InkDocument, conflict: InkMergeConflict): InkDocument {
  const next: InkDocument = { ...page, erased: { ...page.erased } };
  if (conflict.kind === "page") next.page = overridden.page;
  else if (conflict.kind === "stroke" && conflict.id !== undefined) {
    next.strokes = takeItem(page.strokes, overridden.strokes, conflict.id);
    const erased = overridden.erased[conflict.id];
    if (erased) next.erased[conflict.id] = erased;
    else delete next.erased[conflict.id];
  } else if (conflict.kind === "shape" && conflict.id !== undefined) {
    next.shapes = takeItem(page.shapes ?? [], overridden.shapes ?? [], conflict.id);
  }
  return next;
}

/** The drawing a merge conflict reverts to: `merged` (what the merge stored)
 *  with only the items both sides changed — `conflicts`, as mergeInk reported
 *  them — taken back from `overridden` (the value the merge was made over).
 *  Every other item stays as merged, so mergeInk(merged, current, result)
 *  re-applies just those items onto the drawing as it is now and keeps
 *  everything else either device drew, then or since. A "format" conflict,
 *  or values that are not the same kind of drawing, revert whole: the
 *  overridden value. Pure. */
export function revertInkConflicts(merged: string, overridden: string, conflicts: readonly InkMergeConflict[]): string {
  const m = decodeInk(merged);
  const o = decodeInk(overridden);
  if (conflicts.some((c) => c.kind === "format")) return overridden;
  if (m.kind === "page" && o.kind === "page") {
    return encodeInk(conflicts.reduce((doc, c) => {
      if (c.pageKey === undefined) return revertOnPage(doc, o.doc, c);
      const current = doc.morePages?.pages[c.pageKey];
      const theirs = o.doc.morePages?.pages[c.pageKey];
      const from = current ?? theirs;
      if (!from) return doc;
      const page = revertOnPage(current?.doc ?? emptyRecord(c.pageKey, from).doc, theirs?.doc ?? emptyRecord(c.pageKey, from).doc, c);
      const more: InkPages = doc.morePages ?? { version: 1, pages: {} };
      return { ...doc, morePages: { ...more, pages: { ...more.pages, [c.pageKey]: { ...from, doc: page } } } };
    }, m.doc));
  }
  if (m.kind === "pdf" && o.kind === "pdf") {
    const doc: InkEnvelope = { ...m.doc, pages: { ...m.doc.pages } };
    for (const c of conflicts) {
      if (c.kind === "annotation" && c.id !== undefined) {
        doc.annotations = takeItem(doc.annotations ?? [], o.doc.annotations ?? [], c.id);
      } else if (c.page !== undefined) {
        const current = doc.pages[c.page];
        const theirs = o.doc.pages[c.page];
        const width = (current ?? theirs)?.page.width ?? INK_DEFAULT_PAGE_WIDTH;
        doc.pages[c.page] = revertOnPage(current ?? emptyPage(width), theirs ?? emptyPage(width), c);
      }
    }
    return encodeInk(doc);
  }
  return overridden;
}

export {
  inkToSvg, inkToSvgFrame, inkRegionToSvg, inkOverlayToSvg, inkPageToSvg, inkPages, INK_PAGE_RENDER_VERSION, INK_PAPER_COLOR, outlineToPath, SHAPE_FILL_TOOL_ID, SHAPE_TOOL_ID, UNIFORM_TOOL_ID, strokeOutline, strokeOptionsFor, hasRealPressure, easeOutSine, visibleRuns,
  type OutlineParams, type StrokeOptions, type Vec2, type InkSvgFrame, type InkOverlayText, type InkRegionPicture,
} from "./inkSvg.js";
