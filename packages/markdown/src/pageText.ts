// Text boxes on a page (`page_text`) — the stored format and its three-way
// merge, one module for the app (lib/pageText, which edits and saves it) and
// the server (which merges a save into what another device stored meanwhile,
// services/attributeWrites). Pure: no DOM, no pipeline imports.
//
//   { v: 1, pages: { [pageKey]: { boxes: [{ id, x, y, w, text, size, color, align, updated_at }] } } }
//
// It is its own attribute, not part of `ink_data`: typing and pen strokes are
// different edits, so they never merge against (or conflict with) each other,
// and the stroke format can change without touching this one.
//
// pageKey says which page a box is on, whatever the page's background is:
//   pdf:<n>       page n (1-based) of a PDF note
//   page          the one page of a handwriting note (it has no page id)
//   slide:<id>    a slide of a deck (reserved; the deck editor uses it later)
// Coordinates and sizes are PAGE UNITS, independent of zoom: x/y the box's
// top-left, w its width, size its font size. A PDF page is 1000 units wide
// (its height follows the page's ratio); a handwriting page uses its own page
// coordinates (1000 wide). The height of a box is whatever its text needs.
// `text` is plain text (it may contain newlines); no bold or other styling.
//
// Merge, by box id and per page (the same idea as ink's strokes):
//   - boxes added on either side are kept; different boxes never collide;
//   - changed on one side only: that side's version;
//   - changed on both sides differently: the incoming (later) save wins and
//     the stored version is reported as a conflict, so a person can get it back;
//   - removed on one side, changed on the other: the change is kept (reported).
// Unknown fields of a box, a page or the document travel with it unchanged, so
// a newer version's data survives an older editor (a value with `v` above
// PAGE_TEXT_VERSION is opened read-only instead: isPageTextReadOnly).

import { cutToUnits } from "./graphemes.js";
import { isJsonRecord as isRecord, encodePagedItems, mergePagedItems, parseJsonRecord, revertPagedConflicts } from "./jsonMerge.js";

export const PAGE_TEXT_VERSION = 1;
export const PAGE_TEXT_ATTRIBUTE = "page_text";
/** Fixed key of the single page of a handwriting note. */
export const INK_PAGE_KEY = "page";
export const pdfPageKey = (page: number): string => `pdf:${page}`;

export const PAGE_TEXT_SIZES = { small: 16, medium: 22, large: 32 } as const;
export type PageTextSizeId = keyof typeof PAGE_TEXT_SIZES;
export const PAGE_TEXT_DEFAULT_SIZE = PAGE_TEXT_SIZES.medium;
export const PAGE_TEXT_DEFAULT_WIDTH = 320;
export const PAGE_TEXT_MIN_WIDTH = 40;
export const PAGE_TEXT_MAX_CHARS = 20_000;
export const PAGE_TEXT_ALIGNS = ["left", "center", "right"] as const;
export type PageTextAlign = (typeof PAGE_TEXT_ALIGNS)[number];

export type PageTextBox = {
  id: string;
  x: number;
  y: number;
  w: number;
  text: string;
  size: number;
  color: string;
  align: PageTextAlign;
  /** ISO time of the last edit of this box. */
  updated_at: string;
};
export type PageTextPage = { boxes: PageTextBox[] };
export type PageTextDoc = { v: 1; pages: Record<string, PageTextPage> };

export type PageTextConflict = { pageKey: string; id: string };
export type PageTextMergeResult = { value: string; conflicts: PageTextConflict[] };

const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const DEFAULT_COLOR = "#1f1f1f";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const emptyPageText = (): PageTextDoc => ({ v: 1, pages: {} });

/** One stored box repaired to a usable one, or null when it has no id. Fields
 *  this version does not know stay on it. */
function readBox(raw: unknown): PageTextBox | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "") return null;
  return {
    ...raw,
    id: raw.id,
    x: finite(raw.x) ? raw.x : 0,
    y: finite(raw.y) ? raw.y : 0,
    w: finite(raw.w) ? Math.max(PAGE_TEXT_MIN_WIDTH, raw.w) : PAGE_TEXT_DEFAULT_WIDTH,
    text: typeof raw.text === "string" ? cutToUnits(raw.text, PAGE_TEXT_MAX_CHARS) : "",
    size: finite(raw.size) && raw.size > 0 ? raw.size : PAGE_TEXT_DEFAULT_SIZE,
    color: typeof raw.color === "string" && SAFE_COLOR.test(raw.color) ? raw.color : DEFAULT_COLOR,
    align: PAGE_TEXT_ALIGNS.includes(raw.align as PageTextAlign) ? (raw.align as PageTextAlign) : "left",
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
  };
}

/** The text boxes in a stored value; empty for none or an unreadable value.
 *  Malformed boxes are repaired or dropped; unknown fields are kept. */
export function decodePageText(raw: string | null | undefined): PageTextDoc {
  const value = parseJsonRecord(raw);
  if (!value || !isRecord(value.pages)) return emptyPageText();
  const pages: Record<string, PageTextPage> = {};
  for (const [key, page] of Object.entries(value.pages)) {
    if (!isRecord(page) || !Array.isArray(page.boxes)) continue;
    const seen = new Set<string>();
    const boxes: PageTextBox[] = [];
    for (const item of page.boxes) {
      const box = readBox(item);
      if (!box || seen.has(box.id)) continue; // a duplicated id keeps its first box
      seen.add(box.id);
      boxes.push(box);
    }
    pages[key] = { ...page, boxes };
  }
  return { ...value, v: 1, pages } as PageTextDoc;
}

/** The stored form: pages without boxes are left out, so a note whose text
 *  was all removed stores almost nothing. */
export function encodePageText(doc: PageTextDoc): string {
  return encodePagedItems(doc, "boxes", PAGE_TEXT_VERSION);
}

/** Written by a newer version that this one must not edit (it would drop what
 *  it does not understand): show it, never save it. */
export function isPageTextReadOnly(raw: string | null | undefined): boolean {
  const version = parseJsonRecord(raw)?.v;
  return finite(version) && version > PAGE_TEXT_VERSION;
}

export const pageTextBoxes = (doc: PageTextDoc, pageKey: string): readonly PageTextBox[] => doc.pages[pageKey]?.boxes ?? [];

/** All the text of the boxes, page by page (PDF pages in number order, then
 *  other keys), one line per box — what search indexes. */
export function pageTextPlain(raw: string | null | undefined): string {
  // Reads the stored value directly, not through decodePageText: the local
  // search worker imports this, and the repairs (and the grapheme cut they
  // use) would only add to its bundle (scripts/check-worker-bundle.mjs).
  const pages = parseJsonRecord(raw)?.pages;
  if (!isRecord(pages)) return "";
  const order = (key: string) => (key.startsWith("pdf:") ? Number(key.slice(4)) : Number.MAX_SAFE_INTEGER);
  return Object.keys(pages)
    .sort((a, b) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0))
    .flatMap((key) => {
      const page = pages[key];
      if (!isRecord(page) || !Array.isArray(page.boxes)) return [];
      const seen = new Set<string>();
      return page.boxes.flatMap((box: unknown) => {
        if (!isRecord(box) || typeof box.id !== "string" || box.id === "" || seen.has(box.id)) return [];
        seen.add(box.id);
        return typeof box.text === "string" ? [box.text.trim()] : [];
      });
    })
    .filter((text) => text !== "")
    .join("\n");
}

// ── Three-way merge ────────────────────────────────────────────────────────

/** Merge a save of the text boxes into what is stored. `base` is the value the
 *  incoming save was made from; `stored` the current one, which another device
 *  may have changed since. Pure and deterministic. An unreadable value merges
 *  as no boxes (keep everything either side has). */
export function mergePageText(base: string | null | undefined, stored: string | null | undefined, incoming: string): PageTextMergeResult {
  const b = decodePageText(base), s = decodePageText(stored), i = decodePageText(incoming);
  const { pages, conflicts } = mergePagedItems(b, s, i, "boxes");
  return { value: encodePageText({ ...s, ...i, v: 1, pages }), conflicts };
}

/** What a merge conflict reverts to: `merged` with only the boxes both sides
 *  changed (`conflicts`) taken back from `overridden` — swapped, removed when
 *  that side had none, or re-added when only it had it. Merging the result over
 *  the text as it is now (base = `merged`) re-applies just those boxes. */
export function revertPageTextConflicts(merged: string, overridden: string, conflicts: readonly PageTextConflict[]): string {
  const doc = decodePageText(merged);
  const theirs = decodePageText(overridden);
  const pages = revertPagedConflicts(doc, theirs, conflicts, "boxes");
  return encodePageText({ ...doc, pages });
}
