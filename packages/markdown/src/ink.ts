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

import { inMergedKeyOrder, mergeItemsById, mergeValues, sameJson, weaveOrder } from "./jsonMerge.js";
import { emptyInkPages, legacyFingerprint, pdfPageOfKey } from "./inkPages.js";
import { INK_PAGE_KEY } from "./pageText.js";
import type { InkPageRecord, InkPages } from "./inkPages.js";
import { INK_DEFAULT_PAGE_WIDTH, decodeInk, encodeInk, isRecord, mergeIntervals, subtractIntervals } from "./inkFormat.js";
import type { DecodedInk, EraseInterval, ErasedIntervals, InkDocument, InkEnvelope } from "./inkFormat.js";

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

// ── Merging several saves of one drawing ──────────────────────────────────
// mergeInkHeads is THE merge: a base and the set of saves ("heads") made from
// it. Its result depends only on that base and that set — not on the order the
// heads are given or arrive in, and a head given twice or equal to the base
// changes nothing. mergeInk (base, stored, incoming) is the same function with
// two heads, so the server and the app merge exactly as a replicated-value
// table that holds every head would. What decides where anything goes (a
// stroke in its list, a page in `order`) is jsonMerge weaveOrder; what two
// heads changed differently is decided by one fixed order of the heads (their
// text, compared as strings: the last keeps its version) and reported, and
// every losing version stays in the heads, so a caller that keeps them (the
// server's conflict record) can give it back (revertInkConflicts).
//
// Folding pairwise (merge(merge(a, b), c)) is NOT the same as merging the set
// {a, b, c}: an intermediate result has lost where a deleted item used to be,
// so a page or stroke another head added next to it may land elsewhere. The
// server merges each write into what is stored as it arrives — pairwise — so
// three writes at once can still give a page order that depends on their
// arrival. There is one server, so nothing diverges, and nothing is dropped.

/** Something two heads changed differently. The merge still decides (the
 *  head last in the fixed order keeps its version; nothing either changed is
 *  dropped from the heads) and reports it so a person can look. */
export type InkMergeConflict = {
  /** stroke / shape / annotation: one item by id; page: a page's settings
   *  (width, background, size); deletedPage: a further page one head deleted
   *  while another drew on it (it is kept as the heads that drew have it);
   *  format: the heads are different shapes (page vs PDF envelope, or one is
   *  unreadable), so one is kept whole. */
  kind: "stroke" | "shape" | "annotation" | "page" | "deletedPage" | "format";
  id?: string;
  /** The PDF page the item is on. */
  page?: number;
  /** The handwriting page the item is on when it is not the first (its key in
   *  `morePages`). */
  pageKey?: string;
};

export type InkMergeResult = { value: string; conflicts: InkMergeConflict[] };

type Located = Omit<InkMergeConflict, "kind" | "id">;
type Conflicts = InkMergeConflict[];

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

/** Erasure as point sets: what any head newly erased, plus what the base had
 *  erased and no head restored (undo of an erase is a removal). Keys follow
 *  the merged strokes. */
function mergeErased(base: ErasedIntervals, sides: readonly ErasedIntervals[], strokeIds: Iterable<string>): ErasedIntervals {
  const out: ErasedIntervals = {};
  for (const id of strokeIds) {
    const b = intervalsOf(base, id);
    const each = sides.map((side) => intervalsOf(side, id));
    const kept = each.reduce(intersect, b);
    const merged = mergeIntervals([...kept, ...each.flatMap((iv) => subtractIntervals(iv, b))]);
    if (merged.length > 0) out[id] = merged;
  }
  return out;
}

function emptyPage(width = INK_DEFAULT_PAGE_WIDTH): InkDocument {
  return { version: 1, strokes: [], erased: {}, page: { width } };
}

/** `features` / `requires` lists: everything any head has (they only grow) —
 *  the base's names in its order, then the others sorted; undefined when none has the list. */
function unionList(base: readonly string[] | undefined, sides: readonly (readonly string[] | undefined)[]): string[] | undefined {
  if (![base, ...sides].some(Array.isArray)) return undefined;
  const first = [...new Set(base ?? [])];
  const added = [...new Set(sides.flatMap((s) => s ?? []))].filter((name) => !first.includes(name)).sort();
  return [...first, ...added];
}

/** Fields this version does not manage, merged as plain values (jsonMerge
 *  mergeValues: the heads that changed one; the last in order when they
 *  differ — not reported: no conflict kind names a field, but the heads keep
 *  every version). `managed` are the keys the caller merges itself. */
function mergeUnknownFields(target: Record<string, unknown>, base: object, sides: readonly object[], managed: ReadonlySet<string>): void {
  const b = base as Record<string, unknown>, all = sides as Record<string, unknown>[];
  for (const key of new Set([...Object.keys(b), ...all.flatMap((s) => Object.keys(s))])) {
    if (managed.has(key)) continue;
    const value = mergeValues(b[key], all.map((s) => s[key]), () => {});
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
}

const UNITS_MANAGED: ReadonlySet<string> = new Set(["version", "pages", "order"]);
const RECORD_MANAGED: ReadonlySet<string> = new Set(["key", "background", "size", "doc"]);
const PAGE_MANAGED: ReadonlySet<string> = new Set(["version", "strokes", "erased", "page", "shapes", "features", "requires"]);
// A literal, not a spread of PAGE_MANAGED: a spread runs at module load, which would keep this whole module in every bundle that imports one name from it (the app's boot JS).
const NOTE_MANAGED: ReadonlySet<string> = new Set(["version", "strokes", "erased", "page", "shapes", "features", "requires", "morePages"]);
const ENVELOPE_MANAGED: ReadonlySet<string> = new Set(["version", "pages", "annotations", "units", "unitsFrom", "features", "requires"]);
/** Field order of a merged record / page list whose base did not have it (inMergedKeyOrder): the order the app writes. */
const RECORD_FIELDS = { key: 0, background: 0, size: 0, doc: 0 };
const PAGES_FIELDS = { version: 0, pages: 0, order: 0 };

function mergeFeatureLists(target: { features?: string[]; requires?: string[] }, base: typeof target, sides: readonly (typeof target)[]): void {
  for (const key of ["features", "requires"] as const) {
    const merged = unionList(base[key], sides.map((s) => s[key]));
    if (merged) target[key] = merged;
    else delete target[key];
  }
}

/** One page's drawing from several heads. `managed`: the fields merged here
 *  or by the caller (a note's first page leaves `morePages` to mergeNote). */
function mergePage(base: InkDocument, sides: readonly InkDocument[], at: Located, conflicts: Conflicts,
  managed: ReadonlySet<string> = PAGE_MANAGED): InkDocument {
  const strokes = mergeItemsById(base.strokes, sides.map((d) => d.strokes), (id) => conflicts.push({ kind: "stroke", id, ...at }));
  const hasShapes = [base, ...sides].some((d) => Array.isArray(d.shapes));
  const shapes = hasShapes ? mergeItemsById(base.shapes ?? [], sides.map((d) => d.shapes ?? []), (id) => conflicts.push({ kind: "shape", id, ...at })) : undefined;
  const page = mergeValues(base.page, sides.map((d) => d.page), () => conflicts.push({ kind: "page", ...at }))!;
  const erased = mergeErased(base.erased, sides.map((d) => d.erased), strokes.map((s) => s.id));
  const merged: InkDocument = { version: 1, strokes, erased, page };
  if (shapes) merged.shapes = shapes;
  mergeUnknownFields(merged as unknown as Record<string, unknown>, base, sides, managed);
  mergeFeatureLists(merged, base, sides);
  return inMergedKeyOrder(merged, base);
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
 *  fields). Pages merge as a notebook's do (mergePages), each head read as the
 *  pages its `units` stand for (unitsOf), else as the `units` it carries (one
 *  without any did not change them: the base's). When any head's cannot be
 *  trusted, the merge is stale: `unitsFrom` is dropped, so readers convert the
 *  merged older fields instead, which hold everything any head drew, and
 *  `units` still keeps whatever a newer app wrote there. Conflicts are
 *  reported by the older fields, not twice. */
function mergeUnits(base: InkEnvelope, sides: readonly InkEnvelope[], merged: InkEnvelope): void {
  if (![base, ...sides].some((d) => d.units)) return;
  const b = unitsOf(base, base);
  const each = sides.map((side) => unitsOf(side, base));
  merged.units = mergePages(b ?? base.units, sides.map((side, n) => each[n] ?? side.units ?? base.units), (key) => ({ pageKey: key }), []);
  if (b && each.every(Boolean)) merged.unitsFrom = legacyFingerprint(merged);
  else delete merged.unitsFrom;
}

/** One page record from the heads that have it (its drawing by id, its
 *  settings as values: one "page" conflict when either setting differs). */
function mergeRecord(key: string, br: InkPageRecord | undefined, records: readonly InkPageRecord[], at: Located, conflicts: Conflicts): InkPageRecord {
  if (!br && records.length === 1) return records[0]!;
  let settings = false;
  const changedBoth = () => { settings = true; };
  const record: InkPageRecord = {
    key,
    background: mergeValues(br?.background, records.map((r) => r.background), changedBoth)!,
    size: mergeValues(br?.size, records.map((r) => r.size), changedBoth)!,
    doc: mergePage(br?.doc ?? emptyPage(), records.map((r) => r.doc), at, conflicts),
  };
  if (settings && !conflicts.some((c) => c.kind === "page" && sameJson(c, { kind: "page", ...at }))) conflicts.push({ kind: "page", ...at });
  mergeUnknownFields(record as unknown as Record<string, unknown>, br ?? {}, records, RECORD_MANAGED);
  return inMergedKeyOrder(record, br ?? RECORD_FIELDS);
}

/** A drawing's pages (a notebook's further pages, a PDF's `units`) from
 *  several heads, by key. A page a head added stays. A page some head deleted
 *  goes when every other head left it as the base had it; when another head
 *  drew on it (or changed it) since the base, it stays as the heads that kept
 *  it have it (merged) and a "deletedPage" conflict is reported — an edit the
 *  deleter never saw beats the delete, as for a stroke. `order` is woven
 *  (jsonMerge weaveOrder): pages added by any head are all listed; keys of
 *  pages that went are dropped. The `pages` object's own key order is where a
 *  page `order` does not name is shown (inkPageOrder): the named ones in
 *  `order`, then `page`, PDF pages by number, the rest woven too. */
function mergePages(base: InkPages | undefined, sides: readonly (InkPages | undefined)[], locate: (key: string) => Located, conflicts: Conflicts): InkPages {
  const b = base?.pages ?? {};
  const each = sides.map((side) => side?.pages ?? {});
  const pages: InkPages["pages"] = {};
  for (const key of new Set(each.flatMap((p) => Object.keys(p)))) {
    const br = b[key];
    const records = each.map((p) => p[key]).filter((r): r is InkPageRecord => r !== undefined);
    if (br && records.length < each.length) { // deleted by some head
      if (records.every((r) => sameJson(r, br))) continue; // the others left it alone: it stays deleted
      conflicts.push({ kind: "deletedPage", ...locate(key) });
    }
    pages[key] = mergeRecord(key, br, records, locate(key), conflicts);
  }
  const out: InkPages = { version: 1, pages: {} };
  mergeUnknownFields(out as unknown as Record<string, unknown>, base ?? {}, sides.map((s) => s ?? {}), UNITS_MANAGED);
  // `order` present or absent: what the heads did to that; a key it names stays while its page does (`page` always).
  const hasOrder = mergeValues(Array.isArray(base?.order), sides.map((s) => Array.isArray(s?.order)), () => {});
  if (hasOrder) out.order = weaveOrder(base?.order ?? [], sides.map((s) => s?.order ?? []), new Set([INK_PAGE_KEY, ...Object.keys(pages)]));
  const named = (out.order ?? []).filter((key) => key in pages);
  const rank = (key: string) => (key === INK_PAGE_KEY ? -1 : pdfPageOfKey(key) ?? Number.MAX_SAFE_INTEGER);
  const rest = weaveOrder(Object.keys(b), each.map((p) => Object.keys(p)), new Set(Object.keys(pages).filter((key) => !named.includes(key))))
    .map((key, n) => ({ key, n })).sort((x, y) => rank(x.key) - rank(y.key) || x.n - y.n).map((x) => x.key);
  out.pages = Object.fromEntries([...named, ...rest].map((key) => [key, pages[key]!]));
  return inMergedKeyOrder(out, base ?? PAGES_FIELDS);
}

/** A handwriting note's stored document: its first page, then its further
 *  pages (mergePages; left out when the merged note has none and no order). */
function mergeNote(base: InkDocument, sides: readonly InkDocument[], conflicts: Conflicts): InkDocument {
  const merged = mergePage(base, sides, {}, conflicts, NOTE_MANAGED);
  if ([base, ...sides].some((d) => d.morePages)) {
    const more = mergePages(base.morePages, sides.map((d) => d.morePages), (key) => ({ pageKey: key }), conflicts);
    if (Object.keys(more.pages).length > 0 || more.order) merged.morePages = more;
  }
  return inMergedKeyOrder(merged, base);
}

function mergeEnvelope(base: InkEnvelope, sides: readonly InkEnvelope[], conflicts: Conflicts): InkEnvelope {
  const pages: InkEnvelope["pages"] = {};
  const numbers = new Set(sides.flatMap((d) => Object.keys(d.pages)).map(Number));
  for (const n of [...numbers].sort((a, b) => a - b)) {
    // A page a head does not have is blank there, as wide as the base's (the default when the base has none either).
    const from = base.pages[n] ?? emptyPage();
    pages[n] = mergePage(from, sides.map((d) => d.pages[n] ?? emptyPage(base.pages[n]?.page.width)), { page: n }, conflicts);
  }
  // A head without records (an envelope saved before they moved in) did not
  // change them: read it as the base's, never as "all removed".
  const baseRecords = base.annotations ?? [];
  const hasRecords = [base, ...sides].some((d) => Array.isArray(d.annotations));
  const merged: InkEnvelope = { version: 1, pages };
  if (hasRecords) merged.annotations = mergeItemsById(baseRecords, sides.map((d) => d.annotations ?? baseRecords), (id) => conflicts.push({ kind: "annotation", id }));
  mergeUnknownFields(merged as unknown as Record<string, unknown>, base, sides, ENVELOPE_MANAGED);
  mergeFeatureLists(merged, base, sides);
  mergeUnits(base, sides, merged);
  return inMergedKeyOrder(merged, base);
}

/** What an empty head ("") stands for: the base with nothing drawn — every
 *  stroke, shape, record and further page removed, settings as the base had
 *  them — so it merges as "this head cleared the drawing". */
function cleared(base: DecodedInk): DecodedInk {
  if (base.kind === "page") {
    const doc: InkDocument = { ...base.doc, strokes: [], erased: {} };
    if (doc.shapes) doc.shapes = [];
    if (doc.morePages) doc.morePages = { ...doc.morePages, pages: {}, ...(doc.morePages.order ? { order: doc.morePages.order.filter((k) => k === INK_PAGE_KEY) } : {}) };
    return { kind: "page", doc };
  }
  if (base.kind === "pdf") {
    const pages = Object.fromEntries(Object.entries(base.doc.pages).map(([n, p]) => [n, { ...p, strokes: [], erased: {}, ...(p.shapes ? { shapes: [] } : {}) }]));
    const doc: InkEnvelope = { ...base.doc, pages };
    if (doc.annotations) doc.annotations = [];
    delete doc.unitsFrom;
    return { kind: "pdf", doc };
  }
  return base;
}

/** Merge the saves `heads` of one drawing, all made from `base` (what each
 *  device loaded or last saved; null or "" = none). The result depends only on
 *  `base` and the set of heads (see above). Strokes, shapes and highlight
 *  records merge by id and erasure as interval sets, so a stroke drawn on any
 *  device survives and a stroke undone on one stays gone (unless another
 *  changed it). A head that is "" cleared the drawing. Heads of another kind
 *  than the one the fixed order keeps (a page against a PDF envelope), or
 *  unreadable ones, do not merge: one "format" conflict. When the merge comes
 *  out as one head or the base (same JSON), that text is returned as it is, so
 *  nothing is rewritten. Pure; inputs are not changed.
 *  Use: mergeInkHeads(base, [laptop, tablet, phone]). */
export function mergeInkHeads(base: string | null | undefined, heads: readonly string[]): InkMergeResult {
  const baseText = base ?? "";
  // Order of the heads, fixed by their text: only what two heads changed differently depends on it.
  const set = [...new Set(heads)].filter((h) => h !== baseText).sort();
  if (set.length === 0) return { value: heads.length ? baseText : "", conflicts: [] };
  if (set.length === 1) return { value: set[0]!, conflicts: [] };
  const b = decodeInk(base);
  const decoded = set.map((h) => (h === "" ? cleared(b) : decodeInk(h)));
  const conflicts: Conflicts = [];
  const readable = decoded.map((d, n) => ({ d, n })).filter((x) => x.d.kind !== "none");
  if (readable.length === 0) return { value: set[set.length - 1]!, conflicts: [{ kind: "format" }] };
  const kind = readable[readable.length - 1]!.d.kind;
  const same = readable.filter((x) => x.d.kind === kind);
  if (same.length < set.length) conflicts.push({ kind: "format" });
  if (same.length === 1) return { value: set[same[0]!.n]!, conflicts };
  let merged: InkDocument | InkEnvelope;
  if (kind === "page") {
    const from = b.kind === "page" ? b.doc : emptyPage();
    merged = mergeNote(from, same.map((x) => (x.d as { doc: InkDocument }).doc), conflicts);
  } else {
    const from: InkEnvelope = b.kind === "pdf" ? b.doc : { version: 1, pages: {} };
    merged = mergeEnvelope(from, same.map((x) => (x.d as { doc: InkEnvelope }).doc), conflicts);
  }
  // Come out as one of the heads or the base (same JSON): that text, so a merge that changed nothing rewrites nothing.
  const matches = [...same.map((x) => ({ text: set[x.n]!, doc: (x.d as { doc: object }).doc })), ...(b.kind === kind ? [{ text: baseText, doc: (b as { doc: object }).doc }] : [])]
    .filter((x) => x.text !== "" && sameJson(x.doc, merged)).map((x) => x.text).sort();
  return { value: matches[0] ?? encodeInk(merged), conflicts };
}

/** Merge a drawing save into what is stored: mergeInkHeads(base, [stored,
 *  incoming]). `base` is the drawing the incoming save was made from;
 *  `stored` is the current value, which another device may have changed since
 *  (null: nothing stored, the save is kept as sent). Both orders of `stored`
 *  and `incoming` give the same result. */
export function mergeInk(base: string | null | undefined, stored: string | null | undefined, incoming: string): InkMergeResult {
  if (stored === null || stored === undefined) return { value: incoming, conflicts: [] };
  return mergeInkHeads(base, [stored, incoming]);
}

// ── Reverting a merge conflict ─────────────────────────────────────────────

/** The version of `id` in `from` in place of the merged one: swapped in
 *  place, removed when `from` had none, appended when only it had it. */
function takeItem<T extends { id: string }>(merged: readonly T[], from: readonly T[], id: string): T[] {
  const theirs = from.find((item) => isRecord(item) && item.id === id);
  const at = merged.findIndex((item) => isRecord(item) && item.id === id);
  if (at < 0) return theirs ? [...merged, theirs] : [...merged];
  const out = [...merged];
  if (theirs) out[at] = theirs;
  else out.splice(at, 1);
  return out;
}

/** One conflict on one page: the stroke (with its erasure), the shape, or the
 *  page settings as `from` had them. */
function revertOnPage(page: InkDocument, from: InkDocument, conflict: InkMergeConflict): InkDocument {
  const next: InkDocument = { ...page, erased: { ...page.erased } };
  if (conflict.kind === "page") next.page = from.page;
  else if (conflict.kind === "stroke" && conflict.id !== undefined) {
    next.strokes = takeItem(page.strokes, from.strokes, conflict.id);
    const erased = from.erased[conflict.id];
    if (erased) next.erased[conflict.id] = erased;
    else delete next.erased[conflict.id];
  } else if (conflict.kind === "shape" && conflict.id !== undefined) {
    next.shapes = takeItem(page.shapes ?? [], from.shapes ?? [], conflict.id);
  }
  return next;
}

/** What one conflict is about in a drawing, as JSON (for telling versions apart). */
function conflictPart(d: DecodedInk, c: InkMergeConflict): unknown {
  if (d.kind === "page") {
    const record = c.pageKey === undefined ? undefined : d.doc.morePages?.pages[c.pageKey];
    if (c.kind === "deletedPage") return record ?? null;
    const doc = c.pageKey === undefined ? d.doc : record?.doc;
    if (!doc) return null;
    if (c.kind === "page") return { page: doc.page, ...(record ? { background: record.background, size: record.size } : {}) };
    if (c.kind === "stroke") return [doc.strokes.find((s) => s.id === c.id) ?? null, doc.erased[c.id ?? ""] ?? null];
    if (c.kind === "shape") return (doc.shapes ?? []).find((s) => s.id === c.id) ?? null;
    return null;
  }
  if (d.kind === "pdf") {
    if (c.kind === "annotation") return (d.doc.annotations ?? []).find((a) => a.id === c.id) ?? null;
    const doc = c.page === undefined ? undefined : d.doc.pages[c.page];
    if (!doc) return null;
    if (c.kind === "page") return doc.page;
    if (c.kind === "stroke") return [doc.strokes.find((s) => s.id === c.id) ?? null, doc.erased[c.id ?? ""] ?? null];
    if (c.kind === "shape") return (doc.shapes ?? []).find((s) => s.id === c.id) ?? null;
  }
  return null;
}

/** The versions that lost conflict `c`: each of `versions` (the heads the
 *  merge was made from, as a caller kept them) whose version of that item
 *  differs from `merged`'s, once each, in `versions`' order. A "format"
 *  conflict: the whole values that differ. Use it to show or give back what
 *  a merge did not keep. */
export function inkConflictLosers(merged: string, versions: readonly string[], c: InkMergeConflict): string[] {
  const m = decodeInk(merged);
  const seen: unknown[] = [];
  const out: string[] = [];
  for (const v of versions) {
    if (v === merged) continue;
    const d = decodeInk(v);
    const part = c.kind === "format" ? (d.kind === "none" ? v : d.doc) : d.kind === m.kind ? conflictPart(d, c) : undefined;
    if (part === undefined || sameJson(part, c.kind === "format" ? (m.kind === "none" ? merged : m.doc) : conflictPart(m, c))) continue;
    if (seen.some((p) => sameJson(p, part))) continue;
    seen.push(part);
    out.push(v);
  }
  return out;
}

/** The drawing a merge's conflicts revert to: `merged` (what the merge
 *  stored) with each item two heads changed differently — `conflicts`, as the
 *  merge reported them — taken from the first of `versions` (the heads it was
 *  made from, as the caller kept them; inkConflictLosers) that the merge did
 *  not keep. Every other item stays as merged, so a merge of the result into
 *  the drawing as it is now re-applies just those items and keeps everything
 *  else any device drew, then or since. A page one head deleted while another
 *  drew on it is deleted again (or given back) the same way. A "format"
 *  conflict reverts whole: that losing value. A conflict no version lost
 *  changes nothing. Pure. */
export function revertInkConflicts(merged: string, versions: string | readonly string[], conflicts: readonly InkMergeConflict[]): string {
  const all = typeof versions === "string" ? [versions] : versions;
  const loser = (c: InkMergeConflict) => inkConflictLosers(merged, all, c)[0];
  const format = conflicts.find((c) => c.kind === "format");
  if (format) return loser(format) ?? merged;
  const m = decodeInk(merged);
  if (m.kind === "page") {
    return encodeInk(conflicts.reduce((doc, c) => {
      const raw = loser(c);
      const o = raw === undefined ? null : decodeInk(raw);
      if (!o || o.kind !== "page") return doc;
      if (c.pageKey === undefined) return revertOnPage(doc, o.doc, c);
      const key = c.pageKey;
      const current = doc.morePages?.pages[key];
      const theirs = o.doc.morePages?.pages[key];
      const more: InkPages = doc.morePages ?? { version: 1, pages: {} };
      if (c.kind === "deletedPage") {
        // The page as the losing head had it: deleted again, or its version back (listed where that head had it).
        const pages = { ...more.pages };
        if (theirs) pages[key] = theirs; else delete pages[key];
        const order = more.order && (theirs
          ? (more.order.includes(key) ? more.order : weaveOrder([], [more.order, o.doc.morePages?.order ?? [key]], new Set([INK_PAGE_KEY, ...Object.keys(pages)])))
          : more.order.filter((k) => k !== key));
        return { ...doc, morePages: { ...more, pages, ...(order ? { order } : {}) } };
      }
      const from = current ?? theirs;
      if (!from) return doc;
      const page = revertOnPage(current?.doc ?? emptyRecord(key, from).doc, theirs?.doc ?? emptyRecord(key, from).doc, c);
      // A page's settings are its record's background and size too.
      const settings = c.kind === "page" && theirs ? { background: theirs.background, size: theirs.size } : {};
      return { ...doc, morePages: { ...more, pages: { ...more.pages, [key]: { ...from, ...settings, doc: page } } } };
    }, m.doc));
  }
  if (m.kind === "pdf") {
    const doc: InkEnvelope = { ...m.doc, pages: { ...m.doc.pages } };
    for (const c of conflicts) {
      const raw = loser(c);
      const o = raw === undefined ? null : decodeInk(raw);
      if (!o || o.kind !== "pdf") continue;
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
  return merged;
}

export {
  inkToSvg, inkToSvgFrame, inkRegionToSvg, inkOverlayToSvg, inkPageToSvg, inkPages, INK_PAGE_RENDER_VERSION, INK_PAPER_COLOR, outlineToPath, SHAPE_FILL_TOOL_ID, SHAPE_TOOL_ID, UNIFORM_TOOL_ID, strokeOutline, strokeOptionsFor, hasRealPressure, easeOutSine, visibleRuns,
  type OutlineParams, type StrokeOptions, type Vec2, type InkSvgFrame, type InkOverlayText, type InkRegionPicture,
} from "./inkSvg.js";
