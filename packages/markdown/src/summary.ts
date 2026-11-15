// What a note says in one line — the one rule for every summary of a note
// (D37): the app's list previews (slim bootstrap excerpt), the published
// site's page description, RSS item, blog list / page list excerpts and
// search fallback. Before this, six copies disagreed and three of them forgot
// the frontmatter, so a note written in Obsidian (`---\nstatus: …\n---`)
// was summarised as `---` or `status: reading description: …`, and the
// published article repeated its own title.
//
// The rule:
//   1. a frontmatter `description:` is the summary (the author wrote one);
//   2. otherwise the body: frontmatter removed, the first line dropped when it
//      repeats the title (`# Title` or a bare `Title`), fenced code, heading,
//      table and rule lines dropped, the lines of a published handwriting page
//      (handwritingPage.ts) dropped, list markers, ^block-ids, images, link
//      URLs and emphasis marks removed, wikilinks read as their label;
//   3. whitespace collapsed and cut on a word boundary near maxLen, with "…".
//
// Every step is linear on a pathological body: it runs for each note a list
// shows (backend bodyParsersLinear / excerptScan tests time and check it).

import { parseFrontmatter, stripFrontmatter } from "./frontmatter.js";
import { withoutFences } from "./fences.js";
import { plainInline, stripLineMarker } from "./plainText.js";
import { withoutLineTrailers } from "./blockId.js";
import { cutToUnits } from "./graphemes.js";

export type NoteSummaryOptions = {
  /** The note's title: a first line repeating it is not part of the summary. */
  title?: string;
  /** Longest summary in characters, "…" not counted. */
  maxLen: number;
};

/** The body without its frontmatter and without the first non-empty line
 *  when that line is the title (`# Title`, `## Title` or a bare `Title`) —
 *  what a page shows under a heading that already prints the title. */
export function bodyAfterTitle(markdown: string, title: string): string {
  const body = stripFrontmatter(markdown);
  const wanted = title.trim();
  if (!wanted) return body;
  const lines = body.split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first < 0) return body;
  const text = lines[first]!.replace(/^#+\s*/, "").trim();
  return text === wanted ? lines.slice(first + 1).join("\n") : body;
}

/** One-line plain-text summary of a note (see the rule above). "" when the
 *  note has no prose. */
export function noteSummary(markdown: string, { title, maxLen }: NoteSummaryOptions): string {
  const description = parseFrontmatter(markdown).description?.trim();
  if (description) return cut(plainInline(description).replace(/\s+/g, " ").trim(), maxLen);
  const body = title === undefined ? stripFrontmatter(markdown) : bodyAfterTitle(markdown, title);
  const prose = withoutFences(body, " ")                // fenced code
    .split("\n")
    .filter((line) => !isFurnitureLine(line))
    .map(stripLineMarker)                                 // quote / list / task markers
    .map(withoutLineTrailers)                            // {tag} and ^block-id
    .join("\n");
  return cut(plainInline(prose).replace(/\s+/g, " ").trim(), maxLen);
}

/** Heading, table row, thematic break or a handwriting page's image / address
 *  line: structure, not prose. */
function isFurnitureLine(line: string): boolean {
  const t = line.trim();
  if (/^#{1,6}(?:\s|$)/.test(t)) return true;
  if (t.startsWith("|")) return true;
  if (/^!\[\]\[ink-page-\d+\]$|^\[ink-page-\d+\]:\s*\S+$/.test(t)) return true; // a published handwriting page (handwritingPage.ts)
  if (t.length >= 3 && /^[-*_]$/.test(t[0]!)) {
    const mark = t[0]!;
    let count = 0;
    for (const ch of t) {
      if (ch === mark) count++;
      else if (ch !== " " && ch !== "\t") return false;
    }
    return count >= 3;
  }
  return false;
}

/** Cut on a word boundary when one is near; never inside a grapheme cluster. */
function cut(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const slice = cutToUnits(text, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd() + "…";
}
