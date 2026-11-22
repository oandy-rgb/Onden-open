// A note as a slide deck (docs/architecture/presentation.md). Slides are split
// on a line that is only `---` — except right under a paragraph line, where
// Markdown reads it as that paragraph's (setext) heading underline; a note
// without one splits at its `##` headings; otherwise the whole note is one slide. A last part made only of
// `[n] …` lines is the deck's source list, not a slide: each slide's footer
// names the sources its `[n]` markers cite.

import { fenceScanner, openingFenceInfo } from "./fences.js";
import { stripSettingsFrontmatter } from "./frontmatter.js";
import { soleWikilink } from "./text.js";

export type DeckSource = { n: number; label: string; /** The note to open: a wikilink target (slug or title), when there is one. */ target: string | null };
/** `from`/`to`: where the slide's own text sits in the note, `[from, to)` of the note with its line ends as `\n`
 *  (`text.slice(from, to) === markdown`). The `---` line and the blank lines around it belong to no slide; neither does
 *  the settings frontmatter or a trailing source list. The one place a page is tied to a stretch of the note's text. */
export type Slide = { markdown: string; cites: DeckSource[]; from: number; to: number };
/** `split`: how the note is cut into slides, so a new one is cut the same way ("rule": `---` lines; "heading": `##`). */
export type SlideDeck = { slides: Slide[]; sources: DeckSource[]; split: "rule" | "heading" };

const SOURCE_LINE = /^\[(\d+)\]\s+(.+)$/;


/** Runs of consecutive lines, `[first, end)` line numbers, starting a new run where `isBreak` says
 *  (outside code fences and `$$` math; `prev` is the line before). "drop": the break line itself is in no run. A fence
 *  closes only on the same marker, at least as long (``` inside ~~~ is text). */
type LineRun = { first: number; end: number };
function splitLines(lines: string[], isBreak: (line: string, prev: string | undefined) => "drop" | "keep" | false): LineRun[] {
  const runs: LineRun[] = [{ first: 0, end: 0 }];
  const fence = fenceScanner({ math: true });
  let closed = false; // the line before closed a fence or `$$` block: a `---` right under it is a rule, not a setext underline
  lines.forEach((line, i) => {
    const state = fence(line);
    const brk = state !== "outside" ? false : isBreak(line, closed ? undefined : lines[i - 1]);
    closed = state === "close";
    if (brk) runs.push(brk === "keep" ? { first: i, end: i + 1 } : { first: i + 1, end: i + 1 });
    else runs[runs.length - 1].end = i + 1;
  });
  return runs;
}

/** A paragraph's text line: a `---` right under it is a setext heading underline, not a slide break. */
function isParagraphLine(line: string | undefined): boolean {
  if (!line?.trim()) return false;
  return openingFenceInfo(line) === null && !/^\s{0,3}([#>|]|[-*+]\s|\d+[.)]\s)/.test(line);
}

function parseSources(part: string): DeckSource[] | null {
  const lines = part.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length && /^#{1,6}\s/.test(lines[0])) lines.shift(); // its heading ("## Sources")
  if (!lines.length) return null;
  const sources: DeckSource[] = [];
  for (const line of lines) {
    const m = SOURCE_LINE.exec(line);
    if (!m) return null;
    const link = soleWikilink(m[2].trim());
    sources.push(link?.target.trim()
      ? { n: Number(m[1]), label: (link.alias || link.target).trim(), target: link.target.trim() }
      : { n: Number(m[1]), label: m[2].trim(), target: null });
  }
  return sources;
}

export function parseDeck(markdown: string): SlideDeck {
  const text = markdown.replace(/\r\n/g, "\n");
  const body = stripSettingsFrontmatter(text); // a suffix of `text`
  const bodyAt = text.length - body.length;
  const lines = body.split("\n");
  const starts: number[] = [];
  let at = bodyAt;
  for (const line of lines) { starts.push(at); at += line.length + 1; }
  let runs = splitLines(lines, (l, prev) => (l.trim() === "---" && !isParagraphLine(prev) ? "drop" : false));
  let split: SlideDeck["split"] = "rule";
  if (runs.length === 1) { runs = splitLines(lines, (l) => (/^##\s/.test(l) ? "keep" : false)); split = runs.length > 1 ? "heading" : "rule"; }
  let parts = runs.flatMap((run) => {
    if (run.end <= run.first) return [];
    const begin = starts[run.first];
    const raw = text.slice(begin, Math.min(text.length, starts[run.end - 1] + lines[run.end - 1].length));
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const from = begin + (raw.length - raw.trimStart().length);
    return [{ markdown: trimmed, from, to: from + trimmed.length }];
  });
  const sources = parts.length > 1 ? parseSources(parts[parts.length - 1].markdown) : null;
  if (sources) parts = parts.slice(0, -1);
  const byN = new Map((sources ?? []).map((s) => [s.n, s]));
  const slides = parts.map((part) => {
    const cited = new Set<number>();
    for (const m of part.markdown.matchAll(/\[(\d+)\](?![(:[])/g)) cited.add(Number(m[1]));
    return { ...part, cites: [...cited].flatMap((n) => byN.get(n) ?? []) };
  });
  return { slides: slides.length ? slides : [{ markdown: "", cites: [], from: bodyAt, to: bodyAt }], sources: sources ?? [], split };
}
