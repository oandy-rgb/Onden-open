// Reading the old `^id` marks once, to move them out of the text (docs/architecture/proposals/block-anchors-2026-11-01.md
// §11). A block's identity is its row in block_anchors; the body carries no `^id`. This is the ONLY reader of `^id`
// text left on purpose: the migration job, the Markdown importers and the restore of a pre-cutover backup call it, and
// nothing that runs on a normal save does.
//
// Pure: it returns the body without the marks and where each id's block starts in THAT body. The caller (the system job,
// services/blockIdMigration.ts) writes both in one transaction. When the result cannot be shown to read as the same
// document with the same blocks, it returns null and the note is left as it is — never a guess.

import { anchoredBlocks, legacyBlockAnchors, blocksParsable, legacyOrphanIds, parseBlocks, parseLegacyBlocks, type BlockKind, type Span } from "./blocks.js";

export type LegacyAnchor = {
  id: string;
  kind: BlockKind | "list" | "table";
  /** Where the block starts and ends in the body WITHOUT the marks. */
  from: number;
  to: number;
  /** The id was already used by an earlier block of this note: the caller gives this one a new id. */
  repeat: boolean;
};

export type LegacyIdConversion = { markdown: string; anchors: LegacyAnchor[] };

export type LegacyIdRefusal = "too_long" | "not_the_same_blocks";

const BLANK_LINE = /^[>\s]*$/;

/** The text to cut for one mark: ` ^id` at a line's end, or the whole line (and the blank lines above it) when
 *  the line holds nothing else. */
function cutFor(markdown: string, mark: Span): Span {
  const lineStart = markdown.lastIndexOf("\n", mark.from - 1) + 1;
  const nl = markdown.indexOf("\n", mark.to);
  const lineEnd = nl === -1 ? markdown.length : nl;
  const before = markdown.slice(lineStart, mark.from);
  const after = markdown.slice(mark.to, lineEnd);
  if (BLANK_LINE.test(before) && after.trim() === "") {
    // Alone on its line: take it with the separation above it (`text\n\n^id` → `text`).
    let from = lineStart;
    while (from > 0) {
      const prevEnd = from - 1;
      const prevStart = markdown.lastIndexOf("\n", prevEnd - 1) + 1;
      from = prevStart;
      if (!BLANK_LINE.test(markdown.slice(prevStart, prevEnd))) { from = prevEnd; break; }
      if (prevStart === 0) { return { from: 0, to: Math.min(markdown.length, lineEnd + 1) }; }
    }
    return { from, to: lineEnd };
  }
  let from = mark.from;
  while (from > lineStart && (markdown[from - 1] === " " || markdown[from - 1] === "\t")) from--;
  return { from, to: mark.to };
}

/** The pieces of `markdown` that go when its marks do, in order and not touching. */
function cutsOf(markdown: string, marks: readonly Span[]): Span[] {
  const cuts = marks.map((m) => cutFor(markdown, m)).sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: Span[] = [];
  for (const cut of cuts) {
    const last = merged[merged.length - 1];
    if (last && cut.from <= last.to) last.to = Math.max(last.to, cut.to); else merged.push({ ...cut });
  }
  return merged;
}

/** Where a place in the body WITH the marks is in the body without them. */
const shiftBy = (merged: readonly Span[]) => (offset: number): number => {
  let removed = 0;
  for (const cut of merged) {
    if (cut.from >= offset) break;
    removed += Math.min(cut.to, offset) - cut.from;
  }
  return offset - removed;
};

/** For a body stripLegacyIds converts: where a place in it is in the converted body. A caller that holds
 *  places in the text with the marks (a backup's anchor list) moves them with this.
 *
 *  const at = legacyIdShift(body); anchors.map((a) => ({ ...a, from: at(a.from), to: at(a.to) })) */
export function legacyIdShift(markdown: string): (offset: number) => number {
  return shiftBy(cutsOf(markdown, [...legacyBlockAnchors(markdown).map((a) => a.mark), ...legacyOrphanIds(markdown)]));
}

/** `markdown` without its `^id` marks, and an anchor for each id (at the start of the block that carried it).
 *  Null with the reason when the result would not read as the same blocks. */
export function stripLegacyIds(markdown: string): LegacyIdConversion | { refused: LegacyIdRefusal } {
  if (!blocksParsable(markdown)) return { refused: "too_long" };
  const found = legacyBlockAnchors(markdown);
  const orphans = legacyOrphanIds(markdown);
  if (found.length === 0 && orphans.length === 0) return { markdown, anchors: [] };

  const merged = cutsOf(markdown, [...found.map((a) => a.mark), ...orphans]);
  let out = "";
  let at = 0;
  for (const cut of merged) { out += markdown.slice(at, cut.from); at = cut.to; }
  out += markdown.slice(at);
  const shift = shiftBy(merged);

  // The same blocks, in the same places, with nothing left that still reads as an id.
  const sameBlocks = (a: ReturnType<typeof parseBlocks>, b: ReturnType<typeof parseBlocks>) =>
    a.length === b.length && a.every((x, i) => {
      const y = b[i]!;
      return x.kind === y.kind && x.label === y.label && x.tags.join("\u0000") === y.tags.join("\u0000") && shift(x.start) === y.start;
    });
  if (!sameBlocks(parseLegacyBlocks(markdown), parseBlocks(out)) || legacyBlockAnchors(out).length > 0 || legacyOrphanIds(out).length > 0) {
    return { refused: "not_the_same_blocks" };
  }

  const seen = new Set<string>();
  const anchors = found.map((a): LegacyAnchor => {
    const repeat = seen.has(a.id);
    seen.add(a.id);
    return { id: a.id, kind: a.kind, from: shift(a.start), to: shift(a.end), repeat };
  });
  return { markdown: out, anchors };
}

/** Whether `markdown` still carries an `^id` mark (what the migration job looks for, and the importers). */
export function hasLegacyIds(markdown: string): boolean {
  return blocksParsable(markdown) && (legacyBlockAnchors(markdown).length > 0 || legacyOrphanIds(markdown).length > 0);
}

// ── The other way: writing the old marks back ───────────────────────────────

export type WrittenLegacyIds = { markdown: string; written: string[]; skipped: string[] };

/** `markdown` with an `^id` mark written for each anchor, where the old format put it: at the end of the (last, for a
 *  paragraph; first, for a list item or heading) line, or alone on a line after a quote, list or table. For the way
 *  back (the reverse job, an Obsidian export) — the text then reads as the old app read it. An anchor that no block
 *  starts at, or whose mark would not read back as that block's id, is `skipped` and left out: never a guess. */
export function writeLegacyIds(markdown: string, anchors: ReadonlyArray<{ id: string; from: number; to: number }>): WrittenLegacyIds {
  const blocks = anchoredBlocks(markdown, anchors);
  const placed = new Set(blocks.map((b) => b.id));
  const skipped = anchors.filter((a) => !placed.has(a.id)).map((a) => a.id);
  type Edit = { at: number; text: string; id: string; start: number };
  const edits: Edit[] = [];
  for (const b of blocks) {
    const lineEnd = (from: number) => { const nl = markdown.indexOf("\n", from); return nl === -1 ? markdown.length : nl; };
    if (b.kind === "paragraph") {
      let at = b.end;
      while (at > b.start && /\s/.test(markdown[at - 1]!)) at--;
      edits.push({ at, text: ` ^${b.id}`, id: b.id, start: b.start });
    } else if (b.kind === "listItem" || b.kind === "heading") {
      let at = lineEnd(b.start);
      while (at > b.start && /[ \t]/.test(markdown[at - 1]!)) at--;
      edits.push({ at, text: ` ^${b.id}`, id: b.id, start: b.start });
    } else {
      let at = b.end;
      while (at > b.start && /\s/.test(markdown[at - 1]!)) at--;
      const lineStart = markdown.lastIndexOf("\n", b.start - 1) + 1;
      const indent = markdown.slice(lineStart, b.start).replace(/[^\s>]/g, " ");
      edits.push({ at, text: `\n${indent.trimEnd()}\n${indent}^${b.id}`, id: b.id, start: b.start });
    }
  }
  let out = markdown;
  for (const e of [...edits].sort((x, y) => y.at - x.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  // Each id must now read as the id of the block it was written for.
  const shift = (offset: number) => offset + edits.filter((e) => e.at <= offset && e.at < offset).reduce((n, e) => n + e.text.length, 0);
  const readBack = new Map(legacyBlockAnchors(out).map((a) => [a.id, a.start]));
  const written: string[] = [];
  for (const e of edits) {
    if (readBack.get(e.id) === shift(e.start)) written.push(e.id); else skipped.push(e.id);
  }
  if (skipped.length === 0 || written.length === edits.length) return { markdown: out, written, skipped };
  // Some mark did not read back: leave the note as it was rather than keep a half-written set.
  return { markdown, written: [], skipped: anchors.map((a) => a.id) };
}
