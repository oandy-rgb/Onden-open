// A block and its child note, both directions (docs/architecture/block-nodes.md
// 「搬成子筆記／展開回內文」). Pure over the text, so the server (the operation
// that writes it all in one event) and the app (what the menu offers) read
// the same rules.
//
//   planBlockMove    a paragraph, list item or heading (with its section) →
//                    the child note's body, a title for it, and the note with
//                    the block replaced by `![[child]]`;
//   planBlockExpand  the way back: a child note's one block put where the
//                    `![[child]]` line stands (its anchor goes with it: the caller rehomes it);
//   rewriteLinks     the references that follow: every `[[…]]` / `![[…]]` a
//                    caller's rule changes, code left alone;
//   retargetToChild / retargetToParent  that rule for the two directions.
//
// A link names a note by title, slug, alias or `onden://node/<id>`
// (noteNamer); the same rule the server's wikilink edges use.

import { anchoredBlocks, blockTagSlot, addBlockTag, parseBlocks, blocksParsable, type AnchorAt, type Span } from "./blocks.js";
import { embedMatches, parseEmbed } from "./embeds.js";
import { drawnWikilinks } from "./wikilinkSpans.js";
import { frontmatterLength } from "./frontmatter.js";
import { headingAnchors, headingSections } from "./headingAnchors.js";
import { parserFor } from "./parsers.js";
import { isTagList, linkNameKey } from "./text.js";
import { plainInline, stripLineMarker } from "./plainText.js";
import { linkSlug } from "./slug.js";
import { NODE_REF_PREFIX } from "./nodeRef.js";
import { normalizeText } from "./word.js";
import { cutToGraphemes } from "./graphemes.js";
import { dedent } from "./embedExtract.js";
import type { Root, RootContent } from "mdast";

/** The most characters of a block a child's title takes. */
const TITLE_MAX = 50;

export type MovableKind = "paragraph" | "listItem" | "heading";

export type BlockMoveRefusal = "block_not_found" | "block_unsupported" | "note_too_long" | "selection_empty";

/** An anchor of the note being read: its id and its block's start and end (block_anchors from_utf16 / to_utf16). */
export type NoteAnchor = AnchorAt & { to: number };

export type BlockMove = {
  /** The block's own anchor id; null for a selection (planSelectionMove), whose
   *  anchors all travel as `innerRefs`. */
  ref: string | null;
  kind: MovableKind | "selection";
  /** A title for the child: the heading's text or the block's first words,
   *  safe inside `[[…]]`. "" when the block has no words (a picture). */
  title: string;
  /** Names written in the block's `{…}` (not `#tag ^id` blocks: their
   *  hashtags stay in the text and are the child's as they were the block's). */
  tags: string[];
  /** The child note's Markdown: the block's text without its `{…}`. */
  body: string;
  /** Anchors of other blocks inside the block; they travel with its text. */
  innerRefs: string[];
  /** Where the moved text stood in the note (offsets, `from` inclusive): the blocks of the note that overlap it are the child's blocks, in order. */
  span: Span;
  /** What `[[Note#Heading]]` calls this heading (lowercase text when it is the
   *  first with that text, and its id such as `goals-1`); empty for other kinds. */
  headingNames: string[];
  /** The note with the block replaced by `![[target]]`, blank lines around. */
  without(embedTarget: string): string;
};

/** What moving the block of anchor `ref` of `markdown` takes and leaves; or why it can't:
 *  the block is not there, is a quote / table / code, sits inside a quote, or
 *  the note is too long to read blocks in (BLOCK_PARSE_MAX). `anchors`: the note's valid anchors. */
export function planBlockMove(markdown: string, ref: string, anchors: readonly NoteAnchor[]): BlockMove | { refused: BlockMoveRefusal } {
  if (!blocksParsable(markdown)) return { refused: "note_too_long" };
  const blocks = anchoredBlocks(markdown, anchors);
  const anchor = blocks.find((a) => a.id === ref);
  if (!anchor) return { refused: "block_not_found" };
  if (anchor.kind !== "paragraph" && anchor.kind !== "listItem" && anchor.kind !== "heading") return { refused: "block_unsupported" };
  const start = anchor.start;
  const end = start + markdown.slice(start, anchor.end).replace(/\s+$/, "").length;
  const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
  const prefix = markdown.slice(lineStart, start);
  // Inside a quote every line starts with `> `: not text a note could hold.
  if (!/^[ \t]*$/.test(prefix)) return { refused: "block_unsupported" };

  const block = parseBlocks(markdown, anchors).find((b) => b.ref === ref && b.start === start);
  const cuts: Span[] = [];
  if (block?.tagSource === "braces" && block.marks.tags) cuts.push(block.marks.tags);
  const body = dedent(cutSpans(markdown, start, end, cuts), prefix.length).replace(/\s+$/, "");

  const innerRefs = blocks.filter((a) => a.id !== ref && a.start > start && a.start < end).map((a) => a.id);

  const headingNames = anchor.kind === "heading" ? headingNamesAt(markdown, start) : [];

  return {
    ref, kind: anchor.kind, title: titleOf(body), body, innerRefs, headingNames, span: { from: start, to: end },
    tags: block?.tagSource === "braces" ? block.tags : [],
    without(embedTarget) {
      let before = markdown.slice(0, lineStart);
      let after = markdown.slice(end);
      if (before.trim() !== "" && !/\n[ \t]*\n$/.test(before)) before += "\n";
      if (after.trim() !== "" && !/^[ \t]*\n[ \t]*\n/.test(after)) after = `\n${after}`;
      return `${before}${prefix}![[${embedTarget}]]${after}`;
    },
  };
}

// ── A selection ─────────────────────────────────────────────────────────────

/** A top-level piece of a note that a selection takes whole, unless it is a
 *  paragraph cut in the middle: a paragraph, a heading (the line only, not its
 *  section), an item of a top-level list (with its nested items), or any other
 *  block (quote, code, table…). Offsets are into the whole note. */
type Unit = { type: string; start: number; end: number };

function topUnits(markdown: string): Unit[] {
  const offset = frontmatterLength(markdown);
  const tree = parserFor("blocks").parse(markdown.slice(offset)) as Root;
  const at = (node: RootContent): Unit => ({ type: node.type, start: node.position!.start.offset! + offset, end: node.position!.end.offset! + offset });
  return tree.children.flatMap((node) => (node.type === "list" ? node.children.map(at) : [at(node)]));
}

/** What moving the text `[from, to)` of `markdown` takes and leaves — the plan
 *  of 「變成子筆記」 over a selection, in the shape of planBlockMove's.
 *
 *  What is selected is what moves, as written (`{tags}` inside it included;
 *  every anchor inside travels with it, so links to it follow). Blocks the selection touches move whole, except that a
 *  paragraph cut in the middle is split: the words before and after the
 *  selection stay as paragraphs of their own, around the `![[child]]` line.
 *  A cut that leaves only a paragraph's `{tags}` behind takes them too.
 *  Refused: nothing selected, or selected where there is no block (front
 *  matter, blank space); a note too long to read blocks in. */
export function planSelectionMove(markdown: string, from: number, to: number, anchors: readonly NoteAnchor[] = []): BlockMove | { refused: BlockMoveRefusal } {
  if (!blocksParsable(markdown)) return { refused: "note_too_long" };
  while (from < to && /\s/.test(markdown[from]!)) from++;
  while (to > from && /\s/.test(markdown[to - 1]!)) to--;
  if (from >= to) return { refused: "selection_empty" };
  const touched = topUnits(markdown).filter((u) => u.end > from && u.start < to);
  const first = touched[0], last = touched[touched.length - 1];
  if (!first || !last) return { refused: "block_not_found" };

  const start = first.type === "paragraph" && from > first.start ? from : first.start;
  let end = last.type === "paragraph" && to < last.end ? to : last.end;
  const rest = /^\s*(?:\{([^{}\n]*)\}\s*)?$/.exec(markdown.slice(end, last.end));
  if (end < last.end && rest && (rest[1] === undefined || isTagList(rest[1]))) end = last.end;

  const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
  const midLine = !/^[ \t]*$/.test(markdown.slice(lineStart, start));
  const prefix = midLine ? "" : markdown.slice(lineStart, start);
  const body = dedent(markdown.slice(start, end), prefix.length).replace(/\s+$/, "");
  const innerRefs = anchoredBlocks(markdown, anchors).filter((a) => a.start >= start && a.start < end).map((a) => a.id);
  const headingNames = touched.filter((u) => u.type === "heading" && u.start >= start && u.end <= end).flatMap((u) => headingNamesAt(markdown, u.start));

  return {
    ref: null, kind: "selection", title: titleOf(body), tags: [], body, innerRefs, headingNames, span: { from: start, to: end },
    without(embedTarget) {
      const before = midLine ? markdown.slice(0, start).replace(/[ \t]+$/, "") : markdown.slice(0, lineStart);
      const after = end < last.end ? markdown.slice(end).replace(/^[ \t]+/, "") : markdown.slice(end);
      const gapBefore = before.trim() === "" || /\n[ \t]*\n$/.test(before) ? "" : before.endsWith("\n") ? "\n" : "\n\n";
      const gapAfter = after.trim() === "" || /^[ \t]*\n[ \t]*\n/.test(after) ? "" : /^[ \t]*\n/.test(after) ? "\n" : "\n\n";
      return `${before}${gapBefore}${prefix}![[${embedTarget}]]${gapAfter}${after}`;
    },
  };
}

/** What `[[Note#Heading]]` calls the heading starting at `start` (lowercase
 *  text when it is the first with that text, and its id such as `goals-1`). */
function headingNamesAt(markdown: string, start: number): string[] {
  const names: string[] = [];
  const { source, sections } = headingSections(markdown);
  const shift = markdown.length - source.length;
  const section = sections.find((s) => s.start + shift === start);
  if (section) {
    if (sections.find((s) => s.text.toLowerCase() === section.text.toLowerCase()) === section) names.push(section.text.toLowerCase());
    names.push(section.id);
  }
  return names;
}

/** `text[start, end)` without the spans in `cuts`, and without the blanks
 *  before each (` ^id`, ` {a}`). */
function cutSpans(text: string, start: number, end: number, cuts: Span[]): string {
  let out = "", at = start;
  for (const cut of [...cuts].sort((a, b) => a.from - b.from)) {
    let from = cut.from;
    while (from > at && (text[from - 1] === " " || text[from - 1] === "\t")) from--;
    out += text.slice(at, from);
    at = cut.to;
  }
  return out + text.slice(at, end);
}

/** The words a title is made of: the first line of `body` read without its
 *  Markdown (heading `#`, list marker and box, emphasis, link syntax) and
 *  without the characters `[[title]]` cannot hold, cut to TITLE_MAX. */
function titleOf(body: string): string {
  let line = (body.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  // A selection keeps the `{tags}` it was cut with: not words of the title.
  line = line.replace(/\s+\{([^{}\n]*)\}$/, (whole, inner: string) => (isTagList(inner) ? "" : whole));
  line = plainInline(stripLineMarker(line).replace(/\s+#+$/, ""))
    .replace(/[[\]|#^\\=]/g, " ")
    .replace(/\s+/g, " ").trim();
  const text = normalizeText(line);
  const cut = cutToGraphemes(text, TITLE_MAX);
  return cut === text ? text : `${cut.trimEnd()}…`;
}

// ── The way back ────────────────────────────────────────────────────────────

export type BlockExpandRefusal =
  | "child_has_frontmatter" | "child_empty" | "child_not_one_block" | "note_too_long";

/** A line that is only an embed of a whole note (`![[child]]`, no `#` part),
 *  for `isChild` to say which names the child. Code is left out. */
export type EmbedLine = { start: number; end: number; lineStart: number; indent: string };

export function wholeNoteEmbedLines(markdown: string, isChild: (target: string) => boolean): EmbedLine[] {
  const code = codeRanges(markdown);
  const lines: EmbedLine[] = [];
  for (const m of embedMatches(markdown)) {
    if (m.blockId || m.heading || !isChild(m.target) || inRanges(code, m.start)) continue;
    const lineStart = markdown.lastIndexOf("\n", m.start - 1) + 1;
    const lineEnd = markdown.indexOf("\n", m.end) === -1 ? markdown.length : markdown.indexOf("\n", m.end);
    const before = markdown.slice(lineStart, m.start), after = markdown.slice(m.end, lineEnd);
    if (/^[ \t]*$/.test(before) && /^[ \t]*$/.test(after)) lines.push({ start: m.start, end: m.end, lineStart, indent: before });
  }
  return lines;
}

/** The note with the embed line replaced by the child's one block and, in `{…}`, the tags the child carried. The
 *  block's anchor is not in the text: the caller moves it to `blockStart` (`blockEnd` is where the block ends). The
 *  child must be exactly one block — a paragraph, a one-item list, or a heading with everything under it — and have
 *  no front matter, or nothing is written for it to turn back into. */
export function planBlockExpand(
  markdown: string, embed: EmbedLine, child: string, opts: { tags: readonly string[] },
): { markdown: string; blockStart: number; blockEnd: number } | { refused: BlockExpandRefusal } {
  if (!blocksParsable(markdown) || !blocksParsable(child)) return { refused: "note_too_long" };
  if (frontmatterLength(child) > 0) return { refused: "child_has_frontmatter" };
  let body = child.replace(/\s+$/, "").replace(/^\s*\n/, "");
  if (body.trim() === "") return { refused: "child_empty" };
  if (!oneBlock(body)) return { refused: "child_not_one_block" };

  for (const tag of opts.tags) body = addBlockTag(body, 0, tag) ?? body;
  const indented = body.split("\n").map((line, i) => (i > 0 && line !== "" ? embed.indent + line : line)).join("\n");
  return {
    markdown: markdown.slice(0, embed.start) + indented + markdown.slice(embed.end),
    blockStart: embed.start, blockEnd: embed.start + indented.length,
  };
}

/** Whether `body` is a single paragraph, a one-item list or a heading with
 *  only deeper headings and other content below. */
function oneBlock(body: string): boolean {
  const slot = blockTagSlot(body, 0);
  if (!slot || slot.kind === "quote") return false;
  const kids = (parserFor("blocks").parse(body) as Root).children as RootContent[];
  const first = kids[0];
  if (!first) return false;
  if (first.type === "paragraph") return kids.length === 1;
  if (first.type === "list") return kids.length === 1 && first.children.length === 1 && first.children[0]!.children[0]?.type === "paragraph";
  if (first.type === "heading") return kids.every((k, i) => i === 0 || k.type !== "heading" || k.depth > first.depth);
  return false;
}

// ── References ──────────────────────────────────────────────────────────────

/** What a link points into, as written after `#`. */
export type LinkAnchor = { kind: "block"; id: string } | { kind: "heading"; text: string } | null;
export type LinkRead = { embed: boolean; target: string; anchor: LinkAnchor };

/** The links and embeds of `markdown` that are text (not in code or math), last first: where each starts and ends
 *  (an embed's `start` is its `!`) and what is between `[[` and `]]`. */
export function wikilinkSpans(markdown: string): Array<{ start: number; end: number; body: string; embed: boolean }> {
  if (!markdown.includes("[[")) return [];
  const code = codeRanges(markdown);
  return [
    ...drawnWikilinks(markdown).map((m) => ({ start: m.start, end: m.end, body: m.body, embed: false })),
    ...embedMatches(markdown).filter((m) => !inRanges(code, m.start)).map((m) => ({ start: m.start, end: m.end, body: m.body, embed: true })),
  ].sort((a, b) => b.start - a.start);
}

/** `change(link)` is where it should point instead — a note name and an
 *  anchor — or null to leave it. The `|alias` / `|label` is kept. Links and
 *  embeds in code and math are text and stay. Returns the new text and how
 *  many links changed. */
export function rewriteLinks(
  markdown: string, change: (link: LinkRead) => { target: string; anchor: LinkAnchor } | null,
): { markdown: string; count: number } {
  const found = wikilinkSpans(markdown);
  let out = markdown, count = 0;
  for (const link of found) {
    const ref = parseEmbed(link.body);
    const anchor: LinkAnchor = ref.blockId ? { kind: "block", id: ref.blockId } : ref.heading ? { kind: "heading", text: ref.heading } : null;
    const next = change({ embed: link.embed, target: ref.target, anchor });
    if (!next) continue;
    const bar = link.body.indexOf("|");
    const body = next.target + anchorText(next.anchor) + (bar === -1 ? "" : link.body.slice(bar));
    if (body === link.body) continue;
    out = out.slice(0, link.start) + (link.embed ? "![[" : "[[") + body + "]]" + out.slice(link.end);
    count++;
  }
  return { markdown: out, count };
}

function anchorText(anchor: LinkAnchor): string {
  return !anchor ? "" : anchor.kind === "block" ? `#^${anchor.id}` : `#${anchor.text}`;
}

/** Whether a link target names a note: its title, slug, an alias or its id. */
export type NoteNames = { id: string; title: string; slug: string; aliases?: readonly string[] };
export function noteNamer(note: NoteNames): (target: string) => boolean {
  const names = new Set([note.title, ...(note.aliases ?? [])].map(linkNameKey));
  return (target) => {
    const key = linkNameKey(target);
    return key !== "" && (names.has(key) || linkSlug(target) === note.slug || key === `${NODE_REF_PREFIX}${note.id}`.toLowerCase());
  };
}

/** The links of a note — the moved block's source or any other — after the
 *  block moved into the child `childTarget`: `[[Source#^id]]` (and the
 *  embed) becomes `[[child]]`, so does a link to the heading by its text;
 *  `[[Source#^inner]]` for an id that travelled becomes `[[child#^inner]]`.
 *  `isSource`: which targets name the source note; `sourceIsHere`: this text
 *  is the source note (`[[#^id]]` means it there). */
export function retargetToChild(
  markdown: string,
  o: { move: Pick<BlockMove, "ref" | "innerRefs" | "headingNames">; childTarget: string; isSource: (target: string) => boolean; sourceIsHere: boolean },
): { markdown: string; count: number } {
  const inner = new Set(o.move.innerRefs);
  return rewriteLinks(markdown, ({ target, anchor }) => {
    if (!anchor || !(target === "" ? o.sourceIsHere : o.isSource(target))) return null;
    if (anchor.kind === "block") {
      if (anchor.id === o.move.ref) return { target: o.childTarget, anchor: null };
      return inner.has(anchor.id) ? { target: o.childTarget, anchor } : null;
    }
    const key = normalizeText(anchor.text).replace(/\s+/g, " ").trim();
    return o.move.headingNames.includes(key.toLowerCase()) || o.move.headingNames.includes(key)
      ? { target: o.childTarget, anchor: null } : null;
  });
}

/** The child's text on its way into the source note: a link written there to
 *  a place in the source note without naming it (`[[#^other]]`) must now name
 *  it, or it would look inside the child. Those inside the moved text
 *  (`inner` ids, headings in the body) stay local. */
export function qualifyLocalLinks(
  body: string, o: { sourceTarget: string; local: { ref: string | null; innerRefs: readonly string[] } },
): { markdown: string; count: number } {
  const here = new Set([...(o.local.ref ? [o.local.ref] : []), ...o.local.innerRefs]);
  const headings = new Set(headingAnchors(body).map((h) => h.text.toLowerCase()));
  return rewriteLinks(body, ({ target, anchor }) => {
    if (target !== "" || !anchor) return null;
    if (anchor.kind === "block" ? here.has(anchor.id) : headings.has(anchor.text.toLowerCase())) return null;
    return { target: o.sourceTarget, anchor };
  });
}

/** The links after the child note is put back as `^ref` of the source note
 *  `sourceTarget`: `[[child]]` becomes `[[Source#^ref]]`, `[[child#anchor]]`
 *  keeps its anchor under the source note. */
export function retargetToParent(
  markdown: string,
  o: { ref: string; sourceTarget: string; isChild: (target: string) => boolean },
): { markdown: string; count: number } {
  return rewriteLinks(markdown, ({ target, anchor }) =>
    target !== "" && o.isChild(target) ? { target: o.sourceTarget, anchor: anchor ?? { kind: "block", id: o.ref } } : null);
}

// ── Code ────────────────────────────────────────────────────────────────────

/** Source spans where text is code or math: a `[[link]]` there is not one. */
function codeRanges(markdown: string): Array<[number, number]> {
  if (!markdown.includes("[[")) return [];
  const offset = frontmatterLength(markdown);
  const ranges: Array<[number, number]> = [];
  const stack: RootContent[] = [...(parserFor("anchors").parse(markdown.slice(offset)) as Root).children];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "code" || node.type === "inlineCode" || node.type === "math" || node.type === "inlineMath") {
      ranges.push([node.position!.start.offset! + offset, node.position!.end.offset! + offset]);
    } else if ("children" in node) {
      stack.push(...(node.children as RootContent[]));
    }
  }
  return ranges;
}

function inRanges(ranges: ReadonlyArray<[number, number]>, at: number): boolean {
  return ranges.some(([from, to]) => at >= from && at < to);
}
