// The one HTML escape and the one HTML entity decode (app, server, exports).
//
// Both are single-pass: one regex, one lookup. A decode written as a chain of
// replaces gets the order wrong sooner or later — decoding `&amp;` before
// `&lt;` turns the text `&amp;lt;` (a literal "&lt;") into "<". Here every
// entity is read once from the original string, so the output of one entity
// is never read again as the start of another.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** Escape text for an HTML or XML text node or a double-quoted attribute
 *  value (feeds, sitemaps, OPML, the site head, exports). `'` is left as is:
 *  every caller quotes attributes with `"`, and the site head's CSP reads
 *  `'self'` literally. */
export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"]/g, (ch) => ESCAPES[ch]!);
}

// The named entities Onden reads back. `&nbsp;` becomes a plain space: every
// caller turns HTML into plain text (previews, titles, prompt material).
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z]+));/g;

function fromCodePoint(cp: number): string | null {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return null;
  if (cp >= 0xd800 && cp <= 0xdfff) return null; // lone surrogate
  return String.fromCodePoint(cp);
}

/** Decode HTML entities in one pass: the five XML entities, `&nbsp;`, and
 *  decimal / hex numeric references. An unknown or invalid entity is kept as
 *  written. */
export function decodeHtmlEntities(value: string): string {
  return String(value).replace(ENTITY_RE, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex !== undefined) return fromCodePoint(parseInt(hex, 16)) ?? whole;
    if (dec !== undefined) return fromCodePoint(parseInt(dec, 10)) ?? whole;
    // Entity names are case-sensitive (`&AMP;` is not decoded here).
    return Object.hasOwn(NAMED, name!) ? NAMED[name!] : whole;
  });
}
