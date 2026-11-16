// Block nodes (docs/architecture/block-nodes.md): which blocks of a note are
// "upgraded" to nodes, their tags, their scope and their place in the tree.
// One parser for the server (save: B1) and the editor (display: B2), so both
// apply the same rules.
//
//   - paragraph   `text {a, b}`            tags at the end of its last line
//   - list item   `- item {a}`             tags at the end of the item's line;
//                                          scope includes its nested items
//   - heading     `## Title {a}`           scope runs to the next heading of
//                                          the same or a higher level
//   - quote       `> [!quote] Title {a}`   tags on the first line
//
// A block's identity is not in its text: it is the anchor (block_anchors) that
// starts at the block, which the caller passes in (parseBlocks `anchors`), and a
// block's `ref` is that anchor's id. The same tree tells which block an anchor
// is (anchoredBlocks, treeAnchorTargets): what a link to a paragraph reaches,
// tagged or not, and what the renderer (remarkBlockId) marks.
//
// Only a `{…}` at the very end of that line counts, only in plain text — not
// in code or math — and only when it holds nothing but tag entries (tagBraces
// below): `{ indent(); ECHO; }` ending a line of program text that was pasted
// as a paragraph is text, not a tag. The old `^id` marks are read only by the code that moves
// them out of the text (see readLegacyIds below); there Obsidian's `#tag ^id` (a
// block with inline hashtags and an id) counts too, its hashtags as its tags.
//
// Linear in the note: one Markdown parse, then line-local scans from the end.
// (packages/backend/src/test/bodyParsersLinear.test.ts times it.)

import type { Root, RootContent, Parent, Heading, ListItem, Blockquote, Paragraph } from "mdast";
import { frontmatterLength } from "./frontmatter.js";
import { cutToUnits } from "./graphemes.js";
import { parserFor } from "./parsers.js";
import { HASHTAG_RE, isTagList } from "./text.js";
import { BLOCK_ID, trailingBlockId } from "./blockId.js";
import { stripCalloutMarker } from "./callouts.js";

export type BlockKind = "paragraph" | "listItem" | "heading" | "quote";

export type ParsedBlock = {
  kind: BlockKind;
  /** The id of the anchor that starts at the block, or null when none does yet (the save gives it one). */
  ref: string | null;
  /** Tag names, as written (case kept; matched case-insensitively). */
  tags: string[];
  /** `{…}` (Onden's form) or `#tag ^id` (Obsidian's, kept as written). */
  tagSource: "braces" | "hashtags";
  /** What the block reads as: a heading's text, else its first words. */
  label: string;
  /** Source offsets of the block's scope [start, end). */
  start: number;
  end: number;
  /** Index (in the returned list) of the enclosing block node, or null when
   *  the note itself is the parent. */
  parent: number | null;
  /** OLD marks: where a missing `^id` would be written (" ^id" at the end of the tag line, or "\n\n^id" after a
   *  quote); null when `ref` is set. Nothing writes `^id` into a note any more. */
  idAt: { offset: number; form: "inline" | "standalone"; indent?: string } | null;
  /** Where the markers are written, for the editor to show them as chips or
   *  hide them: the `{…}` (braces included; null for `#tag` blocks) and an
   *  old `^id` (caret included; null on a normal read: see readLegacyIds). */
  marks: { tags: Span | null; ref: Span | null };
  /** A task list item's box (`- [ ]` / `- [x]`): whether it is ticked and the
   *  offset of the character between the brackets. Null for anything else. */
  checkbox: { checked: boolean; at: number } | null;
};

/** Source offsets [from, to). */
export type Span = { from: number; to: number };

// Looked up per call, not at import: a module-level parserFor() keeps unified and micromark in any bundle that imports this file.
const parser = { parse: (text: string) => parserFor("blocks").parse(text) };

// The `^id` mark is an OLD way of giving a block its identity (docs/architecture/proposals/block-anchors-2026-11-01.md):
// it now lives in block_anchors and the text carries none, so on a normal read `^id` is plain text. Only the code that
// moves old data out of the text (legacyBlockIds.ts, the importers, an old backup) reads it, inside withLegacyIds.
// One synchronous parse at a time, so a module flag is enough.
let readLegacyIds = false;
function withLegacyIds<T>(read: () => T): T {
  const was = readLegacyIds;
  readLegacyIds = true;
  try { return read(); } finally { readLegacyIds = was; }
}

/** The longest body block nodes are read in. micromark (remark's parser) is
 *  superlinear on some long paragraphs (runs of unclosed `![a](` and the like:
 *  ~144 ms at 20k chars, ~2.4 s at 80k) and the save parses inside the write
 *  transaction, so a longer note keeps the block nodes it has and gets no new
 *  ones until it is shorter (or micromark is fixed). */
export const BLOCK_PARSE_MAX = 32_000;

/** Whether block nodes are read in this body (see BLOCK_PARSE_MAX). A caller
 *  that keeps state from the text must leave it alone when this is false. */
export function blocksParsable(markdown: string): boolean {
  return markdown.length <= BLOCK_PARSE_MAX;
}

/** The block nodes in `markdown`, in document order. Empty for a body over
 *  BLOCK_PARSE_MAX — check blocksParsable() before treating that as "none".
 *  A block's `ref` is the id of the anchor that starts at it (`anchors`: block_anchors rows of this note);
 *  null for a block no anchor starts at yet. The text's own `^id`s are not read (see readLegacyIds). */
export function parseBlocks(markdown: string, anchors: readonly AnchorAt[] = []): ParsedBlock[] {
  if (!blocksParsable(markdown) || !mayHaveBlocks(markdown)) return [];
  const source = blankFrontmatter(markdown);
  const blocks = scanTree(parser.parse(source) as Root, source, true).blocks;
  withAnchorRefs(blocks, source, anchors);
  return blocks;
}

/** parseBlocks as the OLD text marks read it: `ref` is the block's `^id`. For the migration, the importers and a
 *  pre-cutover backup (legacyBlockIds.ts), never for a normal read. */
export function parseLegacyBlocks(markdown: string): ParsedBlock[] {
  return withLegacyIds(() => parseBlocks(markdown));
}

/** A paragraph anchor as the parser needs it: its id and where its block starts (`block_anchors.from_utf16`). */
export type AnchorAt = { id: string; from: number };

/** Gives every block the id of the anchor that starts at it. A block's identity lives in block_anchors, not in the
 *  text; an anchor's start may sit at the line's indentation, which the block's own start (after a list marker's
 *  indent) skips. The first anchor listed for a start wins. */
function withAnchorRefs(blocks: ParsedBlock[], source: string, anchors: readonly AnchorAt[]): void {
  if (anchors.length === 0) return;
  const idAtStart = new Map<number, string>();
  for (const a of anchors) {
    let at = a.from;
    while (at < source.length && (source[at] === " " || source[at] === "\t")) at++;
    if (!idAtStart.has(at)) idAtStart.set(at, a.id);
  }
  for (const block of blocks) if (block.ref === null) block.ref = idAtStart.get(block.start) ?? null;
}

/** OLD marks: `^id`s alone in a paragraph that follow nothing they can anchor (what is
 *  left when the text of a block is deleted but its id stays). A standalone id
 *  after a list, table or quote is that block's anchor, not an orphan. The
 *  renderer already drops these; the editor removes them. Empty over
 *  BLOCK_PARSE_MAX, like parseBlocks. */
export function legacyOrphanIds(markdown: string): Span[] {
  return orphansOf(legacyScan(markdown));
}

/** The `^id` marks the old text carried, from one parse that reads them (empty over BLOCK_PARSE_MAX). */
function legacyScan(markdown: string): TreeAnchor[] {
  if (!blocksParsable(markdown)) return [];
  return withLegacyIds(() => {
    if (!mayHaveBlocks(markdown)) return [];
    const source = blankFrontmatter(markdown);
    return scanTree(parser.parse(source) as Root, source, false).anchors;
  });
}

function orphansOf(found: TreeAnchor[]): Span[] {
  return found.filter((a) => !a.anchor).map((a) => a.mark).sort((a, b) => a.from - b.from);
}

function sortedAnchors(found: TreeAnchor[]): BlockAnchor[] {
  return found.flatMap((a) => (a.anchor ? [a.anchor] : [])).sort((a, b) => a.start - b.start || b.end - a.end);
}

/** OLD marks: what an `^id` anchors: the block a `[[Note#^id]]` link scrolls to and
 *  previews. Every block with an id has one, tagged or not (a block node's
 *  `ref` is its anchor's id).
 *
 *   - paragraph, heading, list item: the `^id` at the end of its (first,
 *     for an item) line, as for block nodes;
 *   - quote: as for block nodes, the `^id` on its own line after it or on its
 *     last line (`> ^id`); a `^id` at the end of its first line belongs to
 *     the paragraph inside;
 *   - list, table: the `^id` on its own line after it (Obsidian's form for
 *     structured blocks).
 *
 *  `start`/`end` are the block's scope, as ParsedBlock's (a heading's runs to
 *  the next heading of the same or a higher level). `mark` is the `^id`,
 *  caret included. An `^id` alone on a line after anything else anchors
 *  nothing (the renderer still hides it). Ids in code and math are text. */
export type BlockAnchor = {
  id: string;
  kind: BlockKind | "list" | "table";
  start: number;
  end: number;
  mark: Span;
};

/** Every block anchor in `markdown`, in document order (an outer block
 *  before the blocks inside it). An id may appear twice; the first is the one
 *  a link reaches, as the page's first `[data-block-id]` is. One parse, the
 *  same as parseBlocks', so the anchors and the block nodes agree. Empty over
 *  BLOCK_PARSE_MAX, like parseBlocks. */
export function legacyBlockAnchors(markdown: string): BlockAnchor[] {
  return sortedAnchors(legacyScan(markdown));
}

/** One `^id` the scan found in a tree: the anchor (null for an id that
 *  anchors nothing), the node it anchors (to tag), and the container whose
 *  text holds the mark (to hide it). For remarkBlockId, which already has
 *  the tree. */
export type TreeAnchor = { anchor: BlockAnchor | null; id: string; mark: Span; target: Parent | null; markIn: Parent };

/** A block-level part of a note, tagged or not: the unit a paragraph anchor points at. */
type BlockSpan = { kind: BlockAnchor["kind"]; start: number; end: number; target: Parent };

/** What a paragraph anchor means in `markdown`: the block that starts where it does — paragraph, heading, list item,
 *  quote, list or table, tagged or not. `start`/`end` are the block's scope, as ParsedBlock's. Where several blocks
 *  start at the same place (a list and its first item) the one whose end is nearest the anchor's own `to` wins; an
 *  anchor no block starts at (the text moved, it is `lost`) is not listed. The first anchor of an id wins. Empty over
 *  BLOCK_PARSE_MAX. */
export function anchoredBlocks(
  markdown: string, anchors: ReadonlyArray<{ id: string; from: number; to: number }>,
): Array<{ id: string; kind: BlockAnchor["kind"]; start: number; end: number }> {
  if (!blocksParsable(markdown) || anchors.length === 0) return [];
  const source = blankFrontmatter(markdown);
  const { spans } = scanTree(parser.parse(source) as Root, source, false, true);
  return pickSpans(source, spans, anchors).map(({ id, span: { kind, start, end } }) => ({ id, kind, start, end }));
}

/** Every block of `markdown` (paragraph, heading, list, list item, quote, table…), tagged or not, in document order
 *  (a block before the blocks inside it). The shape of the note, to line up two texts that hold the same blocks —
 *  a moved selection and the child it became. Empty over BLOCK_PARSE_MAX. */
export function blockSpans(markdown: string): Array<{ kind: BlockAnchor["kind"]; start: number; end: number }> {
  if (!blocksParsable(markdown)) return [];
  const source = blankFrontmatter(markdown);
  const { spans } = scanTree(parser.parse(source) as Root, source, false, true);
  return spans.map(({ kind, start, end }) => ({ kind, start, end })).sort((x, y) => x.start - y.start || y.end - x.end);
}

/** For each anchor, the block span it starts (see anchoredBlocks), in document order. */
function pickSpans(
  source: string, spans: readonly BlockSpan[], anchors: ReadonlyArray<{ id: string; from: number; to: number }>,
): Array<{ id: string; span: BlockSpan }> {
  const byStart = new Map<number, BlockSpan[]>();
  for (const span of spans) byStart.set(span.start, [...(byStart.get(span.start) ?? []), span]);
  const seen = new Set<string>();
  const out: Array<{ id: string; span: BlockSpan }> = [];
  for (const a of anchors) {
    if (seen.has(a.id)) continue;
    let at = a.from;
    while (at < source.length && (source[at] === " " || source[at] === "\t")) at++;
    const here = byStart.get(at);
    if (!here) continue;
    // Nearest end wins; on a tie the smaller block (a list's only item over the list itself).
    const best = here.reduce((x, y) => {
      const dx = Math.abs(x.end - a.to), dy = Math.abs(y.end - a.to);
      return dy < dx || (dy === dx && x.kind === "list" && y.kind !== "list") ? y : x;
    });
    seen.add(a.id);
    out.push({ id: a.id, span: best });
  }
  return out.sort((x, y) => x.span.start - y.span.start || y.span.end - x.span.end);
}

/** The mdast node each anchor starts, in an already-parsed tree of `source` (remarkBlockId sets `data-block-id` on it). */
export function treeAnchorTargets(
  tree: Root, source: string, anchors: ReadonlyArray<{ id: string; from: number; to: number }>,
): Array<{ id: string; target: Parent }> {
  if (anchors.length === 0 || !blocksParsable(source)) return [];
  const { spans } = scanTree(tree, source, false, true);
  return pickSpans(source, spans, anchors).map(({ id, span }) => ({ id, target: span.target }));
}

/** One `{…}` tag mark the scan found: the tag names, the mark's span
 *  (braces included), the block node it tags and the container whose text
 *  holds it. The same reading as ParsedBlock's `marks.tags`. */
export type TreeTagMark = { tags: string[]; mark: Span; target: Parent; markIn: Parent };

/** The `^id` anchors and `{…}` tag marks in an already-parsed tree of
 *  `source` (remarkBlockId): one scan, the same as parseBlocks'. */
export function treeMarks(tree: Root, source: string): { anchors: TreeAnchor[]; tagMarks: TreeTagMark[] } {
  return mayHaveBlocks(source) ? scanTree(tree, source, true) : { anchors: [], tagMarks: [] };
}

/** Frontmatter blanked (same length, newlines kept) so offsets still point
 *  into the original text but remark doesn't read it as a heading. */
function blankFrontmatter(markdown: string): string {
  const fmLength = frontmatterLength(markdown);
  return fmLength ? markdown.slice(0, fmLength).replace(/[^\n]/g, " ") + markdown.slice(fmLength) : markdown;
}

/** The scan behind parseBlocks, blockAnchors and treeMarks: block nodes
 *  (when `withBlocks`) and anchors, from one walk. */
function scanTree(tree: Root, source: string, withBlocks: boolean, withSpans = false): { blocks: ParsedBlock[]; anchors: TreeAnchor[]; tagMarks: TreeTagMark[]; spans: BlockSpan[] } {
  const found: ParsedBlock[] = [];
  const spans: BlockSpan[] = [];
  const anchors: TreeAnchor[] = [];
  const tagMarks: TreeTagMark[] = [];
  // A `{…}` block's node and the container holding its text.
  const keep = (block: ParsedBlock, target: Parent, markIn: Parent) => {
    found.push(block);
    if (block.marks.tags) tagMarks.push({ tags: block.tags, mark: block.marks.tags, target, markIn });
  };
  // Marks already read as a list item's or quote's, not as the paragraph's
  // they sit in.
  const taken = new Set<number>();
  const anchor = (kind: BlockAnchor["kind"], id: { id: string; span: Span }, target: Parent, markIn: Parent, start: number, end: number) => {
    taken.add(id.span.from);
    anchors.push({ anchor: { id: id.id, kind, start, end, mark: id.span }, id: id.id, mark: id.span, target, markIn });
  };
  const inlineId = (lineEnd: number) => {
    const id = trailingId(source, lineStartAt(source, lineEnd), lineEnd);
    return id && { id: id.id, span: idSpan(id) };
  };

  // An explicit stack, not recursion: a note of 2,000 nested `>` must not
  // overflow the call stack inside the save. Children are pushed in reverse,
  // so blocks come out in document order. `skip`: the paragraph that is a list
  // item's or quote's own line, read with the item / quote.
  type Frame = { node: RootContent; parent: Parent; index: number; skip: Paragraph | null };
  const stack: Frame[] = [];
  const pushChildren = (parent: Parent, skip: Paragraph | null) => {
    const kids = parent.children as RootContent[];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i]!, parent, index: i, skip });
  };
  pushChildren(tree, null);
  while (stack.length) {
    const { node, parent, index, skip } = stack.pop()!;
    if (node.type === "heading") {
      const heading = node as Heading;
      const last = heading.children[heading.children.length - 1];
      // The heading's text ends where its last inline ends: an ATX closing
      // `##` and a setext underline (`===`) come after it.
      if (last) {
        const end = () => headingEnd(parent.children as RootContent[], index, heading.depth, parent);
        if (withSpans) spans.push({ kind: "heading", start: heading.position!.start.offset!, end: end(), target: heading });
        const id = inlineId(last.position!.end.offset!);
        if (id) anchor("heading", id, heading, heading, heading.position!.start.offset!, end());
        const block = withBlocks ? fromLine(source, heading, last.position!.end.offset!, "heading") : null;
        if (block) {
          block.end = end();
          keep(block, heading, heading);
        }
      }
    } else if (node.type === "paragraph") {
      if (withSpans && node !== skip) spans.push({ kind: "paragraph", start: node.position!.start.offset!, end: node.position!.end.offset!, target: node });
      const alone = standaloneId(source, node);
      if (alone) {
        // A quote before it took it already; after a list or table it is
        // theirs; after anything else it anchors nothing.
        if (!taken.has(alone.span.from)) {
          const before = (parent.children as RootContent[])[index - 1];
          if (before?.type === "list" || before?.type === "table") {
            anchor(before.type, alone, before, parent, before.position!.start.offset!, before.position!.end.offset!);
          } else {
            anchors.push({ anchor: null, id: alone.id, mark: alone.span, target: null, markIn: parent });
          }
        }
      } else {
        const id = inlineId(node.position!.end.offset!);
        if (id && !taken.has(id.span.from)) anchor("paragraph", id, node, node, node.position!.start.offset!, node.position!.end.offset!);
      }
      if (withBlocks && node !== skip) {
        const block = fromLine(source, node, node.position!.end.offset!, "paragraph");
        if (block) keep(block, node, node);
      }
    } else if (node.type === "listItem") {
      const first = (node as ListItem).children[0];
      if (withSpans && first?.type === "paragraph") spans.push({ kind: "listItem", start: node.position!.start.offset!, end: node.position!.end.offset!, target: node as Parent });
      if (first?.type === "paragraph") {
        const id = inlineId(first.position!.end.offset!);
        if (id) anchor("listItem", id, node as Parent, node as Parent, node.position!.start.offset!, node.position!.end.offset!);
        const block = withBlocks ? fromLine(source, first, first.position!.end.offset!, "listItem") : null;
        if (block) {
          block.start = node.position!.start.offset!;
          block.end = node.position!.end.offset!;
          block.checkbox = checkboxOf(source, node as ListItem, first);
          keep(block, node as Parent, node as Parent);
        }
      }
      pushChildren(node as Parent, first?.type === "paragraph" ? first : null);
    } else if (node.type === "blockquote") {
      const quote = node as Blockquote;
      const first = quote.children[0];
      if (withSpans && first?.type === "paragraph") spans.push({ kind: "quote", start: quote.position!.start.offset!, end: quote.position!.end.offset!, target: quote });
      if (first?.type === "paragraph") {
        const lineEnd = endOfLine(source, first.position!.start.offset!, first.position!.end.offset!);
        // The quote's ^id: alone on its own line after it (in the same
        // container), or on its last line (`> ^id`, with or without a blank
        // line before).
        const next = (parent.children as RootContent[])[index + 1];
        const after = next?.type === "paragraph" ? standaloneId(source, next) : null;
        const quoteId = after ?? lastLineId(source, quote, first);
        if (quoteId) anchor("quote", quoteId, quote, after ? parent : quote, quote.position!.start.offset!, quote.position!.end.offset!);
        const ref = quoteId?.id ?? null;
        const block = withBlocks ? fromLine(source, first, lineEnd, "quote") : null;
        const tagged = block ?? (withBlocks && quoteId ? hashtagBlock(source, first, lineEnd, "quote") : null);
        if (tagged) {
          tagged.start = quote.position!.start.offset!;
          tagged.end = quote.position!.end.offset!;
          tagged.ref = ref;
          tagged.marks.ref = quoteId?.span ?? null;
          tagged.idAt = ref ? null : { offset: quote.position!.end.offset!, form: "standalone", indent: containerIndent(source, quote) };
          keep(tagged, quote, first);
        }
      }
      pushChildren(quote, first?.type === "paragraph" ? first : null);
    } else if (withSpans && (node.type === "list" || node.type === "table")) {
      spans.push({ kind: node.type, start: node.position!.start.offset!, end: node.position!.end.offset!, target: node as Parent });
      if (node.type === "list") pushChildren(node as Parent, null);
    } else if ("children" in node) {
      pushChildren(node as Parent, null);
    }
  }
  return { blocks: withParents(found), anchors, tagMarks, spans };
}

/** Every `^id` written in the note (line-end or alone on a line): what the migration read; the backup round-trip
 *  test helpers still read a note's written ids with it. */
export function legacyIdsIn(markdown: string): string[] {
  return withLegacyIds(() => {
    const ids: string[] = [];
    let lineEnd = markdown.length;
    while (lineEnd >= 0) {
      const lineStart = lineStartAt(markdown, lineEnd);
      const id = trailingId(markdown, lineStart, trimEnd(markdown, lineStart, lineEnd));
      if (id) ids.push(id.id);
      if (lineStart === 0) break;
      lineEnd = lineStart - 1;
    }
    return ids.reverse();
  });
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Linear pre-check: some line ends like a block node's (`}` before an
 *  optional ` ^id`, or an `^id`; a heading's closing `##` aside). Most bodies
 *  have none and skip the parse. */
export function mayHaveBlocks(markdown: string): boolean {
  let lineEnd = markdown.length;
  while (lineEnd >= 0) {
    const lineStart = lineStartAt(markdown, lineEnd);
    let end = trimEnd(markdown, lineStart, lineEnd);
    if (markdown[end - 1] === "#") {
      let hashes = end;
      while (hashes > lineStart && markdown[hashes - 1] === "#") hashes--;
      if (hashes > lineStart && /\s/.test(markdown[hashes - 1]!)) end = trimEnd(markdown, lineStart, hashes);
    }
    const id = trailingId(markdown, lineStart, end);
    if (id) return true;
    if (end > lineStart && markdown[end - 1] === "}") return true;
    if (lineStart === 0) break;
    lineEnd = lineStart - 1;
  }
  return false;
}

/** Where the heading's last child ends. Nodes a syntax plugin made from text
 *  (the bare URL inside an unclosed `![[`) can lack a position: the last one
 *  that has one decides, looking into its children. */
function lastChildEnd(parent: Parent): number | null {
  for (let i = parent.children.length - 1; i >= 0; i--) {
    const child = parent.children[i]!;
    const end = child.position?.end.offset ?? ("children" in child ? lastChildEnd(child) : null);
    if (end !== null && end !== undefined) return end;
  }
  return null;
}

/** Where a heading's text ends: before the `{…}` and the `^id` that end its
 *  line, as block nodes read them (fromLine): the `{…}` only in plain text,
 *  not escaped, and not empty. For headingAnchors.ts, so a heading's anchor
 *  text is its label without the markers. */
export function headingTextEnd(source: string, heading: Heading): number {
  const lineEnd = lastChildEnd(heading);
  if (lineEnd === null) return heading.position!.start.offset!;
  const lineStart = lineStartAt(source, lineEnd);
  let end = trimEnd(source, lineStart, lineEnd);
  const id = trailingId(source, lineStart, end);
  if (id) end = trimEnd(source, lineStart, id.start);
  const braces = tagBraces(source, heading, lineStart, end);
  if (braces && source.slice(braces.open + 1, braces.close).trim()) end = trimEnd(source, lineStart, braces.open);
  return end;
}

/** A block whose tag line ends at `lineEnd`: `{…}` there, or `#tag` + `^id`. */
function fromLine(source: string, host: Paragraph | Heading, lineEnd: number, kind: BlockKind): ParsedBlock | null {
  const lineStart = lineStartAt(source, lineEnd);
  let end = trimEnd(source, lineStart, lineEnd);
  const id = kind === "quote" ? null : trailingId(source, lineStart, end);
  if (id) end = trimEnd(source, lineStart, id.start);
  const braces = tagBraces(source, host, lineStart, end);
  if (braces) {
    const { tags } = braces;
    if (tags.length > 0) {
      return {
        kind, ref: id?.id ?? null, tags, tagSource: "braces",
        label: firstLine(source, host.position!.start.offset!, braces.open),
        start: host.position!.start.offset!, end: host.position!.end.offset!, parent: null,
        idAt: id ? null : { offset: braces.close + 1, form: "inline" },
        marks: { tags: { from: braces.open, to: braces.close + 1 }, ref: id ? idSpan(id) : null },
        checkbox: null,
      };
    }
  }
  return id ? hashtagBlock(source, host, end, kind, idSpan(id), id.id) : null;
}

/** Obsidian's form: the block carries an `^id` and inline `#tags`. */
function hashtagBlock(source: string, host: Paragraph | Heading, textEnd: number, kind: BlockKind, refSpan: Span | null = null, ref: string | null = null): ParsedBlock | null {
  const start = host.position!.start.offset!;
  const text = source.slice(start, textEnd);
  // Only hashtags in plain text: not in `code`, links or HTML.
  const tags = [...new Set([...text.matchAll(HASHTAG_RE)]
    .filter((m) => plainTextAt(host, start + m.index! + m[1]!.length))
    .map((m) => m[2]!))];
  if (tags.length === 0) return null;
  return {
    kind, ref, tags, tagSource: "hashtags", label: firstLine(source, host.position!.start.offset!, textEnd),
    start: host.position!.start.offset!, end: host.position!.end.offset!, parent: null, idAt: null,
    marks: { tags: null, ref: refSpan },
    checkbox: null,
  };
}

/** ` ^id` at the end of [lineStart, end) (blockId.ts). */
function trailingId(source: string, lineStart: number, end: number): { id: string; start: number } | null {
  return readLegacyIds ? trailingBlockId(source, lineStart, end) : null;
}

/** A `{…}` closing exactly at `end` with no brace or newline inside. */
function trailingBraces(source: string, lineStart: number, end: number): { open: number; close: number } | null {
  if (source[end - 1] !== "}") return null;
  for (let i = end - 2; i >= lineStart; i--) {
    const c = source[i];
    if (c === "{") return { open: i, close: end - 1 };
    if (c === "}" || c === "\n") return null;
  }
  return null;
}

/** True when `offset` falls in a plain text node of `host` (not code, math,
 *  a link URL or HTML). */
function plainTextAt(host: Parent, offset: number): boolean {
  let node: Parent | RootContent = host;
  for (;;) {
    const kids: RootContent[] = "children" in node ? (node as Parent).children as RootContent[] : [];
    const hit: RootContent | undefined = kids.find((k) => k.position!.start.offset! <= offset && offset < k.position!.end.offset!);
    if (!hit) return false;
    if (hit.type === "text") return true;
    if (!("children" in hit) || hit.type === "link" || hit.type === "linkReference") return false;
    node = hit;
  }
}

function splitTags(inner: string): string[] {
  // `key: value` entries are block attributes (later); tags are the rest.
  return [...new Set(inner.split(",").map((t) => t.trim()).filter((t) => t && !t.includes(":")))];
}

/** Whether this line ends in a tag `{…}`: the braces end the line, are not escaped (`\{t\}` is the author
 *  writing literal braces), sit in plain text, and hold nothing but tag entries (isTagList, text.ts). Null otherwise: then the braces are
 *  text for every reader (block nodes, the tag slot the editor writes into, a heading's label). */
function tagBraces(source: string, host: Parent, lineStart: number, end: number): { open: number; close: number; tags: string[] } | null {
  const braces = trailingBraces(source, lineStart, end);
  if (!braces || source[braces.open - 1] === "\\" || source[braces.close - 1] === "\\" || !plainTextAt(host, braces.open)) return null;
  const inner = source.slice(braces.open + 1, braces.close);
  if (!isTagList(inner)) return null;
  return { ...braces, tags: splitTags(inner) };
}

function standaloneId(source: string, p: Paragraph): { id: string; span: Span } | null {
  return lineId(source, p.position!.start.offset!, p.position!.end.offset!);
}

/** [start, end) holding only `^id` (after `>` / indentation). */
function lineId(source: string, start: number, end: number): { id: string; span: Span } | null {
  if (!readLegacyIds) return null;
  const raw = source.slice(start, end);
  const text = raw.replace(/^[>\s]+/, "").trim();
  if (text[0] !== "^" || !BLOCK_ID.test(text.slice(1))) return null;
  const from = start + raw.indexOf("^");
  return { id: text.slice(1), span: { from, to: from + text.length } };
}

function idSpan(id: { id: string; start: number }): Span {
  return { from: id.start, to: id.start + 1 + id.id.length };
}

function headingEnd(siblings: RootContent[], index: number, depth: number, parent: Parent): number {
  for (let j = index + 1; j < siblings.length; j++) {
    const s = siblings[j]!;
    if (s.type === "heading" && (s as Heading).depth <= depth) return s.position!.start.offset!;
  }
  return parent.position?.end.offset ?? siblings[siblings.length - 1]!.position!.end.offset!;
}

/** A quote's last line when it is only `^id` (`> ^id`). */
function lastLineId(source: string, quote: Blockquote, first: Paragraph): { id: string; span: Span } | null {
  const end = quote.position!.end.offset!;
  const lineStart = lineStartAt(source, end);
  if (lineStart <= first.position!.start.offset!) return null; // the tag line itself
  return lineId(source, lineStart, end);
}

/** What precedes the quote on its first line, as the indentation a line
 *  inside the same container takes: `  ` in a list item (its marker as
 *  spaces), `> ` in an outer quote. */
function containerIndent(source: string, quote: Blockquote): string {
  const start = quote.position!.start.offset!;
  const lineStart = lineStartAt(source, start);
  return source.slice(lineStart, start).replace(/[^\s>]/g, " ");
}

function endOfLine(source: string, from: number, max: number): number {
  const nl = source.indexOf("\n", from);
  return nl === -1 || nl > max ? max : nl;
}

/** Where the line holding the character before `pos` starts. At 0 it is 0:
 *  `lastIndexOf("\n", -1)` searches from 0, so a body starting with a blank
 *  line would put the first line's start after its own end (and a loop that
 *  walks lines backwards would never reach 0). */
function lineStartAt(source: string, pos: number): number {
  return pos <= 0 ? 0 : source.lastIndexOf("\n", pos - 1) + 1;
}

function trimEnd(source: string, start: number, end: number): number {
  while (end > start && /\s/.test(source[end - 1]!)) end--;
  return end;
}

/** The label from the block's first line, up to `end` (where its tags start). */
function firstLine(source: string, start: number, end: number): string {
  const nl = source.indexOf("\n", start);
  return clean(source.slice(start, nl === -1 || nl > end ? end : nl));
}

/** A readable label: markers and the tag/id suffix gone, at most 60 chars. */
function clean(text: string): string {
  const flat = stripCalloutMarker(text.replace(/^[\s>]*(?:#{1,6}\s+)?(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?/, ""))
    .replace(/\s+/g, " ").trim();
  return cutToUnits(flat, 60);
}

/** Parents by containment: the innermost earlier block whose scope holds
 *  this one. Scopes nest or are disjoint (Markdown structure is a tree). */
function withParents(blocks: ParsedBlock[]): ParsedBlock[] {
  const order = blocks.map((b, i) => i).sort((a, b) => blocks[a]!.start - blocks[b]!.start || blocks[b]!.end - blocks[a]!.end);
  const stack: number[] = [];
  for (const i of order) {
    const b = blocks[i]!;
    while (stack.length && blocks[stack[stack.length - 1]!]!.end <= b.start) stack.pop();
    b.parent = stack.length ? stack[stack.length - 1]! : null;
    stack.push(i);
  }
  return blocks;
}

// ── Tagging a block from the editor (B2b) ───────────────────────────────────

/** Where the block around a caret takes its `{…}`: the innermost paragraph,
 *  list item, heading or quote holding `offset`, by the same rules
 *  parseBlocks reads (a list item's and a heading's tag line is its first,
 *  a paragraph's its last, a quote's its first). */
export type BlockTagSlot = {
  kind: BlockKind;
  /** The block's scope [start, end), as ParsedBlock's. */
  start: number;
  end: number;
  /** Tags already written in its `{…}` (empty when there is none). */
  tags: string[];
  /** Its `{…}`, braces included, or null. */
  braces: Span | null;
  /** Where a new ` {…}` goes: the end of the tag line's text, before any
   *  ` ^id`. */
  insertAt: number;
};

/** The block a caret at `offset` would tag, or null (code, a table, front
 *  matter, a blank line, or a body over BLOCK_PARSE_MAX). */
export function blockTagSlot(markdown: string, offset: number): BlockTagSlot | null {
  if (!blocksParsable(markdown)) return null;
  const source = blankFrontmatter(markdown);
  let best: { slot: BlockTagSlot; size: number } | null = null;
  walkTagSlots(parser.parse(source) as Root, source, (start, end) => offset >= start && offset <= end, (slot) => {
    // A caret right after the block's last character still counts.
    if (offset < slot.start || offset > slot.end) return;
    if (best && slot.end - slot.start >= best.size) return;
    best = { size: slot.end - slot.start, slot };
  });
  // A heading's scope runs over the paragraphs under it: one of those, when
  // the caret is in it, is the smaller (innermost) block and wins above.
  return (best as { slot: BlockTagSlot } | null)?.slot ?? null;
}

/** What Enter does inside a paragraph that carries a `{…}` (業主 2026-11-08, proposal block-anchors §5.3): insert
 *  `insert` at `at` — a blank line, so the paragraph becomes two — and put the caret at `caret`. */
export type TaggedParagraphSplit = { at: number; insert: string; caret: number };

/** Where and how Enter cuts the top-level paragraph holding `offset` in two, when that paragraph has a `{…}`; null for
 *  everything else (untagged paragraphs, quotes, list items, headings, code: their Enter is unchanged).
 *
 *  Why a cut and not a soft break: a paragraph's `{…}` counts only on its LAST line, and the paragraph is one item (a task,
 *  a review card) because of it. A soft break after the tag leaves the `{…}` mid-paragraph — plain text, the item is lost
 *  (2026-11-07 report, Android 注音). So Enter anywhere in a tagged paragraph makes two paragraphs; which half is the item
 *  is `splitAnchorSpan`'s rule (the half with the `{…}`). A caret inside the braces cuts after the `}`, so the tag is
 *  never split; a caret after them cuts at the end of the tag line. Shift+Enter is the caller's soft break, not this. */
export function splitTaggedParagraph(markdown: string, offset: number): TaggedParagraphSplit | null {
  if (offset < 0 || offset > markdown.length) return null;
  const slot = blockTagSlot(markdown, offset);
  if (!slot || slot.kind !== "paragraph" || !slot.braces) return null;
  // Only a paragraph that starts its line at column 0: a quote's or a list item's paragraph starts after its marks or indent.
  if (markdown.lastIndexOf("\n", slot.start - 1) + 1 !== slot.start) return null;
  const { braces } = slot;
  const lineEndOf = (from: number) => { const nl = markdown.indexOf("\n", from); return nl === -1 ? markdown.length : nl; };
  const at = offset > braces.from && offset < braces.to ? braces.to : offset >= braces.to ? lineEndOf(braces.to) : offset;
  // At the end of a line that more of the paragraph follows, the line break already there is half of the cut.
  const continues = lineEndOf(at) === at && at < slot.end && markdown.slice(at + 1, lineEndOf(at + 1)).trim() !== "";
  return { at, insert: continues ? "\n" : "\n\n", caret: at + 2 };
}

/** Which half of a paragraph that was just cut in two keeps the paragraph's identity (its anchor, and with it its
 *  block_nodes row, review progress, task state, tags and the links to it): the half with a `{…}` — the first one, when
 *  both have — else the first half (§5.3). `before` and `after` are the text of the anchor's span before and after the
 *  edit; returns the range of `after` the anchor now covers, or null when the span stays as it is (nothing was cut). Blank space around a lone paragraph is trimmed the same way.
 *
 *  The one statement of the rule, read by the editor (editorAnchors, as the person types) and the server
 *  (blockAnchors/mapping, when it moves anchors over a save), so both put the identity in the same place. A span that
 *  already held a paragraph break is a deliberate multi-paragraph anchor and is never narrowed; so is one that is not a
 *  run of plain paragraphs (a list item, a heading). */
export function splitAnchorSpan(before: string, after: string): Span | null {
  if (/\n[ \t]*\n/.test(before)) return null;
  // The common case (a character typed): one trimmed paragraph, nothing to decide — and no parse, since the server asks this of every anchor of a save.
  if (after === after.trim() && !/\n[ \t]*\n/.test(after)) return null;
  const kids = (parser.parse(after) as Root).children;
  if (kids.length === 0 || kids.some((k) => k.type !== "paragraph")) return null;
  const paragraphs = kids as Paragraph[];
  const owner = paragraphs.find((p) => {
    const from = p.position!.start.offset!, to = p.position!.end.offset!;
    return tagSlotOf(after, "paragraph", p, to, from, to).braces !== null;
  }) ?? paragraphs[0]!;
  const span = { from: owner.position!.start.offset!, to: owner.position!.end.offset! };
  return span.from === 0 && span.to === after.length ? null : span;
}

/** Puts a paragraph's `{…} ^id` back where blocks are read from. A paragraph's tag line is its LAST line; when
 *  text was typed under the marker (Enter, then typing: 2026-11-07) the `{…} ^id` ended up mid-paragraph, as plain
 *  text, and the block's row was hidden. The fix moves the marker, unchanged, to the end of the paragraph's last
 *  line (`文字 {複習} ^ab12\n新的字` → `文字\n新的字 {複習} ^ab12`), so the same id owns the block again.
 *
 *  Null (nothing changed) unless it is certain: `^id` occurs once, ends a line that is followed by more lines of
 *  the same paragraph, the line's `{…}` before it is a plain tag list, and the moved result parses as a block with
 *  that id and those tags without changing any other block's id. Used by the repair job (services/blockMarkerRepair.ts). */
export function repairSplitBlockMarker(markdown: string, ref: string): string | null {
  if (!blocksParsable(markdown) || !BLOCK_ID.test(ref)) return null;
  const token = `^${ref}`;
  const first = markdown.indexOf(token);
  if (first === -1 || markdown.indexOf(token, first + 1) !== -1) return null;
  const lines = markdown.split("\n");
  let at = 0;
  const index = lines.findIndex((line) => { if (at + line.length >= first) return true; at += line.length + 1; return false; });
  if (index === -1) return null;
  const match = /^(.*?)[ \t]*(\{[^{}\n]{1,200}\})[ \t]+\^[a-zA-Z0-9-]{1,64}[ \t]*$/.exec(lines[index]!);
  if (!match || !isTagList(match[2]!.slice(1, -1)) || match[1]!.trim() === "" || !lines[index]!.endsWith(token) && !lines[index]!.trimEnd().endsWith(token)) return null;
  let last = index;
  while (last + 1 < lines.length && lines[last + 1]!.trim() !== "") last++;
  if (last === index) return null; // the marker already ends its paragraph
  const braces = match[2]!;
  const out = lines.slice();
  out[index] = match[1]!;
  out[last] = `${out[last]!.trimEnd()} ${braces} ${token}`;
  const result = out.join("\n");
  const before = parseLegacyBlocks(markdown);
  const after = parseLegacyBlocks(result);
  const mine = after.filter((b) => b.ref === ref);
  const sameTags = mine.length === 1 && mine[0]!.tags.join("\u0000") === splitTags(braces.slice(1, -1)).join("\u0000");
  const othersKept = after.filter((b) => b.ref !== ref).map((b) => b.ref).join() === before.map((b) => b.ref).join();
  return sameTags && !before.some((b) => b.ref === ref) && othersKept ? result : null;
}

/** The tag slot of a block whose tag line ends at `lineEnd` (see BlockTagSlot). */
function tagSlotOf(source: string, kind: BlockKind, host: Paragraph | Heading, lineEnd: number, start: number, end: number): BlockTagSlot {
  const lineStart = lineStartAt(source, lineEnd);
  let textEnd = trimEnd(source, lineStart, lineEnd);
  const id = kind === "quote" ? null : trailingId(source, lineStart, textEnd);
  if (id) textEnd = trimEnd(source, lineStart, id.start);
  const found = tagBraces(source, host, lineStart, textEnd);
  return {
    kind, start, end, insertAt: textEnd,
    tags: found ? found.tags : [],
    braces: found ? { from: found.open, to: found.close + 1 } : null,
  };
}

/** Every block of the tree that can take a `{…}`, as a tag slot, in the order
 *  found: paragraphs, list items, headings and quotes, not code or tables.
 *  Nodes whose range `holds` rejects are not entered (a heading is looked at
 *  anyway: its scope reaches past its own lines). `own` is the end of the
 *  block's own text: a heading's line, a list item's or quote's first paragraph. */
function walkTagSlots(
  tree: Root, source: string, holds: (start: number, end: number) => boolean,
  emit: (slot: BlockTagSlot, own: number) => void,
): void {
  const stack: Array<{ node: RootContent; parent: Parent; index: number; skip: Paragraph | null }> = [];
  const push = (parent: Parent, skip: Paragraph | null) => {
    const kids = parent.children as RootContent[];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i]!, parent, index: i, skip });
  };
  push(tree, null);
  while (stack.length) {
    const { node, parent, index, skip } = stack.pop()!;
    const pos = node.position!;
    const from = pos.start.offset!, to = pos.end.offset!;
    if (!holds(from, to) && node.type !== "heading") continue;
    if (node.type === "heading") {
      const heading = node as Heading;
      const last = heading.children[heading.children.length - 1];
      if (last && holds(from, to)) {
        emit(tagSlotOf(source, "heading", heading, last.position!.end.offset!, from, headingEnd(parent.children as RootContent[], index, heading.depth, parent)), to);
      }
    } else if (node.type === "paragraph") {
      if (node !== skip && !standaloneId(source, node)) emit(tagSlotOf(source, "paragraph", node, to, from, to), to);
    } else if (node.type === "listItem") {
      const first = (node as ListItem).children[0];
      if (first?.type === "paragraph") emit(tagSlotOf(source, "listItem", first, first.position!.end.offset!, from, to), first.position!.end.offset!);
      push(node as Parent, first?.type === "paragraph" ? first : null);
    } else if (node.type === "blockquote") {
      const first = (node as Blockquote).children[0];
      if (first?.type === "paragraph") {
        emit(tagSlotOf(source, "quote", first, endOfLine(source, first.position!.start.offset!, first.position!.end.offset!), from, to), first.position!.end.offset!);
      }
      push(node as Parent, first?.type === "paragraph" ? first : null);
    } else if (node.type !== "code" && node.type !== "table" && "children" in node) {
      push(node as Parent, null);
    }
  }
}

/** Every block the text `[from, to]` touches, in document order — what 「加標籤」
 *  on a selection tags: each paragraph, list item, heading or quote with a
 *  piece of its own text (a heading's line, a list item's first line, a
 *  quote's first paragraph) inside the range. A heading's section and an
 *  item's nested items are blocks of their own. Empty for code, tables, front
 *  matter and a body over BLOCK_PARSE_MAX. */
export function blockTagSlotsIn(markdown: string, from: number, to: number): BlockTagSlot[] {
  if (!blocksParsable(markdown)) return [];
  const source = blankFrontmatter(markdown);
  const found: BlockTagSlot[] = [];
  walkTagSlots(parser.parse(source) as Root, source, (start, end) => start <= to && end >= from, (slot, own) => {
    if (slot.start <= to && own >= from) found.push(slot);
  });
  return found.sort((a, b) => a.start - b.start);
}

/** `markdown` with `name` added to the `{…}` of the block at `offset`
 *  (written when missing), or null when there is no such block. A name it
 *  already has (any case) leaves the body as it is. */
export function addBlockTag(markdown: string, offset: number, name: string): string | null {
  const tag = name.trim().replace(/^#/, "").replace(/[{},]/g, "");
  const slot = blockTagSlot(markdown, offset);
  // A name the `{…}` grammar cannot hold (isTagList) would be written as text, not as a tag: refuse instead.
  if (!slot || !tag || tag.includes(":") || !isTagList(tag)) return null;
  if (slot.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return markdown;
  if (slot.braces) {
    const close = slot.braces.to - 1;
    const inner = markdown.slice(slot.braces.from + 1, close).trimEnd();
    return markdown.slice(0, slot.braces.from + 1) + (inner ? `${inner}, ${tag}` : tag) + markdown.slice(close);
  }
  return `${markdown.slice(0, slot.insertAt)} {${tag}}${markdown.slice(slot.insertAt)}`;
}

/** A task list item's box: GFM's `checked`, and where its mark sits (the
 *  character between `[` and `]`, before the item's text). */
function checkboxOf(source: string, item: ListItem, first: Paragraph): { checked: boolean; at: number } | null {
  if (typeof item.checked !== "boolean") return null;
  const lead = source.slice(item.position!.start.offset!, first.position!.start.offset!);
  const open = lead.lastIndexOf("[");
  return open === -1 ? null : { checked: item.checked, at: item.position!.start.offset! + open + 1 };
}
