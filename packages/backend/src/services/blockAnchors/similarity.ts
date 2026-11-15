// How alike two pieces of text are, and where a lost anchor's text went.
// Character bigram Dice works for Chinese (no word boundaries) and is O(length).
// Thresholds come from the mapping experiment (docs/research/block-anchor-mapping-2026-11-01.md §5):
// a wrong link is worse than a missing one, so "valid" needs a high, unique match.

import { bigrams, splitAnchorSpan } from "@onden/markdown";

/** At or above this and unique: the anchor is put back automatically. */
export const FIND_VALID = 0.9;
/** Below this the text is not "the same block, edited": nothing is proposed as a candidate. */
export const FIND_GUESS = 0.5;
/** After moving by position, the text there must still resemble the quote this much. */
export const KEEP_MOVED = 0.5;

export type Quote = { text: string; prefix: string; suffix: string };
export type Span = { from: number; to: number };

const squash = (s: string) => s.replace(/\s+/g, "");

/** Dice coefficient of the character bigrams (0..1), whitespace ignored. */
export function dice(a0: string, b0: string): number {
  const a = squash(a0), b = squash(b0);
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ma = bigrams(a), mb = bigrams(b);
  let hit = 0;
  for (const [g, n] of ma) hit += Math.min(n, mb.get(g) ?? 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

/** A text's lines and where each starts. Build it once per text and pass it on: it costs O(length). */
export type LineTable = { lines: string[]; starts: number[] };

export function lineTable(text: string): LineTable {
  const lines = text.split("\n");
  const starts: number[] = [];
  let p = 0;
  for (const l of lines) { starts.push(p); p += l.length + 1; }
  return { lines, starts };
}

function lineOf(starts: number[], pos: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** The quote of [from, to): its text and the line before and after. Pass `table` when quoting many spans of one text
 *  (a save moves every anchor of the note; rebuilding the table per anchor is what made it slow on long notes). */
export function quoteAt(text: string, span: Span, table: LineTable = lineTable(text)): Quote {
  const { lines, starts } = table;
  const a = lineOf(starts, span.from);
  const b = lineOf(starts, Math.max(span.from, span.to - 1));
  return { text: text.slice(span.from, span.to), prefix: lines[a - 1] ?? "", suffix: lines[b + 1] ?? "" };
}

/** Widen to whole lines (a block is always whole lines). */
export function lineAlign(text: string, span: Span): Span {
  const { lines, starts } = lineTable(text);
  const a = lineOf(starts, span.from);
  const b = lineOf(starts, Math.max(span.from, span.to - 1));
  return { from: starts[a]!, to: starts[b]! + lines[b]!.length };
}

export type Found =
  | { outcome: "valid"; span: Span; score: number }
  | { outcome: "maybe"; span: Span; score: number }
  | { outcome: "lost"; span: Span | null; score: number };

/**
 * Looks for the quote among whole-line windows of `text`.
 *  - valid: best ≥ FIND_VALID and no rival (a rival is a non-overlapping window scoring within 0.01, unless the
 *    surrounding lines tell them apart).
 *  - maybe: best ≥ FIND_GUESS but not good or not unique enough to put the anchor there by itself.
 *  - lost: nothing resembles it; `span` is the best guess below FIND_GUESS or null.
 */
export function findQuote(quote: Quote, text: string, claimed: readonly Span[] = []): Found {
  const { lines, starts } = lineTable(text);
  const k = quote.text.split("\n").length;
  const scored: Array<{ i: number; kk: number; score: number; ctx: number; exact: number; lead: number }> = [];
  for (const kk of new Set([k, Math.max(1, k - 1), k + 1])) {
    for (let i = 0; i + kk <= lines.length; i++) {
      const w = lines.slice(i, i + kk).join("\n");
      if (!w.trim()) continue;
      // A block another anchor already stands on is not up for lookup: position and order come before resemblance.
      if (claimed.some((c) => starts[i]! < c.to && c.from < starts[i + kk - 1]! + lines[i + kk - 1]!.length)) continue;
      const ratio = Math.min(w.length, quote.text.length) / Math.max(w.length, quote.text.length);
      if (ratio < FIND_GUESS * 0.5) continue; // cannot reach the guess threshold
      const score = dice(quote.text, w);
      if (score < 0.3) continue;
      const ctx = (quote.prefix.trim() && lines[i - 1] === quote.prefix ? 1 : 0)
        + (quote.suffix.trim() && lines[i + kk] === quote.suffix ? 1 : 0);
      // Equal scores: the window that is the quoted text itself, then one that starts on a line with words (a blank
      // line in front scores the same and is not where a block starts).
      scored.push({ i, kk, score, ctx, exact: w === quote.text ? 1 : 0, lead: lines[i]!.trim() ? 1 : 0 });
    }
  }
  if (scored.length === 0) return { outcome: "lost", span: null, score: 0 };
  scored.sort((a, b) => b.score - a.score || b.ctx - a.ctx || b.exact - a.exact || b.lead - a.lead);
  const best = scored[0]!;
  const spanOf = (c: { i: number; kk: number }): Span => ({
    from: starts[c.i]!, to: starts[c.i + c.kk - 1]! + lines[c.i + c.kk - 1]!.length,
  });
  const overlaps = (c: { i: number; kk: number }) => c.i < best.i + best.kk && best.i < c.i + c.kk;
  const rivals = scored.filter((c) => c !== best && !overlaps(c) && c.score >= best.score - 0.01 && c.ctx >= best.ctx);
  // The quoted text itself, once, is the block: a near-identical neighbour (one character off) is no rival.
  const exactTwice = scored.some((c) => c !== best && !overlaps(c) && c.exact === 1);
  if (best.score < FIND_GUESS) return { outcome: "lost", span: spanOf(best), score: best.score };
  if (best.exact === 1 && !exactTwice) return { outcome: "valid", span: spanOf(best), score: best.score };
  if (best.score >= FIND_VALID && rivals.length === 0) return { outcome: "valid", span: spanOf(best), score: best.score };
  return { outcome: "maybe", span: spanOf(best), score: best.score };
}

/**
 * The paragraph the quote became when a blank line was put INTO it (Enter in the middle): the text at `at` is the quoted
 * words with only blank space inserted at one point, and the half the identity rule picks (`splitAnchorSpan`: the one with
 * the `{…}`, else the first) is the span. For the saves that carry no editor ChangeSet — a line diff cannot tell this cut
 * from the text moving away and coming back, and maps the anchor onto the first half — so the anchor lands on the same
 * half as when the editor sent its change. Null when the text there is not the quote cut that way (intact text is
 * `findQuote`'s).
 */
export function cutParagraphAt(quote: string, after: string, at: number): Span | null {
  if (quote.length < 6 || /\n[ \t]*\n/.test(quote)) return null;
  let j = 0;
  while (j < quote.length && after[at + j] === quote[j]) j++;
  if (j === quote.length) return null;
  let end = at + j;
  while (end < after.length && /[ \t\n]/.test(after[end]!)) end++;
  if (end === at + j || !after.startsWith(quote.slice(j), end)) return null;
  const owner = splitAnchorSpan(quote, after.slice(at, end + quote.length - j));
  return owner ? { from: at + owner.from, to: at + owner.to } : null;
}

/** `cutParagraphAt` wherever in `after` the quote's first words are (an anchor that lost its place), skipping blocks others stand on. */
export function findCutParagraph(quote: string, after: string, claimed: readonly Span[] = []): Span | null {
  const head = quote.slice(0, Math.min(quote.length, 12));
  for (let i = after.indexOf(head); i !== -1 && head.length > 0; i = after.indexOf(head, i + 1)) {
    const span = cutParagraphAt(quote, after, i);
    if (span && !claimed.some((c) => span.from < c.to && c.from < span.to)) return span;
  }
  return null;
}
