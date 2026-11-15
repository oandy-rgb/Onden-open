// Note size caps (depth audit D67) — one rule for every writer. The server
// refuses a note over them at every entry (REST nodeSchema, the agent tools,
// createNote, applyBodyChange); importers skip an over-size body as
// `too_large` and shorten a derived title; the app checks before it queues a
// write, since a queued write over a cap would be refused on every sync.
//
// The title cap is the 500 characters the web app already promises
// (frontend lib/jsonCanvas.ts); the body cap sits well above the 1 MiB body
// the boundary sweep round-trips. Both count UTF-16 units (String#length,
// what zod's .max() counts).

import { cutToUnits } from "./graphemes.js";

export const NODE_TITLE_MAX = 500;
export const NODE_MARKDOWN_MAX = 2_000_000;

/** A UTF-16 surrogate with no partner: not text UTF-8 can hold. */
export const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export const hasLoneSurrogate = (text: string | null | undefined): boolean => (text ?? "").search(LONE_SURROGATE) >= 0;

/** Which cap a note breaks, or null when it fits. Text a database cannot keep as written is refused here
 *  with the caps: U+0000 ("contains_nul") and a lone surrogate, which is not UTF-8 and would be stored as
 *  U+FFFD instead ("invalid_text"). */
export function noteSizeProblem(note: { title?: string | null; markdown?: string | null }): "title_too_long" | "too_large" | "contains_nul" | "invalid_text" | null {
  if (note.markdown?.includes("\u0000") || note.title?.includes("\u0000")) return "contains_nul";
  if (hasLoneSurrogate(note.markdown) || hasLoneSurrogate(note.title)) return "invalid_text";
  if ((note.markdown?.length ?? 0) > NODE_MARKDOWN_MAX) return "too_large";
  if ((note.title?.length ?? 0) > NODE_TITLE_MAX) return "title_too_long";
  return null;
}

/** A title derived from content (a heading, a file name, a feed item, a CSV
 *  cell) cut to the cap (or to `max`, leaving room for a suffix); never splits
 *  a grapheme cluster (graphemes.ts). Unchanged when it fits.
 *  Example: clampNoteTitle("x".repeat(600)).length === 500. */
export function clampNoteTitle(title: string, max = NODE_TITLE_MAX): string {
  if (title.length <= max) return title;
  return cutToUnits(title, max).trimEnd();
}
