// A note as paragraphs: the one place that cuts Markdown into the units a
// person recognises (a block of text, a heading, a list item, a task, a quote,
// a code fence), pairs the paragraphs of two versions, and counts what changed.
// The server's version list / workspace history / "restore to this moment" and
// the app's note history, "this block's history" and take-back all read it, so
// "改了 N 段" means the same everywhere (docs/research/review-2026-10-27).
//
// Cutting rules (a line scan, not a Markdown parse: history needs source
// ranges for every paragraph, plain ones included, and notes longer than
// parseBlocks' BLOCK_PARSE_MAX):
//   - blank lines separate paragraphs; a heading line, each list item (tasks
//     too) and each code fence is its own paragraph; an indented line stays
//     with its list item; a `>` line starts or continues a quote;
//   - a code fence is one paragraph even when it holds blank lines;
//   - the frontmatter block is one paragraph (kind "frontmatter");
//   - `^id` is blockId.ts's grammar (trailingBlockId): at the end of the last
//     line, or alone on a line after the paragraph (Obsidian's form for
//     tables and quotes), which then belongs to that paragraph.
// CRLF is read as LF; offsets are into the text as given.
//
// Pairing (pairParagraphs): `^id` first, then identical text anywhere (a
// paragraph that only moved is not a change), then resemblance (bigram Dice
// ≥ 0.6, same heading-ness), then a leftover old and new paragraph between
// the same two paired neighbours (rewritten in place). Two different `^id`s
// are never the same paragraph.

import { frontmatterLength } from "./frontmatter.js";
import { cutToCodePoints } from "./graphemes.js";
import { trailingBlockId } from "./blockId.js";
import { replaceWikilinks, splitWikilink } from "./text.js";

export type ParagraphKind = "heading" | "listItem" | "quote" | "fence" | "text" | "frontmatter";

export type Paragraph = {
  kind: ParagraphKind;
  /** Source text exactly as written: `markdown.slice(start, end) === text`. */
  text: string;
  start: number;
  end: number;
  /** `text` without its `^id` (and the whitespace before it); ends at `bodyEnd`. */
  body: string;
  bodyEnd: number;
  /** Whitespace-normalised `text`, for "did it change": trimmed lines, runs of
   *  whitespace (NBSP and full-width space included) collapsed. */
  norm: string;
  /** The `^id` (without the caret) the paragraph carries. */
  blockId: string | null;
  /** Nearest heading text at or above this paragraph (the heading itself for a heading). */
  section: string | null;
};

export type Alignment =
  | { kind: "same"; old: Paragraph; new: Paragraph }
  | { kind: "changed"; old: Paragraph; new: Paragraph }
  | { kind: "added"; old: null; new: Paragraph }
  | { kind: "removed"; old: Paragraph; new: null };

export type ChangeSummary = {
  added: number;
  changed: number;
  removed: number;
  /** Sections the change touched, first-touched first, at most SUMMARY_SECTIONS. */
  sections: string[];
};

export const SUMMARY_SECTIONS = 3;

const HEADING_LINE = /^ {0,3}#{1,6}(?:\s|$)/;
const LIST_ITEM_LINE = /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/;
const FENCE_LINE = /^\s*(```|~~~)/;
const QUOTE_LINE = /^ {0,3}>/;

const normalizeLines = (text: string): string => text.split("\n").map((l) => l.trim().replace(/\s+/g, " ")).join("\n").trim();

function headingTitle(line: string, from: number, id: { start: number } | null): string | null {
  const title = (id ? line.slice(0, id.start - from) : line)
    .replace(/^ {0,3}#{1,6}\s*/, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
  return title || null;
}

type Open = { kind: ParagraphKind; start: number; end: number };

/** The paragraphs of `markdown`, in document order. */
export function splitParagraphs(markdown: string): Paragraph[] {
  const out: Paragraph[] = [];
  let section: string | null = null;
  let open: Open | null = null;
  let fence: string | null = null;

  const push = (o: Open) => {
    const text = markdown.slice(o.start, o.end);
    const lastLineStart = markdown.lastIndexOf("\n", o.end - 1) + 1;
    const from = Math.max(lastLineStart, o.start);
    const id = o.kind === "fence" || o.kind === "frontmatter" ? null : trailingBlockId(markdown, from, o.end);
    if (o.kind === "heading") section = headingTitle(markdown.slice(from, o.end), from, id) ?? section;
    let bodyEnd = o.end;
    if (id) {
      bodyEnd = id.start;
      while (bodyEnd > o.start && /\s/.test(markdown[bodyEnd - 1]!)) bodyEnd--;
    }
    out.push({
      kind: o.kind, text, start: o.start, end: o.end,
      body: markdown.slice(o.start, bodyEnd), bodyEnd,
      norm: normalizeLines(text), blockId: id?.id ?? null, section,
    });
  };
  const flush = () => {
    if (open) push(open);
    open = null;
  };

  let pos = frontmatterLength(markdown);
  if (pos > 0) {
    let end = pos;
    while (end > 0 && /\s/.test(markdown[end - 1]!)) end--;
    push({ kind: "frontmatter", start: 0, end });
  }
  while (pos < markdown.length) {
    const newline = markdown.indexOf("\n", pos);
    const rawEnd = newline < 0 ? markdown.length : newline;
    const lineEnd = markdown[rawEnd - 1] === "\r" && rawEnd > pos ? rawEnd - 1 : rawEnd;
    const line = markdown.slice(pos, lineEnd);
    const lineStart = pos;
    pos = newline < 0 ? markdown.length : newline + 1;

    if (fence) {
      open!.end = lineEnd;
      if (line.trim().startsWith(fence)) { fence = null; flush(); }
      continue;
    }
    if (line.trim() === "") { flush(); continue; }
    const fenceOpen = FENCE_LINE.exec(line);
    if (fenceOpen) {
      flush();
      open = { kind: "fence", start: lineStart, end: lineEnd };
      fence = fenceOpen[1]!;
      continue;
    }
    // A line that is only `^id` is the id of the paragraph above it.
    const lone = trailingBlockId(markdown, lineStart, lineEnd);
    if (lone && line.trim() === `^${lone.id}`) {
      if (open) { open.end = lineEnd; flush(); continue; }
      const prev = out[out.length - 1];
      if (prev && prev.kind !== "frontmatter") {
        const text = markdown.slice(prev.start, lineEnd);
        out[out.length - 1] = { ...prev, text, end: lineEnd, norm: `${prev.norm}\n^${lone.id}`, blockId: lone.id };
        continue;
      }
    }
    if (HEADING_LINE.test(line)) { flush(); push({ kind: "heading", start: lineStart, end: lineEnd }); continue; }
    if (LIST_ITEM_LINE.test(line)) { flush(); open = { kind: "listItem", start: lineStart, end: lineEnd }; continue; }
    const quote = QUOTE_LINE.test(line);
    if (open && ((open.kind === "listItem" && /^\s/.test(line)) || (open.kind === "text" && !quote) || (open.kind === "quote" && quote))) {
      open.end = lineEnd;
      continue;
    }
    flush();
    open = { kind: quote ? "quote" : "text", start: lineStart, end: lineEnd };
  }
  flush();
  return out;
}

/** Character bigram counts of `s` (Dice similarity is built on them). */
export function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Character-bigram Dice coefficient, 0–1. */
/** The paragraph whose source text is `text`, counting identical ones: the
 *  `occurrence`-th (0 = first). -1 when there is none. A place named this way
 *  (an AI suggestion's) survives edits elsewhere, which a character offset does not. */
export function findParagraph(paragraphs: readonly Paragraph[], text: string, occurrence: number): number {
  let seen = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    if (paragraphs[i]!.text === text && seen++ === occurrence) return i;
  }
  return -1;
}

/** How many paragraphs identical to paragraphs[index] come before it. */
export function paragraphOccurrence(paragraphs: readonly Paragraph[], index: number): number {
  let n = 0;
  for (let i = 0; i < index; i++) if (paragraphs[i]!.text === paragraphs[index]!.text) n++;
  return n;
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

const SIMILAR_ENOUGH = 0.6;
/** Resemblance pairing is O(n·m); past this many candidate pairs it is skipped
 *  (position pairing still runs). */
const MAX_SIMILARITY_PAIRS = 250_000;

/** For each paragraph of `older`, the index of its counterpart in `newer`, or -1. */
export function pairParagraphs(older: readonly Paragraph[], newer: readonly Paragraph[]): number[] {
  const newerOf = new Array<number>(older.length).fill(-1);
  const olderTaken = new Set<number>();
  const newerTaken = new Set<number>();
  const pair = (i: number, j: number) => {
    newerOf[i] = j;
    olderTaken.add(i);
    newerTaken.add(j);
  };
  const compatible = (i: number, j: number) => {
    const a = older[i]!.blockId, b = newer[j]!.blockId;
    return !a || !b || a === b;
  };

  // 1) `^id`
  const newerById = new Map<string, number>();
  newer.forEach((p, j) => {
    if (p.blockId && !newerById.has(p.blockId)) newerById.set(p.blockId, j);
  });
  older.forEach((p, i) => {
    const j = p.blockId ? newerById.get(p.blockId) : undefined;
    if (j !== undefined && !newerTaken.has(j) && !olderTaken.has(i)) pair(i, j);
  });

  // 2) identical text, first free one in order
  const newerByText = new Map<string, number[]>();
  newer.forEach((p, j) => {
    if (newerTaken.has(j)) return;
    const list = newerByText.get(p.norm);
    if (list) list.push(j);
    else newerByText.set(p.norm, [j]);
  });
  older.forEach((p, i) => {
    if (olderTaken.has(i)) return;
    const list = newerByText.get(p.norm);
    const at = list?.findIndex((j) => compatible(i, j)) ?? -1;
    if (at >= 0) pair(i, list!.splice(at, 1)[0]!);
  });

  // 3) resemblance, best first
  const freeOlder = older.map((_, i) => i).filter((i) => !olderTaken.has(i));
  const freeNewer = newer.map((_, j) => j).filter((j) => !newerTaken.has(j));
  if (freeOlder.length * freeNewer.length <= MAX_SIMILARITY_PAIRS) {
    const candidates: Array<{ i: number; j: number; score: number }> = [];
    for (const i of freeOlder) {
      for (const j of freeNewer) {
        if ((older[i]!.kind === "heading") !== (newer[j]!.kind === "heading") || !compatible(i, j)) continue;
        const score = similarity(older[i]!.norm, newer[j]!.norm);
        if (score >= SIMILAR_ENOUGH) candidates.push({ i, j, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
    for (const { i, j } of candidates) if (!olderTaken.has(i) && !newerTaken.has(j)) pair(i, j);
  }

  // 4) rewritten in place: between the same two paired neighbours, same heading-ness
  older.forEach((p, i) => {
    if (olderTaken.has(i)) return;
    let lo = -1;
    for (let k = i - 1; k >= 0; k--) if (newerOf[k]! >= 0) { lo = newerOf[k]!; break; }
    let hi = newer.length;
    for (let k = i + 1; k < older.length; k++) if (newerOf[k]! >= 0) { hi = newerOf[k]!; break; }
    for (let j = lo + 1; j < hi; j++) {
      if (!newerTaken.has(j) && (newer[j]!.kind === "heading") === (p.kind === "heading") && compatible(i, j)) { pair(i, j); break; }
    }
  });
  return newerOf;
}

/** Pairs `older` with `newer` and reads the result in the new document's
 *  order, a removed paragraph staying right after the paragraph that preceded it. */
export function alignParagraphs(older: readonly Paragraph[] | string, newer: readonly Paragraph[] | string): Alignment[] {
  const a = typeof older === "string" ? splitParagraphs(older) : older;
  const b = typeof newer === "string" ? splitParagraphs(newer) : newer;
  const newerOf = pairParagraphs(a, b);
  const rows: Array<{ at: number; row: Alignment }> = [];
  const paired = new Set<number>();
  a.forEach((p, i) => {
    const j = newerOf[i]!;
    if (j >= 0) {
      paired.add(j);
      rows.push({ at: j, row: { kind: p.norm === b[j]!.norm ? "same" : "changed", old: p, new: b[j]! } });
      return;
    }
    let prevNewer = -1;
    for (let k = i - 1; k >= 0; k--) if (newerOf[k]! >= 0) { prevNewer = newerOf[k]!; break; }
    rows.push({ at: prevNewer + 0.5, row: { kind: "removed", old: p, new: null } });
  });
  b.forEach((p, j) => {
    if (!paired.has(j)) rows.push({ at: j, row: { kind: "added", old: null, new: p } });
  });
  return rows.sort((x, y) => x.at - y.at).map((r) => r.row);
}

/** For each paragraph of `next`, the index of the same paragraph in `prev`, or -1 when it is new. */
export function matchParagraphs(prev: readonly Paragraph[], next: readonly Paragraph[]): number[] {
  const match = new Array<number>(next.length).fill(-1);
  pairParagraphs(prev, next).forEach((j, i) => { if (j >= 0) match[j] = i; });
  return match;
}

const LINE_MARKER = /^[ \t]*(?:#{1,6}(?:\s+|$)|>\s*|(?:[-*+]|\d+[.)])(?:\s+|$)(?:\[[ xX]\](?:\s+|$))?)+/;

/** Inline Markdown as readable words: links keep their text, [[note|alias]] its shown name, and bold,
 *  italic, strikethrough, highlight and code lose their marks. */
function plainInline(line: string): string {
  return replaceWikilinks(line.replaceAll("![[", "[["), (body) => {
    const { target, alias } = splitWikilink(body);
    return alias || target;
  })
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|==)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^*\w])[*_](?=\S)(.+?)(?<=\S)[*_](?![*\w])/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1");
}

/** A paragraph's text (Paragraph.norm) as one line to show: heading / list / task / quote marks and the
 *  `^id` at the end of each line removed, inline Markdown as words, at most `max` characters. null when
 *  nothing readable is left. */
export function paragraphSample(norm: string, max: number): string | null {
  const lines = norm.split("\n").map((l) => {
    const bare = l.replace(LINE_MARKER, "");
    const id = trailingBlockId(bare);
    return (id ? bare.slice(0, id.start) : bare).trim();
  });
  const text = lines.filter((l) => l !== "" && !FENCE_LINE.test(l)).map((l) => plainInline(l).trim()).filter((l) => l !== "").join(" ");
  if (text === "") return null;
  return [...text].length > max ? `${cutToCodePoints(text, max - 1)}…` : text;
}

/** How many paragraphs a change added, changed and removed, and where. */
export function summarizeAlignment(alignment: readonly Alignment[]): ChangeSummary {
  const summary: ChangeSummary = { added: 0, changed: 0, removed: 0, sections: [] };
  for (const row of alignment) {
    if (row.kind === "same") continue;
    summary[row.kind]++;
    const section = (row.new ?? row.old).section;
    if (section && summary.sections.length < SUMMARY_SECTIONS && !summary.sections.includes(section)) summary.sections.push(section);
  }
  return summary;
}

/** Whether two texts differ only in what a reader does not see as a change of
 *  words: the `^id` ending a paragraph, trailing spaces on a line, and the blank
 *  lines between paragraphs. Indentation counts (a list or code block moved). */
export function sameTextIgnoringIds(a: string, b: string): boolean {
  const key = (p: Paragraph) => p.body.split("\n").map((l) => l.trimEnd()).join("\n");
  const pa = splitParagraphs(a), pb = splitParagraphs(b);
  return pa.length === pb.length && pa.every((p, i) => p.kind === pb[i]!.kind && key(p) === key(pb[i]!));
}

/** What `newer` changed relative to `older`, in paragraphs. */
export function summarizeChange(older: string, newer: string): ChangeSummary {
  return summarizeAlignment(alignParagraphs(older, newer));
}
