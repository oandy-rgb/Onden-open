// What a `[[Note#` link can point at inside a note: its headings, and its
// paragraphs and list items (the blocks `[[Note#^id]]` reaches). The editor's
// link suggester lists these after the note is chosen; choosing a block
// without an `^id` writes one at `insertAt` (docs/architecture/block-nodes.md).
//
// Read-only and linear: one parse, the same one the renderer's headings and
// block anchors use, so a listed target is one the link then resolves to.
// Empty over BLOCK_PARSE_MAX, like those (a note that long gets no new ids).

import type { Root, RootContent, Parent, Paragraph } from "mdast";
import { BLOCK_PARSE_MAX, anchoredBlocks } from "./blocks.js";
import { parserFor } from "./parsers.js";
import { headingAnchorStarts } from "./headingAnchors.js";
import { frontmatterLength } from "./frontmatter.js";
import { trailingBlockId } from "./blockId.js";
import { ATTRIBUTE_KEY } from "./attributeKey.js";
import { isTagList, replaceWikilinks, splitWikilink } from "./text.js";
import { stripCalloutMarker } from "./callouts.js";
import { cutToUnits } from "./graphemes.js";
import { plainExcerpt } from "./graphemes.js";

/** How many characters of a block its `label` shows. */
export const LINK_TARGET_LABEL_MAX = 60;
/** How many characters of a block its `text` keeps (what a filter matches). */
const TEXT_MAX = 300;

export type LinkTarget =
  | {
      kind: "heading";
      /** The heading as it reads (markers cut): what `[[Note#Heading]]` names. */
      text: string;
      depth: 1 | 2 | 3 | 4 | 5 | 6;
      /** Offset of the heading's first character in the note. */
      start: number;
    }
  | {
      kind: "block";
      blockKind: "paragraph" | "listItem";
      /** The block as plain text (formatting, `{tags}` and `^id` cut, spaces
       *  collapsed), at most 300 characters: what a typed filter matches. */
      text: string;
      /** `text` cut to its first LINK_TARGET_LABEL_MAX characters, "…" when cut. */
      label: string;
      /** The block's `^id`, or null when it has none yet. */
      ref: string | null;
      /** Offset of the block's first character in the note. */
      start: number;
      /** Where ` ^id` is written to give the block one: the end of its
       *  (first) paragraph's last line. */
      insertAt: number;
    };

// Looked up per call, not at import: a module-level parserFor() keeps unified and micromark in any bundle that imports this file.
const parser = { parse: (text: string) => parserFor("anchors").parse(text) };

/** The headings, paragraphs and list items of `markdown` in document order.
 *  Code blocks, tables, HTML and math are not blocks to link to; a paragraph
 *  that is only an `^id` or only hidden `key:: value` lines is skipped. A
 *  task item reads without its box. Offsets are in `markdown` (frontmatter
 *  included). */
export function listLinkTargets(markdown: string, anchors: ReadonlyArray<{ id: string; from: number; to: number }> = []): LinkTarget[] {
  if (typeof markdown !== "string" || markdown.length > BLOCK_PARSE_MAX) return [];
  const out: LinkTarget[] = headingAnchorStarts(markdown).map(({ anchor, start }) => ({
    kind: "heading" as const, text: anchor.text, depth: anchor.depth, start,
  }));

  const shift = frontmatterLength(markdown);
  const source = markdown.slice(shift);
  const ids = new Map(anchoredBlocks(markdown, anchors)
    .filter((a) => a.kind === "paragraph" || a.kind === "listItem")
    .map((a) => [`${a.kind}:${a.start}`, a.id] as const));

  // An explicit stack, not recursion: 2,000 nested `>` must not overflow it.
  const stack: Array<{ node: RootContent; skip: Paragraph | null }> = [];
  const push = (parent: Parent, skip: Paragraph | null) => {
    const kids = parent.children as RootContent[];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i]!, skip });
  };
  push(parser.parse(source) as Root, null);
  const block = (kind: "paragraph" | "listItem", item: RootContent, para: Paragraph) => {
    const end = para.position!.end.offset!;
    const text = plainText(para, source.slice(para.position!.start.offset!, end));
    if (!text) return;
    const start = item.position!.start.offset! + shift;
    out.push({
      kind: "block", blockKind: kind, text: cutToUnits(text, TEXT_MAX), label: labelOf(text),
      ref: ids.get(`${kind}:${start}`) ?? null,
      start, insertAt: end + shift,
    });
  };
  while (stack.length) {
    const { node, skip } = stack.pop()!;
    if (node.type === "paragraph") {
      if (node !== skip) block("paragraph", node, node);
    } else if (node.type === "listItem") {
      const first = node.children[0];
      if (first?.type === "paragraph") block("listItem", node, first);
      push(node, first?.type === "paragraph" ? first : null);
    } else if (node.type === "list" || node.type === "blockquote") {
      push(node, null);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** `text` cut for a row: the first LINK_TARGET_LABEL_MAX characters (grapheme
 *  clusters, so a CJK, emoji or accented character is never split). */
function labelOf(text: string): string {
  return plainExcerpt(text, LINK_TARGET_LABEL_MAX);
}

// A `key::` line the renderer hides (attributeLines.ts), with its key by the one attribute-key rule.
const HIDDEN_ATTRIBUTE_LINE = new RegExp(String.raw`^${ATTRIBUTE_KEY}::(?:\s|$)`, "u");

/** A paragraph as plain text, or "" when it is not worth linking to. */
function plainText(para: Paragraph, raw: string): string {
  if (raw.split("\n").every((line) => HIDDEN_ATTRIBUTE_LINE.test(line.trim()))) return "";
  let text = inlineText(para);
  text = replaceWikilinks(text, (body) => { const { target, alias } = splitWikilink(body); return alias ?? target; });
  text = text.replace(/\s+/g, " ").trim();
  // The markers block nodes end a line with: `^id` (blockId.ts), then `{tags}`.
  const id = trailingBlockId(text);
  if (id) text = text.slice(0, id.start).trimEnd();
  text = text.replace(/\s*\{([^{}]*)\}$/, (whole, inner: string) => (isTagList(inner) ? "" : whole)).trim();
  // A callout's first line names its kind: `[!note] Title` reads as "Title".
  text = stripCalloutMarker(text);
  return text === "^" ? "" : text;
}

/** The text inside inline markup; images read as their alt text, HTML as nothing. */
function inlineText(node: { type: string; children?: unknown[]; value?: string; alt?: string | null }): string {
  switch (node.type) {
    case "text": case "inlineCode": case "inlineMath": return node.value ?? "";
    case "break": return " ";
    case "image": return node.alt ?? "";
    case "html": case "footnoteReference": return "";
    default: return (node.children ?? []).map((c) => inlineText(c as typeof node)).join("");
  }
}
