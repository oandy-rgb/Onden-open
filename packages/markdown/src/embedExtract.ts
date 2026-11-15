// What a transcluding embed shows (`![[Note#^id]]`, `![[Note#Heading]]`): the
// part of the source note's Markdown it names, as text for the normal
// renderer. Pure over the source text, so the app (lib/embeds.ts) and any
// later server step read the same part. Both are null when the note has no
// such block / heading — or is over BLOCK_PARSE_MAX, where block structure
// is not read (blocks.ts) — and the caller shows "not found".

import { anchoredBlocks, type AnchorAt } from "./blocks.js";

/** An anchor of the note read: its id and its block's start and end (block_anchors from_utf16 / to_utf16). */
type NoteAnchor = AnchorAt & { to: number };
import { headingSections } from "./headingAnchors.js";
import { frontmatterLength, stripFrontmatter } from "./frontmatter.js";
import { normalizeText } from "./word.js";

/** The block anchor `id` names, as Markdown: a paragraph, a list item with its nested items, a quote, a list or
 *  table, or a heading with its section. `anchors`: the note's anchors (a block's identity is not in its text).
 *  Null when no anchor of that id starts at a block of `markdown`. */
export function extractBlock(markdown: string, id: string, anchors: readonly NoteAnchor[]): string | null {
  const anchor = anchoredBlocks(markdown, anchors).find((a) => a.id === id);
  if (!anchor) return null;
  const { start, end } = anchor;
  // A `> ^id` last line left a bare `>` behind in old notes; one an author wrote stays theirs.
  const trimmed = markdown.slice(start, end).replace(/\s+$/, "");
  return trimmed === "" ? null : dedent(trimmed, lineIndent(markdown, start));
}

/** The section a heading names: the heading line through the line before the
 *  next heading of the same or a higher level (or the end). Named by its
 *  text, case-insensitive, or by its id (`goals-1`), as `[[Note#Heading]]`
 *  is; the first match wins. */
export function extractSection(markdown: string, heading: string): string | null {
  const wanted = normalizeText(heading).replace(/\s+/g, " ").trim();
  if (!wanted) return null;
  const { source, sections } = headingSections(markdown);
  const key = wanted.toLowerCase();
  const found = sections.find((s) => s.text.toLowerCase() === key) ?? sections.find((s) => s.id === wanted);
  return found ? source.slice(found.start, found.end).replace(/\s+$/, "") : null;
}

/** The whitespace before `at` on its line (what a nested item's lines carry). */
function lineIndent(text: string, at: number): number {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const before = text.slice(lineStart, at);
  return /^[ \t]*$/.test(before) ? before.length : 0;
}

/** Remove up to `n` leading spaces from each continuation line, so a nested
 *  list item or quote renders as a top-level one. */
export function dedent(text: string, n: number): string {
  if (n === 0) return text;
  const strip = new RegExp(`^[ \\t]{0,${n}}`);
  return text.split("\n").map((line, i) => (i === 0 ? line : line.replace(strip, ""))).join("\n");
}

/** The part of a note an embed shows, as text to edit in place and the way
 *  back: `apply(edited)` is the whole note with that part replaced. `text` is
 *  what the embed shows (extractBlock / extractSection / the body), so the
 *  editor opens on exactly the embed's content. */
export type EmbedEditable = { text: string; apply(edited: string): string };

/** Edit what `![[Note#^id]]` (`target.blockId`), `![[Note#Heading]]`
 *  (`target.heading`) or `![[Note]]` shows. Null when the note has no such
 *  part. An edit that empties the part writes nothing back (a block without
 *  text cannot carry its `^id`).
 *
 *  A block keeps its `^id`: on the first line of a multi-line block (a list
 *  item with children, a heading) or at the end of its first paragraph,
 *  so an edit that splits the block leaves the id on the first piece. An id on
 *  its own line below a list / table / quote stays where it is. */
export function embedEditable(
  markdown: string, target: { blockId?: string | null; heading?: string | null }, anchors: readonly NoteAnchor[] = [],
): EmbedEditable | null {
  if (target.blockId) return blockEditable(markdown, target.blockId, anchors);
  if (target.heading) return sectionEditable(markdown, target.heading);
  return noteEditable(markdown);
}

function blockEditable(markdown: string, id: string, anchors: readonly NoteAnchor[]): EmbedEditable | null {
  const text = extractBlock(markdown, id, anchors);
  const anchor = anchoredBlocks(markdown, anchors).find((a) => a.id === id);
  if (text === null || !anchor) return null;
  const { start, end } = anchor;
  const indent = lineIndent(markdown, start);
  return {
    text,
    apply(edited) {
      const body = edited.replace(/\s+$/, "");
      if (body === "") return markdown;
      const lines = body.split("\n").map((line, i) => (i > 0 && line !== "" ? " ".repeat(indent) + line : line));
      // The block's anchor starts where the block does, and its first characters are where the edit begins: it stays.
      return markdown.slice(0, start) + lines.join("\n") + markdown.slice(end);
    },
  };
}

function sectionEditable(markdown: string, heading: string): EmbedEditable | null {
  const text = extractSection(markdown, heading);
  if (text === null) return null;
  const { source } = headingSections(markdown);
  const shift = markdown.length - source.length;
  const at = source.indexOf(text);
  if (at < 0) return null;
  return replacing(markdown, text, shift + at);
}

function noteEditable(markdown: string): EmbedEditable {
  const front = frontmatterLength(markdown);
  const body = stripFrontmatter(markdown);
  const text = body.trim();
  return replacing(markdown, text, front + (text ? body.indexOf(text) : body.length));
}

/** `text` sits at `from` in `markdown`: an edit replaces just that span. */
function replacing(markdown: string, text: string, from: number): EmbedEditable {
  return {
    text,
    apply(edited) {
      const body = edited.replace(/\s+$/, "");
      if (body === "" && text !== "") return markdown;
      return markdown.slice(0, from) + body + markdown.slice(from + text.length);
    },
  };
}
