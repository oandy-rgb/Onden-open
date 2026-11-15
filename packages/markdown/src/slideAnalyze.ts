// A slide's Markdown cut into the kinds of thing a layout arranges (docs/architecture/
// proposals/slides-2026-10-31.md §4.1). The cutting is the app's own reading of
// Markdown (@onden/markdown topBlocks, from the same tree the renderer and the
// outline use) — this file only maps its blocks onto slide roles and keeps each
// block's own source. Pure: no DOM, no React.

import { plainInline, stripLineMarker } from "./plainText.js";
import { topBlocks } from "./slideBlocks.js";

export type SlideBlockKind = "heading" | "paragraph" | "list" | "quote" | "image" | "embed" | "code" | "math" | "table";
export type SlideBlock = {
  kind: SlideBlockKind;
  markdown: string;
  /** A heading: its level (1–6), its words as the app reads them (no marks). */
  heading?: { level: number; text: string };
  /** A list: its top-level items as Markdown — no bullet or task box; a nested list stays inside its parent. */
  items?: string[];
};

/** A picture or an embed: what a layout puts beside the words (or over the slide) rather than in the text. */
export const isFigure = (block: SlideBlock) => block.kind === "image" || block.kind === "embed";

/** The blocks of one slide, in order. A heading with a body under it is two blocks. */
export function analyzeSlide(markdown: string): SlideBlock[] {
  const source = markdown.replace(/\r\n/g, "\n");
  const blocks: SlideBlock[] = [];
  for (const block of topBlocks(source)) {
    const text = source.slice(block.from, block.to);
    switch (block.kind) {
      case "rule": break; // `***` and the like divide nothing on a slide
      case "heading": {
        if (!block.heading) break; // a heading the page does not show
        const line = text.split("\n")[0]!.trim(); // a setext heading's underline is not its words
        blocks.push({ kind: "heading", markdown: line, heading: { level: block.heading.depth, text: block.heading.text } });
        break;
      }
      case "list":
        blocks.push({ kind: "list", markdown: text, items: block.items!.map((item) => source.slice(item.from, item.to).trim()) });
        break;
      case "other": blocks.push({ kind: "paragraph", markdown: text }); break;
      default: blocks.push({ kind: block.kind, markdown: text });
    }
  }
  return blocks.filter((block) => block.markdown);
}

/** One line of Markdown as the words a reader sees: no list, quote or task marks, emphasis or link syntax. */
function lineText(line: string, marked = true): string {
  return plainInline(marked ? stripLineMarker(line) : line).trim();
}

/** Markdown (a paragraph, a quote, a list item) as plain words, its lines joined by `joiner`. A list item's own first
 *  line has no mark left to strip (its words may start like one: `2024. a year`). */
export function plainWords(markdown: string, { joiner = "\n", item = false } = {}): string {
  return markdown.split("\n").map((line, i) => lineText(line, !(item && i === 0))).filter(Boolean).join(joiner);
}

/** A list item (listItems) as one line of plain words. */
export const itemText = (item: string): string => plainWords(item, { joiner: " ", item: true });

/** The text of a block without its Markdown marks, one line per list item. */
export function slideBlockText(block: SlideBlock): string {
  if (block.heading) return block.heading.text;
  if (block.items) return block.items.map(itemText).filter(Boolean).join("\n");
  return plainWords(block.markdown);
}

/** The items of a list block as Markdown (nested lines folded into their parent); none for any other block. */
export const listItems = (block: SlideBlock): string[] => block.items ?? [];

/** Text length as the layouts count it: a full-width character is one em, a half-width 0.55. */
export function emLength(text: string): number {
  let em = 0;
  for (const ch of text) em += /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 1 : 0.55;
  return em;
}
