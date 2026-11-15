// The slug rule — one for the server (note, tag and collection slugs, the
// site's wikilink hrefs) and for the app's optimistic rows, so a note made
// offline links the same way before and after the server answers. Letters,
// digits and combining marks of any script stay (a CJK title keeps its
// characters, a Devanagari one its vowel signs — word.ts), spaces become
// single dashes, everything else goes. The value is read in NFC first, so a
// decomposed (NFD) title slugs as its composed twin does.
//
// Slugs already stored keep the value the older rule gave them (no re-slug):
// a link still finds such a note by its title.
//
// At most SLUG_MAX characters (user-perceived, so a letter and its marks stay
// together), cut on a character boundary: a long title gives a usable address
// (GAP-240). A slug made before the cap keeps its length until the next rename;
// the site redirects the old address (publishing/siteRedirects.ts).

import { cutToGraphemes } from "./graphemes.js";
import { normalizeText, WORD_CHARS } from "./word.js";

export const SLUG_MAX = 80;

const NON_SLUG_CHAR = new RegExp(`[^${WORD_CHARS}-]`, "gu");

/** `value` as a slug, or `fallback` when nothing is left. */
export function slugify(value: string, fallback = "node"): string {
  // The cut comes after the rule and drops a dash it leaves at the end.
  return cutToGraphemes(linkSlug(value, fallback), SLUG_MAX).replace(/-+$/, "") || fallback;
}

/** The slug a link target names a note by: the slug rule without the
 *  SLUG_MAX cut. A cut slug would also name every note whose long title
 *  starts the same way (`[[<title B>]]` finding note A, slugged to the same
 *  80 characters), and a slug stored before the cap, longer than it, could
 *  never be named again. A target of at most SLUG_MAX characters gets
 *  slugify's value. */
export function linkSlug(value: string, fallback = "node"): string {
  // Invisible format characters (zero-width space / joiner, soft hyphen, word
  // joiner, BOM) are no part of a name. U+FEFF is also "whitespace" to \s, so
  // left in it would turn into a dash: "的\ufeff的" is not "的-的". They go
  // before the NFC step: "e" + ZWSP + U+0301 composes once the ZWSP is gone.
  const slug = normalizeText(value.replace(/\p{Cf}/gu, ""))
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(NON_SLUG_CHAR, "")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  // Dropping a character can put a letter next to a mark it was apart from
  // ("a😀" + U+0301): compose again, so slugify(slugify(x)) is slugify(x).
  return normalizeText(slug) || fallback;
}
