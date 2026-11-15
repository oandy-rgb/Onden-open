// The sentence a link sits in — what "Linked from" shows under a note's title
// on the published site. Pure text in, plain pieces out: the paragraph or list
// item that holds each `[[link]]` to a given page, read without its Markdown
// syntax, the link's own words marked, cut to about CONTEXT_LENGTH characters
// around the first mark. The caller says which links are "to this page"
// (`isTarget`, the site's own resolution: servedLinkTarget) and which were
// `![[embeds]]` the server turned into links (`isEmbed`), so this module knows
// nothing about the site.
//
// This file holds the part the editor's code needs too (plainText, plainExcerpt); the places a link is
// mentioned (linkPlaces) are in linkPlaces.ts.

import { blankInkRegionSyntax } from "./embeds.js";
import { fenceScanner } from "./fences.js";
import { frontmatterLength } from "./frontmatter.js";
import { withoutLineTrailers } from "./blockId.js";
import type { WikilinkMatch } from "./text.js";
import { lineMarkerLength, plainInline, wikilinkLabel } from "./plainText.js";
import { drawnWikilinks } from "./wikilinkSpans.js";

export const MARK_OPEN = "\u0001";
export const MARK_CLOSE = "\u0002";

export type Block = { start: number; end: number };

const LIST_ITEM = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/;

/** The paragraphs, list items, headings and table rows of `markdown` after its
 *  frontmatter, as source spans; fenced code belongs to none. */
export function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = [];
  let open: Block | null = null;
  const fence = fenceScanner();
  const close = () => { if (open) blocks.push(open); open = null; };
  let pos = frontmatterLength(markdown);
  while (pos < markdown.length) {
    const nl = markdown.indexOf("\n", pos);
    const end = nl === -1 ? markdown.length : nl;
    const line = markdown.slice(pos, end);
    const state = fence(line);
    if (state === "inside" || state === "close") {
      // fenced code belongs to no block
    } else if (state === "open") {
      close();
    } else if (line.trim() === "") {
      close();
    } else if (LIST_ITEM.test(line) || /^[ \t]{0,3}#{1,6}(?:\s|$)/.test(line) || line.trimStart().startsWith("|")) {
      close();
      open = { start: pos, end };
      // A heading or table row never continues onto the next line.
      if (!LIST_ITEM.test(line)) close();
    } else if (open) {
      open.end = end;
    } else {
      open = { start: pos, end };
    }
    pos = end + 1;
  }
  close();
  return blocks;
}

const blank = (s: string): string => s.replace(/[^\n]/g, " ");

/** One block's text with its line furniture (quote marks, list and task
 *  markers, heading hashes, the trailing {tag} and ^id) turned into spaces, so every
 *  offset in it still means the same place in the source. */
function withoutFurniture(raw: string): string {
  return raw.split("\n").map((line) => {
    const marker = lineMarkerLength(line);
    let out = blank(line.slice(0, marker)) + line.slice(marker);
    const kept = withoutLineTrailers(out);
    out = kept + " ".repeat(out.length - kept.length);
    return blankInkRegionSyntax(out).replace(/\|/g, " ");
  }).join("\n");
}

/** A block's text with its wikilinks as their labels; those `marked` are wrapped in the mark characters. */
export function blockText(markdown: string, block: Block, links: readonly WikilinkMatch[], marked: (link: WikilinkMatch) => boolean): string {
  const raw = withoutFurniture(markdown.slice(block.start, block.end));
  let out = "";
  let at = block.start;
  const run = (to: number) => plainInline(raw.slice(at - block.start, to - block.start));
  for (const l of links) {
    if (l.start < block.start || l.end > block.end) continue;
    // an `![[…]]` the server did not turn into a link: its `!` is not prose
    out += run(l.start).replace(/!$/, "");
    const label = wikilinkLabel(l.body);
    out += marked(l) ? `${MARK_OPEN}${label}${MARK_CLOSE}` : label;
    at = l.end;
  }
  return (out + run(block.end)).replace(/\s+/g, " ").trim();
}

/** A note's text as plain prose: its Markdown syntax removed, links as their words, whitespace collapsed. */
export function plainText(markdown: string): string {
  const links = drawnWikilinks(markdown);
  return blocksOf(markdown).map((b) => blockText(markdown, b, links, () => false)).filter(Boolean).join(" ");
}

