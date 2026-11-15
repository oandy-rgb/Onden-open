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
export type Slide = { markdown: string; cites: DeckSource[] };
export type SlideDeck = { slides: Slide[]; sources: DeckSource[] };

const SOURCE_LINE = /^\[(\d+)\]\s+(.+)$/;


/** Lines grouped into parts, starting a new part where `isBreak` says
 *  (outside code fences and `$$` math; `prev` is the line before). A fence closes only on
 *  the same marker, at least as long (``` inside ~~~ is text). */
function splitLines(lines: string[], isBreak: (line: string, prev: string | undefined) => "drop" | "keep" | false): string[][] {
  const parts: string[][] = [[]];
  const fence = fenceScanner({ math: true });
  let closed = false; // the line before closed a fence or `$$` block: a `---` right under it is a rule, not a setext underline
  lines.forEach((line, i) => {
    const state = fence(line);
    const brk = state !== "outside" ? false : isBreak(line, closed ? undefined : lines[i - 1]);
    closed = state === "close";
    if (brk) parts.push(brk === "keep" ? [line] : []);
    else parts[parts.length - 1].push(line);
  });
  return parts;
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
  const lines = stripSettingsFrontmatter(markdown).replace(/\r\n/g, "\n").split("\n");
  let parts = splitLines(lines, (l, prev) => (l.trim() === "---" && !isParagraphLine(prev) ? "drop" : false));
  if (parts.length === 1) parts = splitLines(lines, (l) => (/^##\s/.test(l) ? "keep" : false));
  let texts = parts.map((p) => p.join("\n").trim()).filter(Boolean);
  const sources = texts.length > 1 ? parseSources(texts[texts.length - 1]) : null;
  if (sources) texts = texts.slice(0, -1);
  const byN = new Map((sources ?? []).map((s) => [s.n, s]));
  const slides = texts.map((text) => {
    const cited = new Set<number>();
    for (const m of text.matchAll(/\[(\d+)\](?![(:[])/g)) cited.add(Number(m[1]));
    return { markdown: text, cites: [...cited].flatMap((n) => byN.get(n) ?? []) };
  });
  return { slides: slides.length ? slides : [{ markdown: "", cites: [] }], sources: sources ?? [] };
}
