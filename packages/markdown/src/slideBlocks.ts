// A note's top-level blocks as the app's own parser reads them (parsers.ts
// "anchors": GFM tables and task items, `$$` math) — what the slides view sorts
// into the roles its layouts arrange. One reading of Markdown, not a second
// line-by-line classifier: a table without outer pipes, indented code, a
// callout, `***` or a list under a paragraph are what the renderer says they
// are. Offsets are into the text given, so a caller keeps each block's own
// source (and the `^id` it carries) exactly.

import type { Root, RootContent, ListItem, Heading, Paragraph } from "mdast";
import { embedLine } from "./embeds.js";
import { headingAnchorStarts, type HeadingAnchor } from "./headingAnchors.js";
import { parserFor } from "./parsers.js";
import { lineMarkerLength } from "./plainText.js";

/** `image` and `embed` are paragraphs made only of pictures (`![](…)`) or only of `![[…]]` embed lines (a mix is an
 *  embed): the editor shows such lines as the picture or embed itself, so a slide does too. */
export type TopBlockKind = "heading" | "paragraph" | "image" | "embed" | "list" | "quote" | "code" | "math" | "table" | "rule" | "other";

export type TopBlock = {
  kind: TopBlockKind;
  /** The block's source span in the text given. A heading's span includes a setext underline. */
  from: number;
  to: number;
  /** A heading: how the app reads it (words without marks or `^id`); null for one the page does not show. */
  heading?: HeadingAnchor | null;
  /** A list: its items. `from` is where the item's words start (after the bullet and task box). */
  items?: Array<{ from: number; to: number; /** Task box: ticked or not; null for a plain item. */ checked: boolean | null }>;
};

const KINDS: Partial<Record<RootContent["type"], TopBlockKind>> = {
  heading: "heading", paragraph: "paragraph", list: "list", blockquote: "quote", code: "code",
  math: "math", table: "table", thematicBreak: "rule",
};

const PICTURE = "￼";

/** What a paragraph made only of pictures and embed lines is (see TopBlockKind); null for any other paragraph. */
function figureOf(paragraph: Paragraph): "image" | "embed" | null {
  let text = "";
  for (const child of paragraph.children) {
    if (child.type === "image") text += PICTURE;
    else if (child.type === "text") text += child.value;
    else if (child.type === "break") text += "\n";
    else return null;
  }
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  let embed = false;
  for (const line of lines) {
    if (embedLine(line)) embed = true;
    else if (line.replaceAll(PICTURE, "").trim() !== "") return null;
  }
  return embed ? "embed" : "image";
}

const span = (node: { position?: { start: { offset?: number }; end: { offset?: number } } }) =>
  ({ from: node.position!.start.offset!, to: node.position!.end.offset! });

/** The words of an item start at its first child — except that, when that child opens with emphasis, remark leaves the
 *  task box `[ ] ` inside the child's span, so a task item starts after the line's own marks (lineMarkerLength). */
function itemOf(item: ListItem, source: string) {
  const first = item.children[0];
  const own = span(item);
  const checked = item.checked ?? null;
  let from = first ? span(first).from : own.to;
  if (checked !== null) {
    const newline = source.indexOf("\n", own.from);
    const lineEnd = newline === -1 ? own.to : Math.min(newline, own.to);
    from = Math.min(own.from + lineMarkerLength(source.slice(own.from, lineEnd)), own.to);
  }
  return { from, to: own.to, checked };
}

/** The top-level blocks of `markdown`, in order (a heading with a body under it is two blocks). */
export function topBlocks(markdown: string): TopBlock[] {
  const tree = parserFor("anchors").parse(markdown) as Root;
  const anchors = new Map(headingAnchorStarts(markdown).map(({ anchor, start }) => [start, anchor]));
  return tree.children.map((node): TopBlock => {
    const block: TopBlock = { kind: KINDS[node.type] ?? "other", ...span(node) };
    if (node.type === "paragraph") block.kind = figureOf(node) ?? "paragraph";
    if (node.type === "heading") block.heading = anchors.get(span(node as Heading).from) ?? null;
    if (node.type === "list") block.items = node.children.map((item) => itemOf(item, markdown));
    return block;
  });
}
