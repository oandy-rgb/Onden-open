// The search snippet contract (D76): what a search result shows under its
// title. The server (/api/nodes/search, the agent tools) and every local path
// (the on-device index, the sidebar's fuzzy fallback, the published site)
// build it here, so a note reads the same online and offline.
//
// A snippet is PLAIN text plus the ranges to highlight — never HTML. Before
// this the server sent pgroonga's escaped HTML (`Q&amp;A for &lt;tips&gt;`
// showed literally), the local index sent its own `<mark>` markup (a note
// containing `<mark>` highlighted itself) and the fallbacks sent null or raw
// markdown. A renderer turns the ranges into <mark> elements, as text nodes.
//
// Imported by the local-DB worker through the `@onden/markdown/snippet`
// subpath: keep this module (and what it imports) free of the markdown
// pipeline (test/workerImports.test.ts).

import { stripFrontmatter } from "./frontmatter.js";
import { withoutLineTrailers } from "./blockId.js";
import { replaceWikilinks, splitWikilink } from "./text.js";

/** `[start, end)` in UTF-16 offsets of the snippet's `text`. */
export type SnippetRange = [start: number, end: number];
/** A search snippet: plain text and the matches in it, sorted, not overlapping. */
export type Snippet = { text: string; ranges: SnippetRange[] };

export type SnippetOptions = {
  /** Characters of context kept before the first match (default 40). */
  before?: number;
  /** Characters of context kept after it (default 80). */
  after?: number;
};

const ELLIPSIS = "…";
// How far a window edge may move to land on a space instead of mid-word.
const SNAP = 12;
// Bounds on what a query contributes: a pasted paragraph is not 500 terms.
const MAX_TERMS = 16;
const MAX_TERM_LENGTH = 200;

/** The words of a typed query as snippet terms: `"quoted phrases"` stay
 *  whole, `-excluded` words and the `OR` operator are not shown as matches.
 *  The server reads its query with pgroonga_query_extract_keywords, which
 *  gives the same terms for these forms. */
export function queryTerms(query: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const phrase = m[1];
    const word = m[2];
    if (phrase !== undefined) { if (phrase.trim()) out.push(phrase.trim()); continue; }
    if (!word || word === "OR" || word.startsWith("-")) continue;
    const bare = word.replace(/"/g, "");
    if (bare) out.push(bare);
  }
  return out;
}

/** A note's markdown as the plain text a snippet quotes: no frontmatter,
 *  `[[link|alias]]` read as its alias (else its target), no heading marks, no task box, `{tag}` or `^id`,
 *  no `*` / `` ` `` emphasis, every whitespace run one space. Linear. */
export function snippetPlainText(markdown: string): string {
  return plainFromBody(stripFrontmatter(markdown));
}

/** snippetPlainText of text that is already past the frontmatter. A window cut
 *  from the middle of a note (snippetAround) starts here: a `---` line there
 *  is a rule, not a frontmatter fence. */
function plainFromBody(text: string): string {
  const linked = replaceWikilinks(text, (inner) => {
    const { target, alias } = splitWikilink(inner);
    return alias ?? target;
  });
  // `作業 {task} ^ffb6f7` reads as `作業`: the tag slot and the block id are the app's marks, not words.
  const body = withoutLineTrailers(linked);
  // Kept characters are collected as runs of the body (slices) and joined
  // once. Appending one character at a time (`out += ch`) went quadratic in
  // V8 on strings read from node-postgres: 50 long search hits took ~20 s per
  // call and blocked the server's event loop (perf report 2026-10-21).
  const parts: string[] = [];
  let runStart = -1;
  const endRun = (i: number) => { if (runStart >= 0) { parts.push(body.slice(runStart, i)); runStart = -1; } };
  let lineStart = true;
  let leading = true;       // only blanks since the line began: where a list bullet may stand
  let pendingSpace = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (lineStart) {
      // `## Heading` → `Heading` (a `#tag` at a line start keeps its mark).
      let j = i;
      while (j < body.length && j - i < 6 && body[j] === "#") j++;
      if (j > i && (body[j] === " " || body[j] === "\t")) { endRun(i); i = j; pendingSpace = parts.length > 0; lineStart = false; continue; }
    }
    if (ch === "\n" || ch === "\r") { endRun(i); lineStart = true; leading = true; pendingSpace = parts.length > 0; continue; }
    lineStart = false;
    if (ch === " " || ch === "\t" || ch === "\f" || ch === "\v" || ch === "\u00a0") { endRun(i); pendingSpace = parts.length > 0; continue; }
    // `- [ ] ` / `- [x] `: a task's box is not part of its words.
    if (leading && "-*+".includes(ch) && body[i + 1] === " " && body[i + 2] === "[" && " xX".includes(body[i + 3] ?? "?") && body[i + 4] === "]" && body[i + 5] === " ") {
      endRun(i); i += 5; leading = false; pendingSpace = parts.length > 0; continue;
    }
    leading = false;
    if (ch === "*" || ch === "`") { endRun(i); continue; }
    if (pendingSpace) { parts.push(" "); pendingSpace = false; }
    if (runStart < 0) runStart = i;
  }
  endRun(body.length);
  return parts.join("");
}

type Folded = {
  /** The text compared against: NFKC, lower-cased. */
  folded: string;
  /** For each folded unit, where its source character starts in the text. */
  start: number[];
  /** For each folded unit, where its source character ends in the text. */
  end: number[];
};

const COMBINING = /\p{M}/u;

/** `text` folded for matching, each folded unit mapped back to the source
 *  character it came from. A base character and its combining marks fold
 *  together, so a decomposed `é` (NFD) matches a composed one and a match
 *  never splits a surrogate pair. Compatibility forms fold as pgroonga's
 *  normalizer folds them (full-width `Ａ` is `a`). Linear. */
function fold(text: string): Folded {
  let folded = "";
  const start: number[] = [];
  const end: number[] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    // An ASCII letter on its own (not the base of a decomposed `é`).
    if (code < 0x80 && !(next >= 0x300 && COMBINING.test(text[i + 1]!))) {
      folded += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[i];
      start.push(i); end.push(i + 1);
      i++;
      continue;
    }
    let j = i + (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length ? 2 : 1);
    while (j < text.length) {
      const c = text.codePointAt(j)!;
      if (!COMBINING.test(String.fromCodePoint(c))) break;
      j += c > 0xffff ? 2 : 1;
    }
    const part = text.slice(i, j).normalize("NFKC").toLowerCase();
    for (let k = 0; k < part.length; k++) { folded += part[k]; start.push(i); end.push(j); }
    i = j;
  }
  return { folded, start, end };
}

/** The distinct folded terms, longest first (a longer term wins where two
 *  start at the same place). */
function foldTerms(terms: readonly string[]): string[] {
  const out = new Set<string>();
  for (const term of terms.slice(0, MAX_TERMS)) {
    const t = fold(term.trim().slice(0, MAX_TERM_LENGTH)).folded;
    if (t) out.add(t);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function scan(f: Folded, terms: string[], from: number, to: number, limit: number): SnippetRange[] {
  const ranges: SnippetRange[] = [];
  if (!terms.length) return ranges;
  let i = from;
  while (i < to) {
    let hit = 0, markFirst = false;
    for (const t of terms) {
      if (i + t.length <= to && f.folded.startsWith(t, i)) { hit = t.length; markFirst = COMBINING.test(t[0]!); break; }
    }
    if (!hit) { i++; continue; }
    let s = f.start[i]!;
    const e = Math.min(f.end[i + hit - 1]!, limit);
    if (markFirst) for (let j = i; j-- > 0 && f.start[j] === f.start[i]; ) s++;
    const last = ranges[ranges.length - 1];
    if (last && s < last[1]) { i++; continue; }
    // Units of one source character fold together: never start mid-character,
    // unless the term itself opens with a combining mark (it then starts at the
    // character that carries the mark, a space after whitespace collapsed).
    if (i > 0 && f.start[i - 1] === s && !markFirst) { i++; continue; }
    ranges.push([s, e]);
    i += hit;
  }
  return ranges;
}

const isSpace = (ch: string | undefined) => ch === " ";
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;


type Hit = { start: number; end: number };

/** The first match of `terms` (already folded, longest first) in `f`, as the
 *  source range of the characters it covers. */
function firstHit(f: Folded, terms: string[]): Hit | null {
  let first = -1, firstLength = 0;
  for (const t of terms) {
    const at = f.folded.indexOf(t);
    if (at !== -1 && (first === -1 || at < first)) { first = at; firstLength = t.length; }
  }
  return first === -1 ? null : { start: f.start[first]!, end: f.end[first + firstLength - 1]! };
}

function snippetFromHit(plain: string, f: Folded, terms: string[], hit: Hit, before: number, after: number): Snippet {
  const { start: hitStart, end: hitEnd } = hit;
  let start = Math.max(0, hitStart - before);
  let end = Math.min(plain.length, hitEnd + after);
  // Land on a word boundary when one is near (CJK text has none: keep the cut).
  if (start > 0) {
    const space = plain.indexOf(" ", start);
    if (space !== -1 && space < hitStart && space - start <= SNAP) start = space + 1;
  }
  if (end < plain.length) {
    const space = plain.lastIndexOf(" ", end);
    if (space > hitEnd && end - space <= SNAP) end = space;
  }
  // Never cut inside a grapheme cluster (a surrogate pair, a character from
  // its combining marks, a ZWJ family, a flag, a skin tone): `start` moves
  // forward (toward the match), `end` forward too (a little more context).
  if (start > 0 && start < hitStart) start = Math.min(hitStart, graphemeEdge(plain, start));
  if (end < plain.length && end > hitEnd) end = Math.max(hitEnd, graphemeEdge(plain, end));
  while (start < hitStart && isSpace(plain[start])) start++;
  while (end > hitEnd && isSpace(plain[end - 1])) end--;
  // A term may begin with a combining mark, so the match starts inside a
  // cluster: the window opens at that cluster's start, not between its halves.
  start = Math.min(start, graphemeStartAtOrBefore(plain, hitStart));

  // The folded units covering [start, end): the source offsets are sorted.
  let lo = 0, hi = f.start.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (f.start[mid]! < start) lo = mid + 1; else hi = mid; }
  let stop = lo;
  while (stop < f.start.length && f.end[stop]! <= end) stop++;
  const lead = start > 0 ? ELLIPSIS : "";
  const ranges = scan(f, terms, lo, stop, end).map(([s, e]): SnippetRange => [s - start + lead.length, e - start + lead.length]);
  return { text: lead + plain.slice(start, end) + (end < plain.length ? ELLIPSIS : ""), ranges };
}

/** The snippet of a whole plain text: every character folded. */
function snippetInPlain(plain: string, terms: string[], before: number, after: number): Snippet | null {
  const f = fold(plain);
  const hit = firstHit(f, terms);
  return hit ? snippetFromHit(plain, f, terms, hit, before, after) : null;
}

// ---- The window path: a snippet from a few thousand characters ----
// Converting and folding a whole body costs time and memory in proportion to
// its length, for a snippet of ~120 characters. A search shows up to 50 of
// them, and the server does it on the one event loop every user shares.

// Raw markdown scanned per step when looking for the first match.
const SCAN_CHUNK = 8192;
// Raw characters kept on each side of the match, up to the next line break.
const WINDOW = 3000;
// Beyond this (one enormous line) the window is not worth it: convert it all.
const WINDOW_LIMIT = 20000;
// Matches that vanish in the conversion (inside a link target) skipped before giving up.
const MAX_PHANTOM_HITS = 8;

// What fold() leaves as it is, one unit per character, beyond ASCII: ideographs,
// kana, Hangul syllables and a few CJK marks (test: snippet.test.ts checks every
// code point in these ranges). Text made of these folds to its own
// toLowerCase, so it is compared without building the per-character maps.
/** Exported for its test only. */
export const SELF_FOLDING = /^[\x00-\x7f\u3001\u3002\u300c-\u300f\u3041-\u3096\u30a1-\u30fa\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3]*$/;
const WHITESPACE = /\s/;

// Kept here, not imported from graphemes.ts: this module is in the local-DB
// worker's bundle, which takes nothing but what it needs.
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const REGIONAL_INDICATOR = /^[\u{1F1E6}-\u{1F1FF}]$/u;

/** `i` moved forward to the nearest grapheme-cluster boundary (itself when it
 *  is on one). Reads a window before `i`, not the whole body (a match near the
 *  end of a long note): clusters are local, except that where a flag's pairs
 *  begin depends on every regional indicator before it, so the window also
 *  takes in the whole run of them it starts inside. */
function graphemeEdge(text: string, i: number): number {
  const from = clusterWindowStart(text, i);
  for (const part of SEGMENTER.segment(text.slice(from, i + 64))) {
    const start = from + part.index;
    const end = start + part.segment.length;
    if (end >= i) return start >= i ? start : end;
  }
  return i;
}

function clusterWindowStart(text: string, i: number): number {
  let from = Math.max(0, i - 256);
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from--;
  while (from >= 2 && REGIONAL_INDICATOR.test(text.slice(from - 2, from))) from -= 2;
  return from;
}

/** `i` moved back to the start of the cluster it is in (itself on a boundary). */
function graphemeStartAtOrBefore(text: string, i: number): number {
  const from = clusterWindowStart(text, i);
  let at = from;
  for (const part of SEGMENTER.segment(text.slice(from, i + 2))) { if (from + part.index > i) break; at = from + part.index; }
  return at;
}

/** `i` moved forward to the start of a character no combining mark or
 *  surrogate half is attached to, so a cut there splits nothing fold() joins. */
function clusterEdge(text: string, i: number): number {
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (!isLowSurrogate(code) && !COMBINING.test(String.fromCodePoint(text.codePointAt(i)!))) break;
    i += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
  }
  return i;
}

/** Where the first match of `terms` starts in the raw `body` at or after
 *  `from` (a character boundary), or -1. Folds one chunk at a time; a chunk
 *  that folds to itself (ASCII, CJK) is compared with one toLowerCase and
 *  indexOf. Each chunk also reads past its end by a few term lengths, so a
 *  match across the cut is found, and only a match starting in the chunk counts. */
function findRawHit(body: string, terms: string[], from: number): number {
  const overlap = terms[0]!.length * 4 + 64;
  for (let chunk = from; chunk < body.length;) {
    const chunkEnd = clusterEdge(body, Math.min(body.length, chunk + SCAN_CHUNK));
    const seg = body.slice(chunk, clusterEdge(body, Math.min(body.length, chunkEnd + overlap)));
    let best = -1;
    if (SELF_FOLDING.test(seg)) {
      const lower = seg.toLowerCase();
      for (const t of terms) {
        const at = lower.indexOf(t);
        if (at !== -1 && (best === -1 || at < best)) best = at;
      }
    } else {
      const f = fold(seg);
      for (const t of terms) {
        const at = f.folded.indexOf(t);
        if (at !== -1 && (best === -1 || f.start[at]! < best)) best = f.start[at]!;
      }
    }
    if (best !== -1 && chunk + best < chunkEnd) return chunk + best;
    chunk = chunkEnd;
  }
  return -1;
}

/** snippetAround without reading the whole note: the first match is found in
 *  the raw markdown, and only the lines around it are converted and folded.
 *  undefined when the window can't give the same answer as the whole note
 *  (a phrase with spaces, a match that is never visible in the plain text,
 *  a window too close to its cut, one enormous line); the caller then reads
 *  the whole note. See snippetAround for the one intended difference. */
function snippetInWindow(markdown: string, terms: string[], before: number, after: number): Snippet | null | undefined {
  // A phrase may cross a line break or a run of spaces that the plain text
  // collapses; only the whole text can tell where it first matches.
  if (terms.some((t) => WHITESPACE.test(t))) return undefined;
  const body = markdown.startsWith("---") ? stripFrontmatter(markdown) : markdown;
  let from = 0;
  for (let phantom = 0; phantom < MAX_PHANTOM_HITS; phantom++) {
    const at = findRawHit(body, terms, from);
    if (at === -1) return null;
    // Whole lines: the conversion starts in the same state it would have there.
    const a = at > WINDOW ? body.lastIndexOf("\n", at - WINDOW) + 1 : 0;
    const nl = body.indexOf("\n", Math.min(body.length, at + WINDOW));
    const b = nl === -1 ? body.length : nl;
    if (at - a > WINDOW_LIMIT || b - at > WINDOW_LIMIT) return undefined;

    const plain = plainFromBody(body.slice(a, b));
    const f = fold(plain);
    const hit = firstHit(f, terms);
    if (!hit) { from = b; continue; }
    // The snippet reads this far around the match (cut and snapped, plus a
    // little for combining marks); a window that ends sooner than the note
    // would have to be read whole, since the note may go on there.
    const margin = (side: number) => side + SNAP + 16;
    if (a > 0 && hit.start < margin(before)) return undefined;
    if (b < body.length && plain.length - hit.end < margin(after)) return undefined;
    return snippetFromHit(plain, f, terms, hit, before, after);
  }
  return undefined;
}

/** The snippet a search result shows for a note whose body matched `terms`:
 *  the note's plain text (snippetPlainText) around the first match, with
 *  every match inside the window highlighted, and "…" where the text goes on.
 *  null when no term occurs in the body (a title-only match).
 *
 *  Cost is in the window, not the note: the first match is looked for in the
 *  raw markdown and only the lines around it are converted (a 200 KB body
 *  takes well under a millisecond to read, not ~15 ms). The result is the
 *  same as reading the whole note (snippetAroundWholeNote), with one
 *  intended difference: a match that exists only once the markup is removed
 *  (`kaf**ka**`, `[[a|b]]c`) is not found when the raw text has no such
 *  match at all (that is where the server's index looks too), or is not seen
 *  when an ordinary match comes after it. A quoted phrase with spaces is
 *  always read from the whole note. */
export function snippetAround(markdown: string, terms: readonly string[], { before = 40, after = 80 }: SnippetOptions = {}): Snippet | null {
  const want = foldTerms(terms);
  if (!want.length || !markdown) return null;
  const windowed = snippetInWindow(markdown, want, before, after);
  if (windowed !== undefined) return windowed;
  return snippetInPlain(snippetPlainText(markdown), want, before, after);
}

/** snippetAround over the whole converted note: the reference the window path
 *  is checked against, and what it falls back to. Linear in the note. */
export function snippetAroundWholeNote(markdown: string, terms: readonly string[], { before = 40, after = 80 }: SnippetOptions = {}): Snippet | null {
  const want = foldTerms(terms);
  if (!want.length || !markdown) return null;
  return snippetInPlain(snippetPlainText(markdown), want, before, after);
}
