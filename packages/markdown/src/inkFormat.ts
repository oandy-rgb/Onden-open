// The stored drawing format: its types, defaults, and decode/encode. Split from
// ink.ts (the three-way merge, and the one `@onden/markdown/ink` entry) so
// inkSvg.ts can decode a drawing without importing ink.ts back. The format
// rules (preserve unknown data, `requires` read-only) are in ink.ts's header.
//
// ── Two formats in a PDF note's envelope (page units, step 1 of merging the PDF
// and handwriting pages) ───────────────────────────────────────────────────
// A PDF's strokes and shapes are stored twice, on purpose, until the older form
// is retired (that is a separate decision):
//   units (+ unitsFrom)   the pages as InkPages (inkPages.ts): one InkDocument
//                         per page in page units, the handwriting page's own
//                         format. Written by this version; read first.
//   pages + annotations   the older form: `pages[n]` strokes in the frame of
//                         the drawing record they belong to, and the `drawing`
//                         / `shape` records (viewport-px placement). Still
//                         written (generated from `units`) so an older app
//                         shows and edits the same drawing; read only when
//                         `units` is missing or stale.
// `unitsFrom` = legacyFingerprint of the older fields `units` was written with.
// An older app edits only the older fields and keeps `units` as found, so
// `units` is trusted only while its fingerprint matches (currentUnits);
// otherwise a reader converts the older fields again. Merge: ink.ts mergeEnvelope.

import type { InkBackground, InkPageRecord, InkPages } from "./inkPages.js";
import { INK_PAGE_KEY } from "./pageText.js";
import { INK_SHAPE_KINDS } from "./sharedContract.js";

/** A captured input point: [x, y] or [x, y, pressure]. Pressure is present
 *  only when the source pointer reported real pressure (stylus); its absence
 *  is the signal to simulate pressure from velocity at render time. */
export type InkPoint = [number, number] | [number, number, number];

/** The tools this version draws. A stored stroke may name another (a newer
 *  app's), so `InkStroke.toolId` is any string; unknown ones render as a pen. */
export type InkToolId = "pen" | "highlighter";

export interface InkStroke {
  id: string;
  points: InkPoint[];
  /** Canonical (light-theme) CSS color. Dark mode inverts at render time. */
  color: string;
  /** Base size in document units. */
  size: number;
  /** Kept as stored when unknown (see Format evolution). */
  toolId: InkToolId | (string & {});
}

/** Inclusive index interval [startIdx, endIdx] of erased points along a
 *  stroke's polyline. Always kept sorted + merged (no overlap/adjacency). */
export type EraseInterval = [number, number];

/** strokeId -> dead index ranges. */
export type ErasedIntervals = Record<string, EraseInterval[]>;

export interface InkPage {
  /** Fixed logical page width (document units). */
  width: number;
  background?: string;
}

/** A geometric annotation — append-only like strokes: immutable once
 *  committed, removed whole by id, never edited in place. Coordinates are
 *  host-defined (the PDF host stores the capture-normalized pair its renderer
 *  consumes); the ink doc's job is the GOVERNABLE record. `start`/`end` are the
 *  two corners of the drag (the two ends of a line or arrow); geometry per kind
 *  is in inkShapes.ts. "circle" is the older name of an ellipse inscribed in the
 *  corners; new drawings write "ellipse". */
export type InkShapeKind =
  | "line" | "arrow" | "rectangle" | "roundedRectangle" | "ellipse" | "circle" | "triangle" | "diamond" | "star";

/** How a closed shape's inside is drawn. A drawing from before fills has no
 *  `fill` (= "none"); a value this version does not know is drawn as "none"
 *  and kept as stored. A line or arrow has no inside, whatever it says. */
export type InkShapeFill = "none" | "solid";

export interface InkShape {
  id: string;
  /** A newer app's kind is kept as stored and not drawn here. */
  kind: InkShapeKind | (string & {});
  start: [number, number];
  end: [number, number];
  color: string;
  size: number;
  /** Absent = "none" (every shape saved before fills existed). */
  fill?: InkShapeFill | (string & {});
}

export interface InkDocument {
  version: 1;
  strokes: InkStroke[];
  erased: ErasedIntervals;
  page: InkPage;
  /** Optional — hosts without shape tools simply omit it. */
  shapes?: InkShape[];
  /** A handwriting note's pages after this one (inkPages.ts notePages): never
   *  the `page` key. Only the stored note document has it, not a page inside. */
  morePages?: InkPages;
  /** See Format evolution. Absent today. */
  features?: string[];
  requires?: string[];
}

/** What the merge needs of a PDF highlight record: its id. The app's full
 *  record type is lib/pdf/coords PdfHighlightRecord. */
export interface InkAnnotation { id: string }

/** The PDF's ink_data envelope: per-page strokes and shapes, plus every
 *  highlight record (text, area, drawing frame, shape). */
export interface InkEnvelope<A extends InkAnnotation = InkAnnotation> {
  version: 1;
  pages: Record<number, InkDocument>;
  /** Placement records the reader renders. Absent only in envelopes saved
   *  before they moved in (the app folds the legacy attribute in on load). */
  annotations?: A[];
  /** The pages in page units (see "Two formats" above). */
  units?: InkPages;
  /** Fingerprint of the older fields `units` was written with. */
  unitsFrom?: string;
  /** See Format evolution. Absent today. */
  features?: string[];
  requires?: string[];
}

export type DecodedInk<A extends InkAnnotation = InkAnnotation> =
  | { kind: "page"; doc: InkDocument }
  | { kind: "pdf"; doc: InkEnvelope<A> }
  | { kind: "none" };

export const INK_DEFAULT_PAGE_WIDTH = 1000;

/** Feature names this version can edit without damaging a drawing (Format
 *  evolution, rule 2). Empty: it writes no `features` yet. A feature joins this
 *  list in the same change that teaches the editor to handle it. */
export const INK_KNOWN_FEATURES: readonly string[] = ["note-pages"];

/** The names a drawing `requires` that this version does not know — what makes
 *  it read-only. For an envelope: its own and every page's. Sorted, unique. */
export function inkUnknownRequirements(doc: InkDocument | InkEnvelope | null | undefined): string[] {
  if (!doc) return [];
  const unknown = new Set<string>();
  const scan = (d: { requires?: string[] }) => {
    if (!Array.isArray(d.requires)) return;
    for (const name of d.requires) if (typeof name === "string" && !INK_KNOWN_FEATURES.includes(name)) unknown.add(name);
  };
  scan(doc);
  if ("pages" in doc && isRecord(doc.pages)) for (const page of Object.values(doc.pages)) if (isRecord(page)) scan(page);
  if ("units" in doc && doc.units) for (const record of Object.values(doc.units.pages)) scan(record.doc);
  return [...unknown].sort();
}

/** Whether a drawing holds anything to draw: strokes or shapes (shapes are a separate, optional array). */
export const inkHasContent = (doc: Pick<InkDocument, "strokes" | "shapes">): boolean => doc.strokes.length > 0 || (doc.shapes?.length ?? 0) > 0;

/** True when the drawing was made with a newer version that this one must not
 *  edit: render it, never save it. */
export function isInkReadOnly(doc: InkDocument | InkEnvelope | null | undefined): boolean {
  return inkUnknownRequirements(doc).length > 0;
}

/** Merge a set of inclusive index intervals: sorted, overlapping OR adjacent
 *  ([0,2] + [3,5] -> [0,5]) intervals collapse into one. */
export function mergeIntervals(intervals: EraseInterval[]): EraseInterval[] {
  if (intervals.length <= 1) return intervals.map((iv) => [...iv] as EraseInterval);
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: EraseInterval[] = [[sorted[0]![0], sorted[0]![1]]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur[0] <= last[1] + 1) {
      // overlapping or directly adjacent — extend
      last[1] = Math.max(last[1], cur[1]);
    } else {
      out.push([cur[0], cur[1]]);
    }
  }
  return out;
}

/** `a − b` for sorted+merged interval lists (the model invariant). */
export function subtractIntervals(a: EraseInterval[], b: EraseInterval[]): EraseInterval[] {
  const out: EraseInterval[] = [];
  for (const [as, ae] of a) {
    let start = as;
    for (const [bs, be] of b) {
      if (be < start) continue;
      if (bs > ae) break;
      if (bs > start) out.push([start, bs - 1]);
      start = Math.max(start, be + 1);
      if (start > ae) break;
    }
    if (start <= ae) out.push([start, ae]);
  }
  return out;
}

// ── The one ink_data codec ─────────────────────────────────────────────────

const NONE = { kind: "none" } as const;
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// GAP-230: a page is read field by field. A stroke nothing can draw (no id,
// no readable points) is dropped, an unreadable point or erase range is
// skipped, and missing style fields get the toolbar defaults; one bad record
// must never take a board (or the app, or a served page) down with it. A
// value written by the app reads back unchanged (fields it does not know are
// kept). A page without a strokes array is not a page at all.
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const DEFAULT_COLOR = "#15130d"; // the ink toolbar's "Ink"
const DEFAULT_SIZE = 4; // the ink toolbar's "Medium"

function asPoint(v: unknown): InkPoint | null {
  if (!Array.isArray(v) || v.length < 2 || !finite(v[0]) || !finite(v[1])) return null;
  return v.length === 2 ? v as InkPoint : finite(v[2]) ? [v[0], v[1], v[2]] : [v[0], v[1]];
}

function asStroke(v: unknown): InkStroke | null {
  if (!isRecord(v) || typeof v.id !== "string" || !v.id || !Array.isArray(v.points)) return null;
  const points = v.points.map(asPoint).filter((p): p is InkPoint => p !== null);
  if (!points.length) return null;
  return {
    ...(v as unknown as InkStroke),
    points,
    color: typeof v.color === "string" && v.color ? v.color : DEFAULT_COLOR,
    size: finite(v.size) && v.size > 0 ? v.size : DEFAULT_SIZE,
    // An unknown tool is kept: only a missing/non-string one becomes a pen.
    toolId: typeof v.toolId === "string" && v.toolId ? v.toolId : "pen",
  };
}

function asErased(v: unknown): ErasedIntervals {
  const erased: ErasedIntervals = {};
  if (!isRecord(v)) return erased;
  for (const [id, ranges] of Object.entries(v)) {
    if (!Array.isArray(ranges)) continue;
    const kept = ranges.filter((r): r is EraseInterval =>
      Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] <= r[1]);
    if (kept.length || !ranges.length) erased[id] = kept;
  }
  return erased;
}

const SHAPE_KINDS: ReadonlySet<unknown> = new Set<InkShapeKind>([...INK_SHAPE_KINDS, "circle"]);
const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]);
function asShape(v: unknown): InkShape | null {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.kind !== "string" || !v.kind) return null;
  // A kind this version does not know has geometry it cannot validate: keep it
  // whole (the renderers skip it) rather than drop it from the stored drawing.
  if (!SHAPE_KINDS.has(v.kind)) return v as unknown as InkShape;
  if (!isPair(v.start) || !isPair(v.end)) return null;
  return { ...(v as unknown as InkShape), color: typeof v.color === "string" ? v.color : DEFAULT_COLOR, size: finite(v.size) ? v.size : DEFAULT_SIZE };
}

/** `features` / `requires` read as string lists; anything else is dropped. */
function withFeatureLists<T extends { features?: string[]; requires?: string[] }>(target: T, source: Record<string, unknown>): T {
  for (const key of ["features", "requires"] as const) {
    if (!(key in source)) continue;
    if (Array.isArray(source[key])) target[key] = (source[key] as unknown[]).filter((f): f is string => typeof f === "string");
    else delete target[key];
  }
  return target;
}

/** `units`: the pages that can be read. A page whose drawing is unreadable is
 *  dropped (the older fields still hold it); a background of a kind this version
 *  does not know is kept as stored. */
function asUnits(v: unknown): InkPages | null {
  if (!isRecord(v) || v.version !== 1 || !isRecord(v.pages)) return null;
  const pages: InkPages["pages"] = {};
  for (const [key, entry] of Object.entries(v.pages)) {
    if (!isRecord(entry)) continue;
    const doc = asPage(entry.doc);
    if (!doc) continue;
    const size = isRecord(entry.size) && finite(entry.size.width) && finite(entry.size.height) && entry.size.width > 0 && entry.size.height > 0
      ? { width: entry.size.width, height: entry.size.height }
      : { width: doc.page.width, height: doc.page.width * 1.5 };
    const background = isRecord(entry.background) && typeof entry.background.kind === "string"
      ? entry.background as InkBackground : { kind: "blank" } as const;
    pages[key] = { ...(entry as unknown as InkPageRecord), key, background, size, doc };
  }
  const out: InkPages = { ...(v as unknown as InkPages), version: 1, pages };
  if (Array.isArray(v.order)) out.order = v.order.filter((key): key is string => typeof key === "string");
  else delete out.order;
  return out;
}

/** A usable page: a strokes array; missing erasure/page fields get defaults. */
function asPage(v: unknown): InkDocument | null {
  if (!isRecord(v) || !Array.isArray(v.strokes)) return null;
  const seen = new Set<string>();
  const strokes = v.strokes.map(asStroke).filter((stroke): stroke is InkStroke => {
    if (!stroke || seen.has(stroke.id)) return false;
    seen.add(stroke.id);
    return true;
  });
  const doc: InkDocument = {
    ...(v as unknown as InkDocument),
    version: 1,
    strokes,
    erased: asErased(v.erased),
    page: isRecord(v.page) && finite(v.page.width) && v.page.width > 0
      ? { ...(v.page as unknown as InkPage), width: v.page.width }
      : { width: INK_DEFAULT_PAGE_WIDTH },
  };
  if (Array.isArray(v.shapes)) doc.shapes = v.shapes.map(asShape).filter((shape): shape is InkShape => shape !== null);
  else delete doc.shapes;
  return withFeatureLists(doc, v);
}

/** Decode a stored ink_data value. Empty, unreadable or unrecognised values
 *  are "none" (a note opens an empty surface instead of failing); a PDF
 *  envelope keeps only its readable pages. Records are not validated beyond
 *  being an array: `A` is the caller's claim about them. */
export function decodeInk<A extends InkAnnotation = InkAnnotation>(raw: string | null | undefined): DecodedInk<A> {
  if (!raw) return NONE;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return NONE; }
  if (isRecord(value) && value.version === 1 && isRecord(value.pages)) {
    const pages: InkEnvelope<A>["pages"] = {};
    for (const [num, page] of Object.entries(value.pages)) {
      const doc = asPage(page);
      if (doc && Number.isFinite(Number(num))) pages[Number(num)] = doc;
    }
    // Unknown envelope fields ride along (see Format evolution).
    const doc: InkEnvelope<A> = { ...(value as unknown as InkEnvelope<A>), version: 1, pages };
    if (Array.isArray(value.annotations)) doc.annotations = value.annotations as A[];
    else delete doc.annotations;
    const units = asUnits(value.units);
    if (units) doc.units = units;
    else delete doc.units;
    if (typeof value.unitsFrom !== "string") delete doc.unitsFrom;
    return { kind: "pdf", doc: withFeatureLists(doc, value) };
  }
  const page = asPage(value);
  if (!page) return NONE;
  // A note's further pages: the readable ones; anything else there is dropped.
  const more = isRecord(value) ? asUnits(value.morePages) : null;
  if (more) {
    delete more.pages[INK_PAGE_KEY];
    page.morePages = more;
  } else if (isRecord(value) && isRecord(value.morePages) && typeof value.morePages.version === "number" && value.morePages.version > 1) {
    // A newer version's pages: keep the whole value untouched and make the
    // drawing read-only (`requires`), so saving never drops them.
    page.morePages = value.morePages as unknown as InkPages;
    page.requires = [...new Set([...(page.requires ?? []), `morePages-v${String(value.morePages.version)}`])];
  } else delete page.morePages;
  return { kind: "page", doc: page };
}

/** The stored form of either shape. */
export function encodeInk(doc: InkDocument | InkEnvelope<InkAnnotation>): string {
  return JSON.stringify(doc);
}
