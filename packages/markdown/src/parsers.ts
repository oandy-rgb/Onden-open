// The remark parsers that read a note's STRUCTURE (headings, blocks, links,
// code), made in one place so their differences are visible and deliberate.
// They are not the renderer's pipeline (index.ts ondenMarkdownCore): that one
// transforms and sanitises; these only parse, and each takes just the syntax
// extensions its answer depends on. Every extra extension is parse time that
// runs inside a save (see BLOCK_PARSE_MAX in blocks.ts), so a parser lacks one
// only where the answer is the same without it.
//
//   use          GFM (tables, task items, footnotes, strike)   math   wiki-link   used by
//   "blocks"     yes, without the bare-URL autolinker          no     no          blocks.ts parseBlocks / blockAnchors
//   "anchors"    yes, without the bare-URL autolinker          yes    no          headingAnchors.ts, linkTargets.ts
//   "drawnLinks" yes, full remark-gfm                          yes    yes         wikilinkSpans.ts drawnWikilinks
//   "gfmTree"    yes, full remark-gfm                          no     no          gfmTree.ts parseGfmTree
//   "codeBlocks" no                                            no     no          queryBlocks.ts queryBlocksIn
//
// - No autolinker where only structure is read: it is quadratic on long
//   paragraphs (64k chars of `k: v` lines took ~4 s) and bare URLs do not
//   change which blocks or headings there are. drawnLinks keeps the full
//   remark-gfm: it must read the text as the renderer does.
// - No math in "blocks": it only needs the paragraph / list / quote tree.
//   Whether a `$$` block's lines then differ from "anchors" is NOT pinned by a
//   test; do not rely on the two agreeing inside `$$`.
// - "anchors" has math because a `$$` block's `## x` line is math, not a heading.
//   Wikilink syntax does not change which headings or blocks there are.
// - "drawnLinks" has wiki-link: it is the one that decides what is a link.
// - "codeBlocks" needs only fenced code, which core CommonMark parses.

import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkCjkEmphasis } from "./cjkEmphasis.js";
import remarkWikiLink from "remark-wiki-link";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";

/** remark-wiki-link's options in ondenMarkdownCore, minus the link target
 *  (which does not change what is a link). */
export const WIKILINK_SYNTAX = { aliasDivider: "|" } as const;

/** remark-gfm's syntax minus the autolinker (see the table above). */
function remarkGfmBlocks(this: Processor) {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push(gfmTable(), gfmTaskListItem(), gfmFootnote(), gfmStrikethrough());
  (data.fromMarkdownExtensions ??= []).push(gfmTableFromMarkdown(), gfmTaskListItemFromMarkdown(), gfmFootnoteFromMarkdown(), gfmStrikethroughFromMarkdown());
}

// The drawnLinks syntax is the core's, in the core's order (index.ts
// ondenMarkdownCore); the core's other remark plugins transform the tree
// after parsing and do not decide what is a link.
const makers = {
  blocks: () => unified().use(remarkParse).use(remarkGfmBlocks),
  anchors: () => unified().use(remarkParse).use(remarkGfmBlocks).use(remarkMath),
  drawnLinks: () => unified().use(remarkParse).use(remarkCjkEmphasis).use(remarkGfm).use(remarkMath).use(remarkWikiLink, WIKILINK_SYNTAX),
  gfmTree: () => unified().use(remarkParse).use(remarkCjkEmphasis).use(remarkGfm),
  codeBlocks: () => unified().use(remarkParse),
};
export type ParserUse = keyof typeof makers;

const made = new Map<ParserUse, unknown>();

/** The parser for `use` (the table above); one per use, made on first call. */
export function parserFor<U extends ParserUse>(use: U): ReturnType<(typeof makers)[U]> {
  let parser = made.get(use);
  if (!parser) made.set(use, parser = makers[use]());
  return parser as ReturnType<(typeof makers)[U]>;
}
