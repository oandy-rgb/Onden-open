// ── Matching a typed query against titles, in the browser ────────────────────
// One rule for every picker that filters by title as you type ([[ links, the
// / menu, ⌘K, the sidebar): accents and case are ignored ("cafe" finds
// "Café"; full-width and half-width forms are one, "ａ１" finds "A1"); a
// contiguous match ranks before a scattered one, where the query's characters
// appear in order ("h2" finds "Heading 2"). Ranges are half-open [start, end)
// UTF-16 indices into the ORIGINAL title, widened to whole characters, for
// <SnippetText>. Which note a [[link]] names is not decided here: that is
// exact up to NFC and case (@onden/markdown linkNameKey).

export type TitleMatch = { ranges: [number, number][]; contiguous: boolean };

/** Lowercase, width-folded (`Ａ１` is `a1`, as the server's index folds it),
 *  diacritics dropped, keeping each folded char's source span: the UTF-16
 *  index it starts at and the one after its last unit, so a highlight covers a whole
 *  character (an emoji or 𠮷 is two units). */
function foldIndexed(text: string): { folded: string; start: number[]; end: number[] } {
  let folded = "";
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const next = i + ch.length;
    const part = ch.normalize("NFKC").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    // One entry per UTF-16 unit of `folded` (indexOf and [] count units, so an astral character is two).
    for (let k = 0; k < part.length; k++) { folded += part[k]; start.push(i); end.push(next); }
    i = next;
  }
  return { folded, start, end };
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Whether `text` has anything that joins characters into one cluster (marks,
 *  joiners, variation selectors, astral emoji and flags, Hangul jamo). Without
 *  it every code point is its own cluster and no range needs widening: the
 *  usual title (Latin, CJK) skips the segmenter, which runs per title per key. */
const CLUSTERING = /\p{M}|\u200c|\u200d|[\ufe00-\ufe0f]|[\u1100-\u11ff]|[\u{10000}-\u{10ffff}]/u;

/** `[start, end)` widened to whole grapheme clusters of `text`: a match on the
 *  `e` of a decomposed `é`, or the 👩 of a family, highlights the whole cluster. */
function wholeClusters(text: string, [from, to]: [number, number]): [number, number] {
  if (!CLUSTERING.test(text)) return [from, to];
  let start = from, end = to;
  for (const part of SEGMENTER.segment(text)) {
    const a = part.index, b = part.index + part.segment.length;
    if (from >= a && from < b) start = a;
    if (to > a && to <= b) end = b;
    if (a >= to) break;
  }
  return [start, end];
}

/** How `query` matches `title`, or null. An empty query matches with no ranges.
 *  `scattered: false` keeps only the contiguous match (see containsTitle). */
function match(query: string, title: string, scattered: boolean): TitleMatch | null {
  const q = foldIndexed(query.trim()).folded;
  if (!q) return { ranges: [], contiguous: true };
  const { folded, start, end } = foldIndexed(title);
  const at = folded.indexOf(q);
  if (at >= 0) return { ranges: [wholeClusters(title, [start[at]!, end[at + q.length - 1]!])], contiguous: true };
  if (!scattered) return null;
  const hits: Array<[number, number]> = [];
  for (let h = 0, i = 0; h < folded.length && i < q.length; h++) {
    if (folded[h] === q[i]) { hits.push([start[h]!, end[h]!]); i++; }
  }
  if (hits.length < q.length) return null;
  const ranges: [number, number][] = [];
  for (const hit of hits) {
    const [s, e] = wholeClusters(title, hit);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  }
  return { ranges, contiguous: false };
}

/** Ranked matching, for lists that sort by how well a title fits (⌘K, [[ links):
 *  a contiguous match, else the query's characters in order. */
export function matchTitle(query: string, title: string): TitleMatch | null {
  return match(query, title, true);
}

/** For lists that FILTER a bounded set (pickers capped at N rows, tag and
 *  skill lists, block kinds searched by a long description): only a contiguous
 *  match counts, so "meeting" never pulls in titles that merely contain m-e-e-t-i-n-g
 *  scattered, and never pushes the real "Meeting" past the row cap. Same folding as matchTitle. */
export function containsTitle(query: string, title: string): TitleMatch | null {
  return match(query, title, false);
}

/** How well a title fits the query, best first: 0 the title is the query, 1 it starts with
 *  it, 2 it contains it, 3 the query's characters appear in order. The server orders titles
 *  the same four ways (backend services/textSearch.ts titleTiersFirst). */
function titleTier(match: TitleMatch, title: string): 0 | 1 | 2 | 3 {
  const first = match.ranges[0];
  if (!match.contiguous) return 3;
  if (!first || first[0] !== 0) return match.ranges.length === 0 ? 0 : 2;
  return first[1] >= title.trimEnd().length ? 0 : 1;
}

/** The items whose title matches, best tier first (exact, prefix, contains, scattered), each
 *  keeping its original order within its tier; `limit` caps the result. */
export function rankByTitle<T>(query: string, items: readonly T[], title: (item: T) => string, limit = Infinity): Array<T & { match: TitleMatch }> {
  const tiers: Array<Array<T & { match: TitleMatch }>> = [[], [], [], []];
  for (const item of items) {
    const text = title(item);
    const match = matchTitle(query, text);
    if (match) tiers[titleTier(match, text)]!.push({ ...item, match });
  }
  return tiers.flat().slice(0, limit);
}
