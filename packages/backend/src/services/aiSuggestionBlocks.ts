// A note body as paragraphs, the unit of an AI suggestion
// (docs/agents/decisions-ai-collaboration.md).
//
//   proposeItems(base, proposed)   the paragraph-level changes that turn base
//                                  into proposed (replace / insert / delete)
//   applyItems(base, items)        base with just those changes made
//
// Paragraphs and their pairing are @onden/markdown's (splitParagraphs,
// alignParagraphs: the same cut History uses, so "a place" means the same in
// the editor). A place is named by its source text and which identical
// paragraph it is (findParagraph), never a character offset, so it can be
// found again in the note after other edits. Applying the chosen items to the
// base, then three-way merging that against the note as it is now
// (updateNode, onConflict "refuse"), is what keeps a person's later edits.
//
// Separators. A paragraph is cut from its text, but the blank space after it is
// part of the note too: a tight list (`- a\n- b`) and a loose one (`- a\n\n- b`)
// are different documents. An item's newText therefore carries the separator
// that followed the paragraph in the proposal (`text + after`; encodeUnit /
// decodeUnit), so accepting every item gives the proposal back verbatim and a
// partly accepted note takes each block's separator from the version the block
// came from, never one block's separator for another. The last paragraph of a
// text has no following separator: it is stored bare, and an item stored bare
// (rows made before separators were kept) falls back to the separator of the
// base paragraph it goes after. The note's own blank lines at its very start
// and end are not proposed or changed.
//
// What counts as a change: a differing paragraph (its words, indentation, a hard
// line break), or the same paragraph whose separator changes between "directly
// follows" and "a blank line between" (tight ↔ loose, after a heading: written
// even where it shows nothing, so accepting everything gives the proposal back).
// One blank line versus two, a single trailing space on a line and the note's own
// blank lines at its start and end are not a place.

import { CodedStatusError } from "../statusError.js";
import {
  alignParagraphs, findParagraph, paragraphOccurrence, splitParagraphs, type Alignment, type Paragraph,
} from "@onden/markdown";

export type ItemDraft =
  | { kind: "replace"; baseText: string; baseOccurrence: number; newText: string }
  | { kind: "delete"; baseText: string; baseOccurrence: number }
  /** Goes after the paragraph baseText ("" = at the start of the note). */
  | { kind: "insert"; baseText: string; baseOccurrence: number; newText: string };

/** What applyItems needs of a stored item. */
export type ItemChange = ItemDraft;

/** A proposal with more places than this is a rewrite, not something to
 *  review one place at a time. */
export const MAX_ITEMS = 200;
/** Beyond this many paragraphs a note is not cut into places at all. */
export const MAX_PARAGRAPHS = 4_000;

/** A change too large to cut into places: refused as 400 `suggestion_too_large`. */
export class SuggestionTooLargeError extends CodedStatusError {
  constructor(message = "the proposed change is too large to review place by place") {
    super(400, "suggestion_too_large", message);
    this.name = "SuggestionTooLargeError";
  }
}

/** Marks a separator the proposal wrote as a lazy line: a text line right under a list item or quote
 *  with no blank line, which then belongs to it. Kept in the stored text only, never shown. */
const LAZY = "\u2063";
/** Marks the new place of a paragraph that moved (its old place is a delete): only then is its `^id` given up
 *  when the old place is still in the note. */
const MOVED = "\u2064";

/** Text of a paragraph as the item stores it: the paragraph and the separator after it, and, for the first
 *  paragraph added after the note's last one, the separator before it (that last paragraph has no
 *  separator of its own to compare). */
export const encodeUnit = (text: string, after: string, lead = "", lazy: { lead?: boolean; after?: boolean; moved?: boolean } = {}): string =>
  (lazy.moved ? MOVED : "") + (lazy.lead ? LAZY : "") + lead + text + (lazy.after ? LAZY : "") + after;

const SEPARATOR_AT_END = /\r?\n(?:[^\S\n]*\n)*$/;
const SEPARATOR_AT_START = /^\r?\n(?:[^\S\n]*\n)*/;

/** The paragraph and separators in an item's newText ("" separator: none stored). A paragraph starts on
 *  a non-blank line, so blank lines at the start can only be a stored separator. */
export function decodeUnit(stored: string): { lead: string; leadLazy: boolean; moved: boolean; text: string; after: string; afterLazy: boolean } {
  const moved = stored.startsWith(MOVED);
  const unmoved = moved ? stored.slice(1) : stored;
  const leadLazy = unmoved.startsWith(LAZY);
  const body = leadLazy ? unmoved.slice(1) : unmoved;
  const lead = SEPARATOR_AT_START.exec(body)?.[0] ?? "";
  const rest = body.slice(lead.length);
  const at = SEPARATOR_AT_END.exec(rest)?.index;
  const text = at === undefined ? rest : rest.slice(0, at);
  const afterLazy = at !== undefined && text.endsWith(LAZY);
  return { lead, leadLazy, moved, text: afterLazy ? text.slice(0, -1) : text, after: at === undefined ? "" : rest.slice(at), afterLazy };
}

/** The separator after paragraph i, as the text has it; the last one has none, so it
 *  is what a note would most likely put there (a list item a newline, others a blank line). */
const defaultAfter = (p: Paragraph) => (p.kind === "listItem" ? "\n" : "\n\n");
function afterOf(markdown: string, paragraphs: readonly Paragraph[], i: number): string {
  return i < paragraphs.length - 1 ? markdown.slice(paragraphs[i]!.end, paragraphs[i + 1]!.start) : defaultAfter(paragraphs[i]!);
}
/** Whether a blank line stands between two paragraphs (a loose list, an airy text). */
const hasBlankLine = (after: string) => (after.match(/\n/g)?.length ?? 0) >= 2;

/** A text line right under a list item or quote with no blank line: it is a lazy line of it. */
const isLazy = (prev: Paragraph, next: Paragraph, gap: string) =>
  (prev.kind === "listItem" || prev.kind === "quote") && next.kind === "text" && !hasBlankLine(gap);

/** A paragraph's text as far as it shows: indentation counts (nesting, code), a line's trailing spaces
 *  only when there are two or more (a hard line break). alignParagraphs' `norm` ignores both. */
const renderKey = (text: string): string =>
  text.split("\n").map((line) => line.replace(/\r$/, "")).map((line) => (/ {2,}$/.test(line) ? line.replace(/ +$/, "  ") : line.trimEnd())).join("\n");

/** The paired rows that keep their order (the longest run that is in the same order in
 *  both texts). A paired paragraph outside it moved: it is proposed as a delete where it
 *  was and an insert where it went, because a place can only be named, not reordered. */
function paragraphsInOrder(rows: readonly Alignment[]): Set<Alignment> {
  const paired = rows.filter((r): r is Alignment & { old: Paragraph; new: Paragraph } => r.old !== null && r.new !== null);
  const position = new Map<Paragraph, number>();
  // Old paragraphs in document order are rows' `old` in base order: rank them by start offset.
  [...paired].sort((x, y) => x.old.start - y.old.start).forEach((r, i) => position.set(r.old, i));
  const tails: number[] = []; // tails[k]: smallest base rank ending a run of length k+1
  const tailRow: number[] = [];
  const before = new Array<number>(paired.length).fill(-1);
  paired.forEach((r, i) => {
    const rank = position.get(r.old)!;
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid]! < rank) lo = mid + 1; else hi = mid; }
    tails[lo] = rank;
    tailRow[lo] = i;
    before[i] = lo > 0 ? tailRow[lo - 1]! : -1;
  });
  const kept = new Set<Alignment>();
  for (let i = tails.length ? tailRow[tails.length - 1]! : -1; i >= 0; i = before[i]!) kept.add(paired[i]!);
  return kept;
}

/** The paragraph-level changes from `base` to `proposed`, in document order:
 *  a paragraph that changed (its words, its indentation, a hard line break) is a
 *  replace, one that went a delete, one that appeared an insert after the
 *  paragraph before it, one whose blank line after it appeared or went (tight ↔
 *  loose list, after a heading) a replace of itself. One blank line against two,
 *  and trailing spaces on a line, are no change. */
export function proposeItems(base: string, proposedText: string): ItemDraft[] {
  // The note's line endings are the note's: what the AI sends is written the way the note is.
  const proposed = proposedText.replace(/\r\n/g, "\n").replace(/\n/g, base.includes("\r\n") ? "\r\n" : "\n");
  const older = splitParagraphs(base);
  const newer = splitParagraphs(proposed);
  if (older.length > MAX_PARAGRAPHS || newer.length > MAX_PARAGRAPHS) throw new SuggestionTooLargeError();
  const indexOf = new Map(older.map((p, i) => [p, i]));
  const newIndexOf = new Map(newer.map((p, i) => [p, i]));
  /** What an item stores for a paragraph of `proposed`: bare for the last one. */
  const unitOf = (p: Paragraph, lead = "", leadLazy = false, moved = false) => {
    const i = newIndexOf.get(p)!;
    if (i >= newer.length - 1) return encodeUnit(p.text, "", lead, { lead: leadLazy, moved });
    const after = afterOf(proposed, newer, i);
    return encodeUnit(p.text, after, lead, { lead: leadLazy, after: isLazy(p, newer[i + 1]!, after), moved });
  };
  /** The proposal runs this paragraph lazily under the list item or quote before it. */
  const lazyUnder = (p: Paragraph) => {
    const j = newIndexOf.get(p)!;
    return j > 0 && isLazy(newer[j - 1]!, p, afterOf(proposed, newer, j - 1));
  };
  const place = (p: Paragraph) => ({ baseText: p.text, baseOccurrence: paragraphOccurrence(older, indexOf.get(p)!) });
  const drafts: ItemDraft[] = [];
  const rows = alignParagraphs(older, newer);
  const stays = paragraphsInOrder(rows);
  /** Inserts go after the last paragraph of the note that stays put: the one place whose
   *  position among the others cannot change, so the new text lands in the order sent. */
  let anchor: Paragraph | null = null;
  let anchorHasNext = true;
  let firstAfterAnchor = true;
  const insert = (p: Paragraph, moved = false) => {
    // After the note's last paragraph there is no separator to compare: the first paragraph added carries it.
    const j = newIndexOf.get(p)!;
    const before = j > 0 ? afterOf(proposed, newer, j - 1) : "";
    const leadLazy = anchor !== null && firstAfterAnchor && j > 0 && isLazy(newer[j - 1]!, p, before);
    const lead = anchor && !anchorHasNext && j > 0 && (before !== defaultAfter(anchor) || leadLazy) ? before : "";
    if (anchor) { anchorHasNext = true; firstAfterAnchor = false; }
    drafts.push(anchor
      ? { kind: "insert", ...place(anchor), newText: unitOf(p, lead, leadLazy, moved) }
      : { kind: "insert", baseText: "", baseOccurrence: 0, newText: unitOf(p, "", false, moved) });
  };
  for (const row of rows) {
    if (row.kind === "removed") drafts.push({ kind: "delete", ...place(row.old) });
    else if (row.kind === "added") insert(row.new);
    else if (!stays.has(row)) { drafts.push({ kind: "delete", ...place(row.old) }); insert(row.new, true); }
    else {
      anchor = row.old;
      firstAfterAnchor = true;
      const oi = indexOf.get(row.old)!, ni = newIndexOf.get(row.new)!;
      anchorHasNext = oi < older.length - 1;
      // A blank line where there was none, or none where there was one, is a change to write even where it shows
      // nothing (after a heading): accepting everything gives the proposal back as sent.
      const spacingMatters = oi < older.length - 1 && ni < newer.length - 1
        && (hasBlankLine(afterOf(base, older, oi)) !== hasBlankLine(afterOf(proposed, newer, ni))
          // what follows it now runs lazily under it, or no longer does
          || isLazy(row.old, older[oi + 1]!, afterOf(base, older, oi)) !== isLazy(row.new, newer[ni + 1]!, afterOf(proposed, newer, ni)));
      if (row.kind === "changed" || renderKey(row.old.text) !== renderKey(row.new.text) || spacingMatters) {
        drafts.push({ kind: "replace", ...place(row.old), newText: unitOf(row.new, "", lazyUnder(row.new)) });
      }
    }
  }
  return drafts;
}

/** The separator to write between two blocks: `gap`. `lazyOk`: the note already runs a text line right under
 *  this list item or quote, so another one there is its own style. When a paragraph between the two was left out (`trusted`
 *  is false) a bare line break is checked, because the neighbours are new to each other; when they are as
 *  the note or the proposal had them, the gap is theirs as it stands, a lazy line included. If
 *  the two would run into one paragraph, or a text line would turn into a lazy continuation of the list
 *  item or quote above it, a blank line is written instead, the least that keeps them apart. */
function keepApart(before: string, gap: string, after: string, trusted: boolean, lazyOk: boolean, eol: string): string {
  if (trusted || hasBlankLine(gap)) return gap;
  const [first, second, ...rest] = splitParagraphs(before + gap + after);
  const apart = rest.length === 0 && first?.text === before && second?.text === after;
  return apart && (lazyOk || !(second!.kind === "text" && (first!.kind === "listItem" || first!.kind === "quote"))) ? gap : eol + eol;
}

/** `base` with `items` made. An item whose place is not in `base` is returned
 *  in `missing` (by index into `items`) and not applied. A replace and an
 *  insert after the same paragraph both land. A rewritten paragraph keeps its
 *  anchor (it moves with the text, services/blockAnchors). Each paragraph
 *  keeps the separator that followed it where it came from: an untouched one
 *  the base's, a replaced or new one the proposal's (see the header). A paragraph
 *  added that carries the `^id` of an unchanged one still in the note (it was moved and only
 *  its new place was accepted) is written without the id: an id names one block. */
export function applyItems(base: string, items: readonly ItemChange[]): { markdown: string; missing: number[] } {
  const paragraphs = splitParagraphs(base);
  const missing: number[] = [];
  type Unit = ReturnType<typeof decodeUnit>;
  const replaced = new Map<number, Unit>();
  const deleted = new Set<number>();
  const insertsAfter = new Map<number, Unit[]>();
  items.forEach((item, index) => {
    const atStart = item.kind === "insert" && item.baseText === "";
    const i = atStart ? -1 : findParagraph(paragraphs, item.baseText, item.baseOccurrence);
    if (i === -1 && !atStart) { missing.push(index); return; }
    if (item.kind === "replace") replaced.set(i, decodeUnit(item.newText));
    else if (item.kind === "delete") deleted.add(i);
    else (insertsAfter.get(i) ?? insertsAfter.set(i, []).get(i)!).push(decodeUnit(item.newText));
  });
  if (paragraphs.length === 0) {
    const added = insertsAfter.get(-1) ?? [];
    return { markdown: added.length ? added.map((u, k) => u.text + (k < added.length - 1 ? u.after || "\n\n" : "\n")).join("") : base, missing };
  }
  const lead = base.slice(0, paragraphs[0]!.start);
  const tail = base.slice(paragraphs[paragraphs.length - 1]!.end);
  const gapAfter = (i: number) => afterOf(base, paragraphs, i);
  /** baseIndex: the paragraph of the note this is (-1: added). */
  /** trust: whose adjacency `gap` is. base: the note's (holds while the next paragraph of the note still follows);
   *  none: checked against the neighbour it gets. lazyOk: the proposal or the note runs a text line right under this one. */
  type Entry = { text: string; gap: string; baseIndex: number; trust: "base" | "none"; moved?: true; /** the note lets a text line follow this paragraph right under it */ lazyOk?: true; untouched?: true };
  const entries: Entry[] = [];
  const first = paragraphs[0]!;
  // Added at the very start go after a note's front matter, which must stay first, unless they are front matter themselves.
  const atStart = insertsAfter.get(-1) ?? [];
  const aboveFrontMatter = first.kind === "frontmatter" ? atStart.filter((u) => splitParagraphs(u.text)[0]?.kind === "frontmatter") : atStart;
  const belowFrontMatter = first.kind === "frontmatter" ? atStart.filter((u) => !aboveFrontMatter.includes(u)) : [];
  for (const u of aboveFrontMatter) entries.push({ text: u.text, gap: u.after || defaultAfter(first), baseIndex: -1, trust: "none", ...(u.afterLazy ? { lazyOk: true as const } : {}), ...(u.moved ? { moved: true as const } : {}) });
  paragraphs.forEach((p, i) => {
    const own = replaced.get(i);
    if (!deleted.has(i)) {
      // A paragraph the proposal runs lazily under the one before it takes that gap as it is.
      const before = entries[entries.length - 1];
      if (own?.leadLazy && before && !hasBlankLine(before.gap)) before.lazyOk = true;
      entries.push({ text: own?.text ?? p.text, gap: own?.after || gapAfter(i), baseIndex: i, trust: own ? "none" : "base", ...((own?.afterLazy || (i < paragraphs.length - 1 && isLazy(p, paragraphs[i + 1]!, gapAfter(i)))) ? { lazyOk: true as const } : {}), ...(own ? {} : { untouched: true as const }) });
    }
    const added = [...(i === 0 ? belowFrontMatter : []), ...(insertsAfter.get(i) ?? [])];
    added.forEach((u, k) => {
      // The first paragraph added after the note's last one brings the separator before it.
      const anchorEntry = entries.length > 0 && entries[entries.length - 1]!.baseIndex === i ? entries[entries.length - 1]! : null;
      if (k === 0 && anchorEntry) {
        if (i === paragraphs.length - 1 && u.lead) { anchorEntry.gap = u.lead; anchorEntry.trust = "none"; }
        if (u.leadLazy && !hasBlankLine(anchorEntry.gap)) anchorEntry.lazyOk = true;
      }
      entries.push({ text: u.text, gap: u.after || gapAfter(i), baseIndex: -1, trust: "none", ...(u.afterLazy ? { lazyOk: true as const } : {}), ...(u.moved ? { moved: true as const } : {}) });
    });
  });
  const ids = new Set(entries.flatMap((e) => (e.untouched ? [splitParagraphs(e.text)[0]?.blockId ?? ""] : [])));
  for (const e of entries) {
    if (e.baseIndex >= 0) continue;
    const added = splitParagraphs(e.text)[0];
    if (e.moved && added?.blockId && ids.has(added.blockId)) e.text = added.body;
  }
  // A text line the note itself keeps right under a list item or quote may keep that place under another one.
  const lazyAttached = new Set(paragraphs.flatMap((p, j) => (j > 0 && isLazy(paragraphs[j - 1]!, p, gapAfter(j - 1)) ? [j] : [])));
  const body = entries.map((e, i) => {
    if (i === entries.length - 1) return e.text;
    const next = entries[i + 1]!;
    const trusted = (e.trust === "base" && next.baseIndex === e.baseIndex + 1 && next.untouched === true);
    return e.text + keepApart(e.text, e.gap, next.text, trusted, e.lazyOk === true || lazyAttached.has(next.baseIndex), base.includes("\r\n") ? "\r\n" : "\n");
  }).join("");
  return { markdown: lead + body + tail, missing };
}
