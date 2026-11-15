// The one alphabet of a word in note text, and the one Unicode form text is
// kept in. Every grammar that reads names out of text (slugs, #tags,
// attribute keys, frontmatter scalars) builds on WORD_CHARS, so they agree on
// what a "letter" is (D58).
//
// Before D58 they read `[\p{L}\p{N}]`, which leaves out combining marks
// (\p{M}): Devanagari, Thai, Bengali and other scripts write vowels as marks,
// so `slugify("हिंदी")` was "हद", "कल", "काल" and "कील" shared one slug (a
// [[link]] got edges to the wrong notes), `#हिंदी` was no tag and `कीमत:: 5`
// no attribute. And nothing chose one Unicode form, so a title from a macOS
// zip (decomposed, NFD) never matched the same link typed elsewhere (NFC).
//
// This module stays tiny and DOM-free: slug.ts imports it, and the app's
// local-DB worker imports slug.ts alone (frontend test/workerImports.test.ts).

/** The body of a character class for one word character — a letter, a mark
 *  or a digit of any script — to put inside `[…]` with any extra characters a
 *  grammar allows (use with the `u` flag). */
export const WORD_CHARS = String.raw`\p{L}\p{M}\p{N}`;

/** One word character, as a regex source fragment (use with the `u` flag). */
export const WORD_CHAR = `[${WORD_CHARS}]`;

/** `text` in the one form Onden stores and compares names in (NFC): what a
 *  title, tag name, attribute key or link target is normalised to when it is
 *  written or imported, and before two of them are compared. */
export function normalizeText(text: string): string {
  return text.normalize("NFC");
}
