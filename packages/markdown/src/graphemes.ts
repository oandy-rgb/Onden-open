// The one way to cut a person's text short. A person counts, moves over and
// deletes text by grapheme cluster ("👩‍👩‍👧‍👦", "🇹🇼", "é" typed as e + U+0301,
// "👍🏽" are one each), but String#slice cuts UTF-16 units: a cut in the
// middle of a cluster leaves half a family, a lone surrogate (shown as "�") or
// a letter without its accent. Every place that shortens user text for a
// title cap, a summary, a notification, a card or a meta description goes
// through here (frontend guards/textCut.guard.test.ts keeps raw slices out).
//
// Intl.Segmenter is a global in every browser Onden supports and in Node, so
// this module imports nothing (it may be read from a worker).

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** How far past a cut to look so the cluster the cut falls in is whole. A
 *  cluster longer than this (stacked combining marks without end) is cut at
 *  the window's edge instead of read to its end. */
const LOOKAHEAD = 64;

/** The grapheme clusters of `text`, in order. */
export function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const part of SEGMENTER.segment(text)) out.push(part.segment);
  return out;
}

/** How many grapheme clusters `text` has (what a person counts as characters). */
export function graphemeCount(text: string): number {
  let n = 0;
  for (const _ of SEGMENTER.segment(text)) n++;
  return n;
}

/** The longest prefix of `text` that ends between clusters and is at most
 *  `maxUnits` UTF-16 units long (the unit String#length and zod's .max()
 *  count). `text` itself when it fits. */
export function cutToUnits(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  const limit = Math.max(0, maxUnits);
  let end = 0;
  for (const part of SEGMENTER.segment(text.slice(0, limit + LOOKAHEAD))) {
    const next = part.index + part.segment.length;
    if (next > limit) break;
    end = next;
  }
  return text.slice(0, end);
}

/** The longest prefix of `text` that ends between clusters and is at most
 *  `maxBytes` bytes in UTF-8 — what a file name limit counts (255 on most
 *  disks; a Chinese character is 3 bytes, an emoji 4). */
export function cutToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (text.length * 3 <= maxBytes || encoder.encode(text).length <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const part of SEGMENTER.segment(text)) {
    bytes += encoder.encode(part.segment).length;
    if (bytes > maxBytes) break;
    end = part.index + part.segment.length;
  }
  return text.slice(0, end);
}

/** The longest prefix of `text` that ends between clusters and holds at most
 *  `maxCodePoints` code points (what `[...text].length` counts). */
export function cutToCodePoints(text: string, maxCodePoints: number): string {
  let units = 0;
  for (let n = 0; n < maxCodePoints && units < text.length; n++) units += text.codePointAt(units)! > 0xffff ? 2 : 1;
  return cutToUnits(text, units);
}

/** The first `maxGraphemes` clusters of `text`. `text` itself when it has no more. */
export function cutToGraphemes(text: string, maxGraphemes: number): string {
  if (text.length <= maxGraphemes) return text; // a cluster is at least one unit
  let n = 0;
  let end = 0;
  for (const part of SEGMENTER.segment(text)) {
    if (n === maxGraphemes) return text.slice(0, end);
    n++;
    end = part.index + part.segment.length;
  }
  return text;
}

/** `text` cut to at most `maxUnits` UTF-16 units including the "…" that marks
 *  the cut, on a cluster boundary, trailing blanks dropped. `text` unchanged
 *  when it fits. For a line that is shown, not stored. */
export function ellipsize(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  return `${cutToUnits(text, Math.max(0, maxUnits - 1)).trimEnd()}…`;
}

/** `text` cut to `max` characters (grapheme clusters: a family emoji, a flag
 *  or a letter with its accent is one) with "…" when something was left out. */
export function plainExcerpt(text: string, max: number): string {
  const kept = cutToGraphemes(text, max);
  return kept.length === text.length ? text : `${kept.trimEnd()}…`;
}
