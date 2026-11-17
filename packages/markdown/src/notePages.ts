// Which pages a note has, in order: blank pages and runs of pages of a PDF file. The attribute `note_pages`.
// docs/architecture/proposals/pdf-pages-in-note-2026-11-16.md (2.2, 2.3). Pure: no DOM, no pipeline imports.
//
//   { "version": 1, "runs": [
//       { "id": "b1", "kind": "blank" },
//       { "id": "r1", "kind": "pdf", "file": "/api/media/x.pdf", "from": 1, "to": 3 },
//       { "id": "b2", "kind": "blank" } ] }
//
// This is only the LIST. The strokes of a page are in `note_ink` under the page's key (a page with no strokes has no
// record there), the text of a PDF in `pdf_text`; nothing about a page is stored twice.
//
// Page keys (what `note_ink`, `page_text`, `page_images` address a page by):
//   blank run          its `id`
//   page n of a PDF    `${keyPrefix}:${n}`, n the page's number IN THE FILE (so cutting a run never changes it);
//                      `keyPrefix` is the run's own `keyPrefix`, else its `id`. A note from before this format
//                      (`pagesFromPdfUrl`) has one run with id "pdf": its keys are the `pdf:<n>` it always had.
// Rules the format keeps:
//   1. A key once used in a note is not used again, also after its page is deleted (an attempt or a mark is
//      addressed by it). The one place that makes ids is `mintPageId`; a new run's id AND key prefix are minted, so a
//      PDF added again after a page was deleted never gets the old keys.
//   2. Segment ids are unique in a note. Cutting a run in two (a blank page between two PDF pages) gives the second
//      half a NEW id minted by the writer and carried with the write; it keeps the `keyPrefix`, so its pages' keys
//      do not change.
//   3. The ranges of runs that share a key prefix do not overlap, and a prefix names one file.
// Merge of two devices' edits: `mergeNotePages` below.

import { MEDIA_URL_PREFIX, isMediaId } from "./mediaRefs.js";

const NOTE_PAGES_VERSION = 1;
const MAX_RUNS = 2000;
/** Page numbers (`from`, `to`) up to this; a PDF of more pages is not listed whole. */
const MAX_PAGE_NUMBER = 10_000;
/** Distinct files in one list, and the pages that a list's runs name in all (a run to the end of its file counts as one until its file is open;
 *  expandNotePages stops at MAX_EXPANDED_PAGES): a stored value cannot make a reader lay out millions of pages or fetch a hundred files. */
const MAX_FILES = 50;
const MAX_LISTED_PAGES = 20_000;
const MAX_EXPANDED_PAGES = 20_000;
const MAX_ID_LENGTH = 200;
const MAX_FILE_LENGTH = 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** A PDF run's id may also hold the "." of an id the merge derived (below); a blank page's id, which is its page key, and a key prefix may not. */
const PDF_RUN_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
/** Ids no run may carry: `page` is a handwriting note's first page, `pdf` the id `pagesFromPdfUrl` gives the one run of a note
 *  made before this format (a new run must never reuse its keys). */
const RESERVED_IDS: readonly string[] = ["page", "pdf"];
const LEGACY_PDF_RUN_ID = "pdf";

export type PageRun =
  | { id: string; kind: "blank" }
  | { id: string; kind: "pdf"; file: string; from: number; to: number | null; keyPrefix?: string };

export interface NotePages { version: 1; runs: PageRun[] }

type NotePagesDecoded =
  | { ok: true; pages: NotePages }
  | { ok: false; reason: "empty" | "invalid" | "newer" };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A file of this site's own media store (`/api/media/<id>`, the grammar mediaRefs.ts reads): a list cannot send a reader's browser to another address. */
const isOwnMediaFile = (file: string): boolean => file.length <= MAX_FILE_LENGTH && file.startsWith(MEDIA_URL_PREFIX) && isMediaId(file.slice(MEDIA_URL_PREFIX.length));
const validId = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_ID_LENGTH && ID_PATTERN.test(v);
const validPdfRunId = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_ID_LENGTH && PDF_RUN_ID_PATTERN.test(v);
const validPageNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_PAGE_NUMBER;

/** The prefix of the keys of a PDF run's pages. */
const runKeyPrefix = (run: Extract<PageRun, { kind: "pdf" }>): string => run.keyPrefix ?? run.id;
/** The key prefix and the page number in the file of a PDF page's key (`r1:3`), or null for a key that is not one. The one place that reads it. */
export function parsePdfPageKey(key: string): { prefix: string; page: number } | null {
  const m = /^(.+):(\d+)$/.exec(key);
  return m ? { prefix: m[1]!, page: Number(m[2]) } : null;
}
/** The key of page `n` (the number in the file) of a PDF run. */
const pdfRunPageKey = (run: Extract<PageRun, { kind: "pdf" }>, n: number): string => `${runKeyPrefix(run)}:${n}`;

/** `pages` when it keeps the rules above, else null. Known fields only: a newer format raises `version` instead. */
function validateNotePages(value: unknown): NotePages | null {
  if (!isRecord(value) || value.version !== NOTE_PAGES_VERSION || !Array.isArray(value.runs) || value.runs.length > MAX_RUNS) return null;
  const runs: PageRun[] = [];
  const ids = new Set<string>();
  const fileOfPrefix = new Map<string, string>();
  const rangesOfPrefix = new Map<string, Array<[number, number]>>();
  const files = new Set<string>();
  let listed = 0;
  for (const raw of value.runs) {
    if (!isRecord(raw) || (raw.kind === "pdf" ? !validPdfRunId(raw.id) : !validId(raw.id))) return null;
    const id = raw.id as string;
    if (ids.has(id) || RESERVED_IDS.includes(id) && id !== LEGACY_PDF_RUN_ID) return null;
    ids.add(id);
    if (raw.kind === "blank") {
      if (id === LEGACY_PDF_RUN_ID) return null;
      if (++listed > MAX_LISTED_PAGES) return null;
      runs.push({ id, kind: "blank" });
      continue;
    }
    if (raw.kind !== "pdf" || typeof raw.file !== "string" || !isOwnMediaFile(raw.file)) return null;
    if (!validPageNumber(raw.from) || !(raw.to === null || validPageNumber(raw.to) && raw.to >= raw.from)) return null;
    if (raw.keyPrefix !== undefined && !validId(raw.keyPrefix)) return null;
    const run: Extract<PageRun, { kind: "pdf" }> = { id, kind: "pdf", file: raw.file, from: raw.from, to: raw.to };
    if (raw.keyPrefix !== undefined && raw.keyPrefix !== id) run.keyPrefix = raw.keyPrefix;
    files.add(run.file);
    listed += run.to === null ? 1 : run.to - run.from + 1;
    if (files.size > MAX_FILES || listed > MAX_LISTED_PAGES) return null;
    const prefix = runKeyPrefix(run);
    if (fileOfPrefix.has(prefix) && fileOfPrefix.get(prefix) !== run.file) return null;
    fileOfPrefix.set(prefix, run.file);
    const ranges = rangesOfPrefix.get(prefix) ?? [];
    const hi = run.to ?? Infinity;
    if (ranges.some(([lo, top]) => run.from <= top && lo <= hi)) return null;
    ranges.push([run.from, hi]);
    rangesOfPrefix.set(prefix, ranges);
    runs.push(run);
  }
  // A blank run's id is its page key: it must not be the prefix of a PDF run's keys either.
  for (const run of runs) if (run.kind === "blank" && fileOfPrefix.has(run.id)) return null;
  return { version: NOTE_PAGES_VERSION, runs };
}

/** Decode a stored `note_pages` value. Empty, unreadable or rule-breaking values are not pages (the note shows as it
 *  did before); a `version` above ours is `newer`: the host shows the note read-only and never saves over it. */
export function decodeNotePages(raw: string | null | undefined): NotePagesDecoded {
  if (raw == null || raw.trim() === "") return { ok: false, reason: "empty" };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: "invalid" }; }
  if (isRecord(parsed) && typeof parsed.version === "number" && parsed.version > NOTE_PAGES_VERSION) return { ok: false, reason: "newer" };
  const pages = validateNotePages(parsed);
  return pages ? { ok: true, pages } : { ok: false, reason: "invalid" };
}

/** The stored form: fixed key order, so equal pages are equal strings (a write compares them). */
export function encodeNotePages(pages: NotePages): string {
  return JSON.stringify({
    version: NOTE_PAGES_VERSION,
    runs: pages.runs.map((r) => r.kind === "blank" ? { id: r.id, kind: "blank" } : {
      id: r.id, kind: "pdf", file: r.file, from: r.from, to: r.to, ...(r.keyPrefix !== undefined ? { keyPrefix: r.keyPrefix } : {}),
    }),
  });
}

/** A note made before this format: its `pdf_url` is one run, every page of the file. The one reader of `pdf_url`. The run's
 *  id "pdf" makes the page keys the `pdf:<n>` that `page_text`, `page_images` and a PDF's strokes are already stored under. */
export const pagesFromPdfUrl = (pdfUrl: string): NotePages => ({ version: NOTE_PAGES_VERSION, runs: [{ id: LEGACY_PDF_RUN_ID, kind: "pdf", file: pdfUrl, from: 1, to: null }] });

/** The pages of a note: its `note_pages`, else (a note made before) its `pdf_url` as one run, else none. A `newer` or broken
 *  `note_pages` is none: the caller decides what to do about the value it could not read. */
export function notePagesOf(attrs: { note_pages?: string | null; pdf_url?: string | null }): NotePages | null {
  const decoded = decodeNotePages(attrs.note_pages);
  if (decoded.ok) return decoded.pages;
  return attrs.pdf_url ? pagesFromPdfUrl(attrs.pdf_url) : null;
}

/** One page of the list, as the host lays it out. */
export interface NotePageEntry {
  key: string;
  runId: string;
  /** Set for a PDF page: the file and the page's number in it. */
  pdf?: { file: string; page: number };
}

/** The pages in order, one entry each. A PDF run that runs to the end of its file needs the file's page count
 *  (`pageCount`; null while it is not known on this device): such a run has no entries yet and its file is in `unknownFiles`.
 *  A count that is known also cuts a `to` past the end short. */
export function expandNotePages(pages: NotePages, pageCount: (file: string) => number | null): { entries: NotePageEntry[]; unknownFiles: string[] } {
  const entries: NotePageEntry[] = [];
  const unknownFiles: string[] = [];
  for (const run of pages.runs) {
    if (run.kind === "blank") { entries.push({ key: run.id, runId: run.id }); continue; }
    const count = pageCount(run.file);
    const last = run.to === null ? count : count === null ? run.to : Math.min(run.to, count);
    if (last === null) { if (!unknownFiles.includes(run.file)) unknownFiles.push(run.file); continue; }
    for (let n = run.from; n <= last && entries.length < MAX_EXPANDED_PAGES; n++) entries.push({ key: pdfRunPageKey(run, n), runId: run.id, pdf: { file: run.file, page: n } });
  }
  return { entries, unknownFiles };
}

/** The files the pages use, once each. */
export const notePagesFiles = (pages: NotePages): string[] => [...new Set(pages.runs.flatMap((r) => r.kind === "pdf" ? [r.file] : []))];

/** A sentence for tools that read the list (`getNode`): how many pages and which are PDF, without the stored value.
 *  "5 pages: blank, PDF 1-3, blank"; a run to the end of its file has no known count ("PDF 1-end"). */
export function summarizeNotePages(pages: NotePages): string {
  const parts = pages.runs.map((r) => r.kind === "blank" ? "blank" : `PDF ${r.from}-${r.to ?? "end"}`);
  const open = pages.runs.some((r) => r.kind === "pdf" && r.to === null);
  const known = pages.runs.reduce((sum, r) => sum + (r.kind === "blank" ? 1 : r.to === null ? 0 : r.to - r.from + 1), 0);
  const count = open ? (known > 0 ? `${known}+ pages` : "pages") : `${known} page${known === 1 ? "" : "s"}`;
  return `${count}: ${parts.join(", ")}`;
}

// ── Writing: the one place that makes ids ───────────────────────────────────

const newUuid = (): string => globalThis.crypto.randomUUID();

/** Every id and key prefix a list uses: a new id must not be one of them. */
function idsInUse(pages: NotePages): Set<string> {
  const used = new Set<string>();
  for (const r of pages.runs) { used.add(r.id); if (r.kind === "pdf") used.add(runKeyPrefix(r)); }
  return used;
}

/** A new id for a run, and for the key prefix of a PDF run: a uuid that is none of `inUse` (the ids of the list, the keys `note_ink`
 *  and the other page attributes hold) and not reserved. A uuid is not guessed twice, so an id given up by a deleted page
 *  stays given up; `random` is for tests. THE place page keys are made. */
export function mintPageId(inUse: Iterable<string>, random: () => string = newUuid): string {
  const used = new Set(inUse);
  for (let i = 0; i < 1000; i++) {
    const id = random();
    if (validId(id) && !used.has(id) && !RESERVED_IDS.includes(id)) return id;
  }
  throw new Error("mintPageId: no free id");
}

/** `pages` with a blank page after the page `after` (a page key, or "end"), and the new page's key. When `after` is in the
 *  middle of a PDF run the run is cut: the first half keeps its id, the second gets a new one (rule 2) and keeps the key prefix,
 *  so no page's key changes. `inUse`: the keys the note's other attributes hold. A key that is not a page of the list: null. */
export function insertBlankPage(pages: NotePages, after: string | "end", inUse: Iterable<string> = [], random?: () => string): { pages: NotePages; key: string } | null {
  const used = new Set([...inUse, ...idsInUse(pages)]);
  const runs = [...pages.runs];
  let at = runs.length;
  let cut: PageRun | null = null;
  if (after !== "end") {
    at = -1;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]!;
      if (run.kind === "blank") { if (run.id === after) { at = i + 1; break; } continue; }
      const parsed = parsePdfPageKey(after);
      const n = parsed && parsed.prefix === runKeyPrefix(run) ? parsed.page : -1;
      if (n < run.from || run.to !== null && n > run.to) continue;
      if (run.to !== null && n === run.to) { at = i + 1; break; }
      const tail: PageRun = { id: mintPageId(used, random), kind: "pdf", file: run.file, from: n + 1, to: run.to, keyPrefix: runKeyPrefix(run) };
      used.add(tail.id);
      runs[i] = { ...run, to: n };
      cut = tail;
      at = i + 1;
      break;
    }
    if (at < 0) return null;
  }
  const blank: PageRun = { id: mintPageId(used, random), kind: "blank" };
  runs.splice(at, 0, blank, ...(cut ? [cut] : []));
  return { pages: { version: NOTE_PAGES_VERSION, runs }, key: blank.id };
}

// ── Merge ───────────────────────────────────────────────────────────────────
// Two devices changed the list from the same base. A page is identified by its key (a blank run's id; a PDF page's
// prefix and number), so the merge works on pages, not on runs: a run is only how a stretch of them is written down.
//   - a page on both sides is kept; a page one side added is kept; a page in the base that either side removed is removed
//     (without a base nothing is removed: a page one side lacks may be a page it never saw);
//   - the order: every side's order of the pages it has is respected; where sides disagree (both added a page after the
//     same page) the smaller key goes first — never the order the sides arrived in;
//   - two devices that cut the same run at once each minted their own id for the second half: the pages are the same
//     pages, so the result has each page once, and each stretch is written with the smallest id any side gave it;
//     an id that would then appear twice (a run deleted in the middle) is derived from the page it starts at
//     (`<id>.<prefix>.<page>`; a derived id counts as the id it was derived from, or the result would depend on which merge came first).
// A pure function of its three strings; commutative for two heads. For three or more the core folds the heads in a FIXED order
// (sorted by value), which is what makes the result independent of arrival order: pairwise in any order the pages are the same and
// every device's own order is kept (properties/notePages.property.test.ts), but not always the same bytes — not when a base page that
// one device deleted stood between pages two other devices added, and not with no base (both pinned there with it.fails).
// A list of a version this one does not read is never merged and never replaced: the stored one comes back as it is, `clean: false`
// (the server refuses the write with a plain sentence). A result that is not a valid list (a blank page's id that another side uses as
// the key prefix of a PDF run) is not written either: the stored list comes back, `clean: false`.

type Piece = { prefix: string; file: string; lo: number; hi: number };
/** The id a derived id comes from. */
const rootOf = (id: string): string => id.split(".")[0]!;
const lessThan = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function mergeNotePages(base: string | null, incoming: string, current: string): { merged: string; clean: boolean } {
  const a = decodeNotePages(incoming);
  const c = decodeNotePages(current);
  if (!a.ok && a.reason === "newer" || !c.ok && c.reason === "newer") return { merged: current, clean: false };
  if (!a.ok || !c.ok) {
    // One side is not a list at all: keep a side that is, else the incoming one.
    return { merged: a.ok ? incoming : c.ok ? current : incoming, clean: false };
  }
  const b = base === null ? null : decodeNotePages(base);
  const baseSide = b?.ok ? b.pages : null;
  let clean = baseSide !== null;

  const sides = [a.pages, c.pages];
  // Cut points per key prefix: every range of every list, so that each piece is wholly inside or outside every run.
  const cuts = new Map<string, Set<number>>();
  for (const list of [...sides, ...(baseSide ? [baseSide] : [])]) {
    for (const r of list.runs) {
      if (r.kind !== "pdf") continue;
      const set = cuts.get(runKeyPrefix(r)) ?? new Set<number>();
      set.add(r.from);
      if (r.to !== null) set.add(r.to + 1);
      cuts.set(runKeyPrefix(r), set);
    }
  }
  const points = new Map([...cuts].map(([prefix, set]) => [prefix, [...set].sort((x, y) => x - y)] as const));
  /** The pieces of `run`'s range, in order. */
  const piecesOf = (run: Extract<PageRun, { kind: "pdf" }>): Piece[] => {
    const prefix = runKeyPrefix(run);
    const hiRun = run.to ?? Infinity;
    const list = points.get(prefix)!;
    const out: Piece[] = [];
    for (const lo of list) {
      if (lo < run.from || lo > hiRun) continue;
      const next = list.find((p) => p > lo);
      const hi = next === undefined ? Infinity : next - 1;
      if (hi <= hiRun) out.push({ prefix, file: run.file, lo, hi });
    }
    return out;
  };
  const keyOf = (p: Piece) => `${p.prefix}\u0001${String(p.lo).padStart(9, "0")}`;
  const blankKey = (id: string) => `${id}\u0001`;

  type Seen = { keys: string[]; ids: Map<string, string[]>; files: Map<string, string[]>; pieces: Map<string, Piece> };
  const read = (list: NotePages): Seen => {
    const seen: Seen = { keys: [], ids: new Map(), files: new Map(), pieces: new Map() };
    for (const r of list.runs) {
      if (r.kind === "blank") {
        const key = blankKey(r.id);
        seen.keys.push(key);
        seen.ids.set(key, [r.id]);
        continue;
      }
      for (const piece of piecesOf(r)) {
        const key = keyOf(piece);
        seen.keys.push(key);
        seen.ids.set(key, [r.id]);
        seen.files.set(key, [r.file]);
        seen.pieces.set(key, piece);
      }
    }
    return seen;
  };
  const seenSides = sides.map(read);
  const seenBase = baseSide ? read(baseSide) : null;
  const inBase = new Set(seenBase?.keys ?? []);
  const presence = seenSides.map((s) => new Set(s.keys));
  const kept = new Set<string>();
  for (const s of seenSides) for (const key of s.keys) {
    if (kept.has(key)) continue;
    if (inBase.has(key) ? presence.every((p) => p.has(key)) : true) kept.add(key);
  }

  // The order. Pages of the base that are kept keep the base's order. A page that is not in the base (a device added it) goes after the
  // nearest base page before it on its device that is kept, and the pages that go after the same page are ordered by what their
  // device says (the pages added in a row on one device stay in a row, in that order) and, where no device says, by key, never by which
  // list arrived first. Where a device put a page does not depend on base pages that are gone: so a merge of merges gives the
  // same list in any order of merging (properties/notePages.property.test.ts).
  const baseKeys = seenBase?.keys ?? [];
  const survivors = baseKeys.filter((k) => kept.has(k));
  const anchorOf = new Map<string, string | null>(); // added page -> the kept base page it follows (null: the start)
  const sameRun: Array<[string, string]> = [];
  const survivorRank = new Map(survivors.map((k, i) => [k, i] as const));
  const anchorRank = (key: string | null): number => (key === null ? -1 : survivorRank.get(key)!);
  const survivesAtOrBefore = (key: string | null): string | null => {
    for (let i = key === null ? -1 : baseKeys.indexOf(key); i >= 0; i--) if (kept.has(baseKeys[i]!)) return baseKeys[i]!;
    return null;
  };
  for (const side of seenSides) {
    let nearestBase: string | null = null;
    let previous: { key: string; anchor: string | null } | null = null;
    for (const key of side.keys) {
      if (inBase.has(key)) { nearestBase = key; continue; }
      const anchor = survivesAtOrBefore(nearestBase);
      const known = anchorOf.get(key);
      if (known === undefined || anchorRank(anchor) < anchorRank(known)) anchorOf.set(key, anchor);
      // Two pages one device added keep that device's order also when a base page that is gone stood between them.
      if (previous !== null && previous.anchor === anchor) sameRun.push([previous.key, key]);
      previous = { key, anchor };
    }
  }
  const groupOf = new Map<string | null, string[]>();
  for (const [key, anchor] of anchorOf) {
    if (!kept.has(key)) continue;
    const list = groupOf.get(anchor) ?? [];
    list.push(key);
    groupOf.set(anchor, list);
  }
  /** The pages added after one page: the smallest key first among those no page must come before. */
  const ordered = (group: string[]): string[] => {
    const inGroup = new Set(group);
    const before = new Map<string, number>(group.map((k) => [k, 0]));
    const next = new Map<string, Set<string>>();
    for (const [x, y] of sameRun) {
      if (!inGroup.has(x) || !inGroup.has(y)) continue;
      const set = next.get(x) ?? new Set<string>();
      if (!set.has(y)) { set.add(y); next.set(x, set); before.set(y, before.get(y)! + 1); }
    }
    const left = new Set(group);
    const ready = group.filter((k) => before.get(k) === 0).sort(lessThan);
    const out: string[] = [];
    while (left.size > 0) {
      let key = ready.shift();
      if (key === undefined) {
        // Devices that put the same pages in a different order (nothing writes that): the smallest key goes.
        key = [...left].sort(lessThan)[0]!;
        clean = false;
      }
      if (!left.delete(key)) continue;
      out.push(key);
      for (const to of next.get(key) ?? []) {
        before.set(to, before.get(to)! - 1);
        if (before.get(to) === 0 && left.has(to)) { ready.push(to); ready.sort(lessThan); }
      }
    }
    return out;
  };
  const order: string[] = [...ordered(groupOf.get(null) ?? [])];
  for (const key of survivors) order.push(key, ...ordered(groupOf.get(key) ?? []));

  // Write the order down as runs. A key prefix names one file: when the sides disagree (nothing writes that) the smallest wins.
  const filesOfPrefix = new Map<string, Set<string>>();
  for (const s of seenSides) for (const piece of s.pieces.values()) {
    const set = filesOfPrefix.get(piece.prefix) ?? new Set<string>();
    set.add(piece.file);
    filesOfPrefix.set(piece.prefix, set);
  }
  const fileOf = (prefix: string): string => {
    const files = [...filesOfPrefix.get(prefix)!].sort(lessThan);
    if (files.length > 1) clean = false;
    return files[0]!;
  };
  const runs: PageRun[] = [];
  const usedIds = new Set<string>();
  const idFor = (preferred: string, prefix: string, lo: number): string => {
    let id = preferred;
    if (usedIds.has(id)) id = `${preferred}.${prefix}.${lo}`;
    while (usedIds.has(id)) id += "_";
    usedIds.add(id);
    return id;
  };
  type PdfRun = Extract<PageRun, { kind: "pdf" }>;
  const state: { open: { run: PdfRun; prefix: string; hi: number; chosen: string } | null } = { open: null };
  const flush = () => { if (state.open) runs.push(state.open.run); state.open = null; };
  for (const key of order) {
    if (key.endsWith("\u0001")) {
      flush();
      const id = key.slice(0, -1);
      runs.push({ id: idFor(id, id, 0), kind: "blank" });
      continue;
    }
    const piece = seenSides.map((s) => s.pieces.get(key)).find((p) => p)!;
    const chosen = seenSides.flatMap((s) => s.ids.get(key) ?? []).map(rootOf).reduce((x, y) => (y < x ? y : x));
    const file = fileOf(piece.prefix);
    const cur = state.open;
    if (cur && cur.prefix === piece.prefix && cur.chosen === chosen && cur.hi + 1 === piece.lo) {
      cur.hi = piece.hi;
      cur.run.to = piece.hi === Infinity ? null : piece.hi;
      continue;
    }
    flush();
    const id = idFor(chosen, piece.prefix, piece.lo);
    const run: PdfRun = { id, kind: "pdf", file, from: piece.lo, to: piece.hi === Infinity ? null : piece.hi };
    if (piece.prefix !== id) run.keyPrefix = piece.prefix;
    state.open = { run, prefix: piece.prefix, hi: piece.hi, chosen };
  }
  flush();
  const merged = encodeNotePages({ version: NOTE_PAGES_VERSION, runs });
  if (!decodeNotePages(merged).ok) return { merged: current, clean: false };
  return { merged, clean };
}
