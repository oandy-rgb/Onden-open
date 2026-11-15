// `[[筆記/段落開頭]]`: a link to one paragraph, heading or named part of a note
// (docs/architecture/proposals/block-anchors-2026-11-01.md §0.5 item 4, §7).
//
//   [[筆記]]               the whole note (not this file's business)
//   [[筆記/標題或段落開頭]]    a part of that note; deeper levels: [[筆記/這節/這段]]
//   [[/文字]]               a part of the note the link is written in
//   ![[…]]                 the same, embedded
//
// What the link POINTS AT is not in its text. The editor and the app write a binding beside the note
// (link text → anchor id, `block_link_bindings`), so the paragraph is found by identity even after its
// first words change; the text after the `/` is what people read and what a hand-typed link is matched
// by. This file is the ONE reading of such a link — which note, which part, what state, what words —
// shared by the editor, the reading view, backlinks, the published site and the export preview. Each of
// them supplies a `BlockLinkEnv` (where bindings, anchors and notes come from) and draws the result;
// none re-derives it.

import { listLinkTargets, type LinkTarget } from "./linkTargets.js";
import { anchoredBlocks } from "./blocks.js";
import { normalizeText } from "./word.js";
import { hasLinkPath } from "./text.js";
import { plainExcerpt } from "./graphemes.js";
import { plainInline, stripLineMarker } from "./plainText.js";
import { BLOCK_ID_PATTERN, withoutLineTrailers } from "./blockId.js";

/** How many characters of a paragraph a link to it shows. */
export const BLOCK_LINK_EXCERPT_MAX = 20;
/** The longest text written after the `/` (a longer paragraph start is cut). */
export const BLOCK_LINK_TEXT_MAX = 40;

/** A link target split as `note` and the `segments` below it. `note` is "" for the note the link is written in. */
export type LinkPath = { note: string; segments: string[] };

/**
 * The ways `target` can be read as `note/segments`, most specific note first. A note title may itself contain `/`,
 * so the caller tries the whole `target` as a note name BEFORE using these (§0.5: "標題含 `/` 先找完全同名筆記");
 * then the longest note-name prefix that exists wins. `[[/文字]]` has the one reading: this note.
 */
export function linkPathReadings(target: string): LinkPath[] {
  const t = target.trim();
  if (!hasLinkPath(t)) return [];
  const parts = t.split("/").map((p) => p.trim());
  if (t.startsWith("/")) {
    const segments = parts.slice(1).filter(Boolean);
    return segments.length ? [{ note: "", segments }] : [];
  }
  const out: LinkPath[] = [];
  for (let n = parts.length - 1; n >= 1; n--) {
    const note = parts.slice(0, n).join("/");
    const segments = parts.slice(n).filter(Boolean);
    if (note && segments.length) out.push({ note, segments });
  }
  return out;
}

/** The text a link carries after the `/` for a part whose words are `plain`: no `/`, `|`, brackets or line breaks. */
export function blockLinkText(plain: string): string {
  const clean = plain.replace(/[\[\]|/\\\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return plainExcerpt(clean, BLOCK_LINK_TEXT_MAX).replace(/…$/, "").trim();
}

/** `[[筆記/文字]]` or, written in the note itself, `[[/文字]]`. */
export function blockLinkSource(noteTitle: string | null, text: string): string {
  return noteTitle === null ? `[[/${text}]]` : `[[${noteTitle}/${text}]]`;
}

/** The key a binding is stored and looked up under: the link target as written, in NFC, single-spaced. */
export function bindingKey(target: string): string {
  return normalizeText(target.trim()).replace(/\s+/g, " ");
}

/** The words shown for a part: "筆記 › 開頭" (just the start for the note itself). The ONE place the arrow is written. */
export function blockLinkWords(noteTitle: string | null, excerpt: string): string {
  return noteTitle ? (excerpt ? `${noteTitle} › ${excerpt}` : noteTitle) : excerpt;
}

/** A paragraph's start as the link shows it: plain words, `{…}` and `^id` cut, at most BLOCK_LINK_EXCERPT_MAX characters. */
export function blockExcerptOf(raw: string): string {
  const first = raw.split("\n").map((l) => stripLineMarker(withoutLineTrailers(l)).trim()).find((l) => l) ?? "";
  return plainExcerpt(plainInline(first).replace(/\s+/g, " ").trim(), BLOCK_LINK_EXCERPT_MAX);
}

// ── matching text against a note's parts ────────────────────────────────────────────────────────────────

const fold = (s: string) => normalizeText(s).replace(/\s+/g, " ").trim().toLowerCase();

export type PartMatch =
  | { found: "one"; target: LinkTarget }
  | { found: "many"; targets: LinkTarget[] }
  | { found: "none" };

function matching(items: readonly LinkTarget[], wanted: string, headingsOnly: boolean): LinkTarget[] {
  const w = fold(wanted);
  if (!w) return [];
  const pool = headingsOnly ? items.filter((i) => i.kind === "heading") : items;
  const text = (i: LinkTarget) => fold(i.text);
  const exact = pool.filter((i) => text(i) === w);
  return exact.length ? exact : pool.filter((i) => text(i).startsWith(w));
}

/**
 * Which part of `markdown` the `segments` name. Every segment but the last names a heading, and the next one is
 * looked for inside that heading's section; the last may be a heading's text or the start of a paragraph or list
 * item. An exact match beats a start-of-text match; more than one left is `many` (the reader chooses).
 */
export function matchParts(markdown: string, segments: readonly string[]): PartMatch {
  let scope = listLinkTargets(markdown);
  for (let i = 0; i < segments.length; i++) {
    const last = i === segments.length - 1;
    const hits = matching(scope, segments[i]!, !last);
    if (last) return hits.length === 0 ? { found: "none" } : hits.length === 1 ? { found: "one", target: hits[0]! } : { found: "many", targets: hits };
    if (hits.length !== 1) return hits.length === 0 ? { found: "none" } : { found: "many", targets: hits };
    const head = hits[0]! as Extract<LinkTarget, { kind: "heading" }>;
    const from = scope.indexOf(head);
    let to = scope.length;
    for (let j = from + 1; j < scope.length; j++) {
      const s = scope[j]!;
      if (s.kind === "heading" && s.depth <= head.depth) { to = j; break; }
    }
    scope = scope.slice(from + 1, to);
  }
  return { found: "none" };
}

// ── reading a link ──────────────────────────────────────────────────────────────────────────────────────

/** What the app knows of an anchor (a row of `block_anchors`, as the sync ships it). */
export type AnchorFacts = {
  anchorId: string;
  noteId: string;
  from: number;
  to: number;
  status: "valid" | "maybe" | "lost";
  /** Where it may be (`maybe`) or the best guess (`lost`). */
  candidate: { from: number; to: number } | null;
  /** The words it had when last confirmed. */
  quote: string;
};

/** A note as a link needs it. `markdown` is null while the body is not downloaded yet. */
export type LinkNote = { id: string; title: string; markdown: string | null };

export type BlockLinkEnv = {
  /** The note a name opens, by the app's rule (spaces, aliases); null when there is none. */
  findNote(name: string): LinkNote | null;
  /** A note by id: the note, "unreadable" (it exists but not for this reader: never named or compared), or null (gone). */
  note(id: string): LinkNote | "unreadable" | null;
  /** The anchor id bound to this link text in the note `sourceId`, if any. */
  binding(sourceId: string | null, key: string): string | null;
  anchor(anchorId: string): AnchorFacts | null;
};

/** One part of a note a link could be reading as: where it starts and ends in the note's text, and its first words. */
export type PartRef = { noteId: string; noteTitle: string; from: number; to: number; excerpt: string };

/** Where the part `t` of `markdown` ends: a paragraph or item at its last line, a heading at the end of its section. */
function partEnd(markdown: string, t: LinkTarget): number {
  if (t.kind === "block") return t.insertAt;
  const after = listLinkTargets(markdown).find((x) => x.kind === "heading" && x.start > t.start && x.depth <= t.depth);
  return after ? after.start : markdown.length;
}

export type BlockLinkRead =
  /** Not a part link: the caller reads the target as a plain note link, as before. */
  | { kind: "not-a-part" }
  /** The part, found by its binding (`anchorId`) or, for a hand-typed link, by its text (`anchorId` null). */
  | { kind: "part"; part: PartRef; anchorId: string | null; anchored: boolean }
  /** The anchor is not sure: the part is probably here (`part`); someone who may edit can confirm it. */
  | { kind: "maybe"; part: PartRef; anchorId: string }
  /** The note is there, the part is not found: the link falls back to the whole note; `guess` is a best guess to offer. */
  | { kind: "lost"; noteId: string; noteTitle: string; anchorId: string; guess: PartRef | null }
  /** The paragraph was deleted (or its note): its words, struck through. */
  | { kind: "erased"; quote: string }
  /** The text fits several parts: the reader picks. */
  | { kind: "ambiguous"; options: PartRef[] }
  /** The note exists but the reader may not read it. Says nothing else. */
  | { kind: "unavailable" }
  /** The note's text is not here yet (not downloaded): the note's name only. */
  | { kind: "pending"; noteId: string; noteTitle: string }
  /** A note was named but no part of it fits (typed by hand, or the text is gone and nothing was bound). */
  | { kind: "no-such-part"; noteId: string; noteTitle: string };

function refOf(note: LinkNote, t: LinkTarget): PartRef {
  return { noteId: note.id, noteTitle: note.title, from: t.start, to: partEnd(note.markdown ?? "", t), excerpt: plainExcerpt(t.text, BLOCK_LINK_EXCERPT_MAX) };
}

function partAt(note: LinkNote, markdown: string, from: number, to: number): PartRef {
  return { noteId: note.id, noteTitle: note.title, from, to, excerpt: blockExcerptOf(markdown.slice(from, to)) };
}

function readAnchor(env: BlockLinkEnv, anchorId: string, hand: LinkNote | null): BlockLinkRead | null {
  const a = env.anchor(anchorId);
  if (!a) {
    // Unknown here: the note is not readable (never named), or the anchor is gone with its note.
    return hand ? null : { kind: "unavailable" };
  }
  const note = env.note(a.noteId);
  if (note === "unreadable") return { kind: "unavailable" };
  if (note === null) return { kind: "erased", quote: a.quote };
  if (note.markdown === null) return { kind: "pending", noteId: note.id, noteTitle: note.title };
  const md = note.markdown;
  const inText = (from: number, to: number) => from >= 0 && to <= md.length && from < to;
  if (a.status === "valid") {
    // The text here may be ahead of the anchor (an edit not yet synced): trust the words, not the offsets, when they disagree.
    if (inText(a.from, a.to) && sameStart(md.slice(a.from, a.to), a.quote)) {
      // The anchor marks where the part starts; what stands there now (a heading with words added at its end, a paragraph
      // grown) is read from the text, so the link shows the part as it is, not as it was when the span was last measured.
      const here = listLinkTargets(md).find((t) => t.start === a.from);
      return { kind: "part", part: here ? refOf(note, here) : partAt(note, md, a.from, a.to), anchorId, anchored: true };
    }
    const moved = matchParts(md, [blockLinkText(a.quote)]);
    if (moved.found === "one") return { kind: "part", part: refOf(note, moved.target), anchorId, anchored: true };
    return { kind: "part", part: { noteId: note.id, noteTitle: note.title, from: Math.min(a.from, md.length), to: Math.min(Math.max(a.to, a.from), md.length), excerpt: blockExcerptOf(a.quote) }, anchorId, anchored: true };
  }
  const guess = a.candidate && inText(a.candidate.from, a.candidate.to) ? partAt(note, md, a.candidate.from, a.candidate.to) : null;
  if (a.status === "maybe" && guess) return { kind: "maybe", part: guess, anchorId };
  return { kind: "lost", noteId: note.id, noteTitle: note.title, anchorId, guess };
}

/** The first words of two texts agree (the anchor's quote is what the block said when last confirmed). */
function sameStart(blockText: string, quote: string): boolean {
  const a = fold(blockExcerptOf(blockText));
  const b = fold(blockExcerptOf(quote));
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Reads the target of a wiki link written in the note `sourceId` (null: not in a note, e.g. a preview of unsaved
 * text). `target` is the part before `|`. Returns `not-a-part` for everything that is not `note/part` or `/part`,
 * and for a whole-note name that exists (a title with a `/` in it).
 */
export function readBlockLink(env: BlockLinkEnv, sourceId: string | null, target: string): BlockLinkRead {
  const readings = linkPathReadings(target);
  if (readings.length === 0) return { kind: "not-a-part" };
  const whole = target.trim().startsWith("/") ? null : env.findNote(target.trim());
  if (whole) return { kind: "not-a-part" };

  // The binding first: it survives the paragraph's words changing and the note being renamed.
  const bound = env.binding(sourceId, bindingKey(target));
  if (bound) {
    const hand = readings.map((r) => (r.note === "" ? null : env.findNote(r.note))).find(Boolean) ?? null;
    const fromAnchor = readAnchor(env, bound, hand);
    if (fromAnchor) return fromAnchor;
  }

  for (const r of readings) {
    const note = r.note === "" ? (sourceId ? env.note(sourceId) : null) : env.findNote(r.note);
    if (note === "unreadable") return { kind: "unavailable" };
    if (!note) continue;
    if (note.markdown === null) return { kind: "pending", noteId: note.id, noteTitle: note.title };
    const hit = matchParts(note.markdown, r.segments);
    const ref = (t: LinkTarget) => refOf(note, t);
    if (hit.found === "one") return { kind: "part", part: ref(hit.target), anchorId: null, anchored: false };
    if (hit.found === "many") return { kind: "ambiguous", options: hit.targets.map(ref) };
    return { kind: "no-such-part", noteId: note.id, noteTitle: note.title };
  }
  return { kind: "not-a-part" };
}

/** The words a read link shows, or null when it is not a part link (the caller shows the link as it always did). */
export function blockLinkShown(read: BlockLinkRead, sourceId: string | null): string | null {
  const title = (noteId: string, noteTitle: string) => (noteId === sourceId ? null : noteTitle);
  switch (read.kind) {
    case "not-a-part": return null;
    case "part": case "maybe": return blockLinkWords(title(read.part.noteId, read.part.noteTitle), read.part.excerpt);
    case "ambiguous": return null;
    case "lost": return title(read.noteId, read.noteTitle) ?? "";
    case "pending": return title(read.noteId, read.noteTitle) ?? "";
    // Typed as `Folder/Note` for a note that does not exist yet (and no part of Folder fits): shown as typed, so a click still makes it.
    case "no-such-part": case "erased": case "unavailable": return null;
  }
}

// ── the old `[[筆記#^id]]` (read as before; new links are written as part links) ─────────────────────────

// `Note#^id`: anchored, with a bounded id, so `.*` backs off once over the target: linear.
const BLOCK_REF_BODY = new RegExp(`^(.*)#\\^(${BLOCK_ID_PATTERN})$`);

/** A link body `Note#^id` or `Note#^id|alias` (the note part empty for the same note's `[[#^id]]`) as its parts;
 *  null when it is not an `^id` block link. */
export function splitBlockLink(body: string): { target: string; blockId: string; alias: string | null } | null {
  const bar = body.indexOf("|");
  const ref = BLOCK_REF_BODY.exec(bar === -1 ? body : body.slice(0, bar));
  return ref ? { target: ref[1]!, blockId: ref[2]!, alias: bar === -1 ? null : body.slice(bar + 1) } : null;
}

/** How many characters of a paragraph an `^id` link to it shows (`blockExcerpt`). */
export const BLOCK_EXCERPT_MAX = 20;

/** The start of the paragraph or list item that `^blockId` ends in `markdown`, as plain words (formatting, `{tags}` and the
 *  id cut), at most BLOCK_EXCERPT_MAX characters with "…" when cut. "" when the id anchors something with no such text
 *  (a heading, table, quote); null when no `^blockId` anchors anything in `markdown` (the paragraph is gone).
 *  For the old `[[Note#^id]]`; a part link is read by blockLink.ts. */
export function blockExcerpt(markdown: string, blockId: string, anchors: ReadonlyArray<{ id: string; from: number; to: number }>): string | null {
  if (!anchoredBlocks(markdown, anchors).some((a) => a.id === blockId)) return null;
  const hit = listLinkTargets(markdown, anchors).find((t) => t.kind === "block" && t.ref === blockId);
  return hit && hit.kind === "block" ? plainExcerpt(hit.text, BLOCK_EXCERPT_MAX) : "";
}

