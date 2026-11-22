// Page operations on a note's text: the 「簡報」 tab's thumbnails move, copy, delete and add pages by changing the note's
// ONE text (docs/agents/decisions-slides.md 「編輯」) — a deck has no copy of its own. Each function is pure: the note's text
// in, the new text out, plus how the pages and the positions of the old text carry over (`DeckEdit`), so the caller can
// move each page's chosen layout with its page and keep a caret or a paragraph anchor where it was.
//
// A page is where parseDeck says it is (`Slide.from`/`to`: the page's own text, not the `---` line or the blank lines
// around it). The stretches BETWEEN pages ("gaps": `\n\n---\n\n`, or blank lines when the note is cut at `##`) stay where
// they are, in number and order: moving pages only exchanges the texts between them, so the separators stay right and
// the frontmatter, any text before the first page and a trailing source list are never touched. Line ends are written
// as `\n` (the editor's own).
//
// Paragraph anchors are not in the text (block_anchors): a moved paragraph keeps its anchor only if the save finds the
// words again; a COPY never has one. An old `^id` mark that is still in the text is removed from the copy, since two
// paragraphs may not share an id.

import { fenceScanner, trailingBlockId } from "@onden/markdown";
import { parseDeck, type Deck } from "./slides";

export type DeckEdit = {
  /** The note's text after the operation. */
  text: string;
  /** For each page after it: the page of the old text it came from (a copy names the page it copies), -1 for a new, empty one. */
  order: number[];
  /** The page to show after it. */
  select: number;
  /** Where to put the caret: the end of a new page's title (insertPage only). */
  caret?: number;
  /** Where an offset of the old text is now; null when its text is gone (a deleted page). */
  map: (offset: number) => number | null;
};

const SEPARATOR = { rule: "\n\n---\n\n", heading: "\n\n" } as const;
const normalize = (text: string) => text.replace(/\r\n/g, "\n");

/** `text` without the `^id` marks that end its lines (outside code fences). */
function withoutLineIds(text: string): string {
  const fence = fenceScanner({ math: true }); // the same reading as the cut (parseDeck): a `^2` inside `$$` is the formula's
  return text.split("\n").map((line) => {
    if (fence(line) !== "outside") return line;
    const id = trailingBlockId(line);
    return id ? line.slice(0, id.start).trimEnd() : line;
  }).join("\n");
}

/** The pages `text` is cut into are exactly `expected`. An operation whose result is cut differently (a first page that
 *  is no `##` section run into the next one, an unclosed code fence that swallows what follows, a copy of such a page)
 *  is not done: the caller says why instead of sending text whose pages no longer match what was shown. */
const holds = (text: string, expected: readonly string[]): boolean => {
  const pages = parseDeck(text).slides;
  return pages.length === expected.length && pages.every((slide, i) => slide.markdown === expected[i]);
};

/** A note written with `\r\n` stays so (`edit.text`); offsets (`map`, `caret`) are those of the text with `\n`. */
const withLineEnds = (markdown: string, edit: DeckEdit): DeckEdit => (/\r\n/.test(markdown) ? { ...edit, text: edit.text.replace(/\n/g, "\r\n") } : edit);

type Parts = { text: string; deck: Deck; texts: string[]; empty: boolean };
function read(markdown: string): Parts {
  const text = normalize(markdown);
  const deck = parseDeck(text);
  return { text, deck, texts: deck.slides.map((slide) => text.slice(slide.from, slide.to)), empty: deck.slides.length === 1 && deck.slides[0].markdown === "" };
}

/** Page `from` goes to place `to` (both 0-based page numbers of the old text); null when that changes nothing or is out of range. */
function movePageOf(markdown: string, from: number, to: number): DeckEdit | null {
  const { text, deck, texts, empty } = read(markdown);
  const n = texts.length;
  if (empty || from === to || from < 0 || to < 0 || from >= n || to >= n) return null;
  const order = texts.map((_, i) => i);
  order.splice(from, 1);
  order.splice(to, 0, from);
  const slides = deck.slides;
  const oldGaps = slides.slice(1).map((slide, k) => text.slice(slides[k].to, slide.from));
  // Rebuild: before the first page, then each page's text in its new order with the gaps between, then the rest.
  const build = (gaps: string[]) => {
    let out = text.slice(0, slides[0].from);
    const placed: { oldFrom: number; oldTo: number; newFrom: number; gapAt: number }[] = [];
    order.forEach((old, k) => {
      placed.push({ oldFrom: slides[old].from, oldTo: slides[old].to, newFrom: out.length, gapAt: out.length + texts[old].length });
      out += texts[old] + (k < n - 1 ? gaps[k] : "");
    });
    return { out: out + text.slice(slides[n - 1].to), placed };
  };
  let built = build(oldGaps);
  // A page that ends in a paragraph line, put right above a bare `---`, would turn it into a heading underline.
  if (!holds(built.out, order.map((old) => texts[old]))) built = build(oldGaps.map(() => SEPARATOR[deck.split]));
  const { out, placed } = built;
  if (!holds(out, order.map((old) => texts[old]))) return null;
  const map = (offset: number): number | null => {
    const hit = placed.find((p) => offset >= p.oldFrom && offset <= p.oldTo);
    if (hit) return hit.newFrom + (offset - hit.oldFrom);
    // In a gap (or before the first page, after the last): the gap k stays in its place among the pages.
    const k = slides.findIndex((s, i) => i < n - 1 && offset > s.to && offset < slides[i + 1].from);
    return k < 0 ? offset : placed[k].gapAt + Math.min(offset - slides[k].to, SEPARATOR[deck.split].length);
  };
  return { text: out, order, select: to, map };
}

/** A copy of page `index` right below it. */
function duplicatePageOf(markdown: string, index: number): DeckEdit | null {
  const { text, deck, texts, empty } = read(markdown);
  if (empty || index < 0 || index >= texts.length) return null;
  const at = deck.slides[index].to;
  const inserted = SEPARATOR[deck.split] + withoutLineIds(texts[index]);
  const order = texts.flatMap((_, i) => (i === index ? [i, i] : [i]));
  const result = text.slice(0, at) + inserted + text.slice(at);
  if (!holds(result, order.map((old, i) => (i === index + 1 ? withoutLineIds(texts[old]) : texts[old])))) return null;
  return {
    text: result,
    order, select: index + 1,
    map: (offset) => (offset <= at ? offset : offset + inserted.length),
  };
}

/** Page `index` removed, with the separator next to it; null for the only page (a deck keeps one). */
function deletePageOf(markdown: string, index: number): DeckEdit | null {
  const { text, deck, texts, empty } = read(markdown);
  const n = texts.length;
  if (empty || n < 2 || index < 0 || index >= n) return null;
  const slides = deck.slides;
  // The last page takes the gap before it with it; any other the gap after.
  const [cutFrom, cutTo] = index === n - 1 ? [slides[index - 1].to, slides[index].to] : [slides[index].from, slides[index + 1].from];
  const order = texts.map((_, i) => i).filter((i) => i !== index);
  const result = text.slice(0, cutFrom) + text.slice(cutTo);
  if (!holds(result, order.map((old) => texts[old]))) return null;
  return {
    text: result,
    order, select: Math.min(index, n - 2),
    map: (offset) => (offset < cutFrom ? offset : offset >= cutTo ? offset - (cutTo - cutFrom) : offset === cutFrom ? cutFrom : null),
  };
}

/** A new page called `title` as page `at` (0 … page count: the last place is the end), cut the way the note is cut. */
function insertPageOf(markdown: string, at: number, title: string): DeckEdit | null {
  const { text, deck, texts, empty } = read(markdown);
  const n = texts.length;
  if (at < 0 || at > n) return null;
  const heading = `## ${title}`;
  const sep = SEPARATOR[deck.split];
  let place: number;
  let inserted: string;
  let headingAt: number;
  if (empty) {
    place = deck.slides[0].from;
    inserted = heading;
    headingAt = 0;
  } else if (at === n) {
    place = deck.slides[n - 1].to;
    inserted = sep + heading;
    headingAt = sep.length;
  } else {
    place = deck.slides[at].from;
    inserted = heading + sep;
    headingAt = 0;
  }
  const order = empty ? [-1] : [...texts.keys()].flatMap((i) => (i === at ? [-1, i] : [i])).concat(at === n ? [-1] : []);
  const result = text.slice(0, place) + inserted + text.slice(place);
  if (!holds(result, order.map((old) => (old < 0 ? heading : texts[old])))) return null;
  return {
    text: result,
    order, select: empty ? 0 : at,
    caret: place + headingAt + heading.length,
    // The text at `place` is pushed after the new page; a caret at the very start of the page that was there stays in front of it.
    map: (offset) => (offset < place || (offset === place && at === n) ? offset : offset + inserted.length),
  };
}

/** Page `from` goes to place `to` (0-based page numbers of the old text); null when that changes nothing, is out of range or
 *  would leave the note cut into other pages than the ones shown. */
export const movePage = (markdown: string, from: number, to: number): DeckEdit | null => wrap(markdown, movePageOf(markdown, from, to));
/** A copy of page `index` right below it; null when the copy would not come out as a page of its own. */
export const duplicatePage = (markdown: string, index: number): DeckEdit | null => wrap(markdown, duplicatePageOf(markdown, index));
/** Page `index` removed, with the separator next to it; null for the only page (a deck keeps one). */
export const deletePage = (markdown: string, index: number): DeckEdit | null => wrap(markdown, deletePageOf(markdown, index));
/** A new page called `title` as page `at` (0 … page count: the last place is the end), cut the way the note is cut. */
export const insertPage = (markdown: string, at: number, title: string): DeckEdit | null => wrap(markdown, insertPageOf(markdown, at, title));
const wrap = (markdown: string, edit: DeckEdit | null): DeckEdit | null => (edit ? withLineEnds(markdown, edit) : null);

/** The chosen layouts after `edit`: each page's choice goes to its page's new key (a copy takes its original's), the keys of
 *  pages that are gone are dropped, and choices that belonged to no page of the old text stay as they were. */
export function carryLayouts(
  layouts: Readonly<Record<string, string>>, oldKeys: readonly string[], newKeys: readonly string[], order: readonly number[],
): Record<string, string> {
  const old = new Set(oldKeys);
  const next: Record<string, string> = Object.fromEntries(Object.entries(layouts).filter(([key]) => !old.has(key)));
  newKeys.forEach((key, i) => {
    const chosen = order[i] >= 0 ? layouts[oldKeys[order[i]]] : undefined;
    if (chosen) next[key] = chosen;
  });
  return next;
}

/** The page a place in the note's text belongs to: the last page that starts at or before `offset`, so the separator and
 *  blank lines after a page are still that page, and the text before the first page (or the source list after the last)
 *  is the first (or last) page. */
export function pageIndexAt(pages: readonly { range?: { from: number } | null }[], offset: number): number {
  let found = 0;
  pages.forEach((page, i) => { if (page.range && page.range.from <= offset) found = i; });
  return found;
}

/** `current` with this operation's choices taken back: a key whose choice is still the one the operation left goes back to
 *  what it was before (or is removed); a choice made since, under any key, stays. */
export function undoLayouts(
  current: Readonly<Record<string, string>>, before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>,
): Record<string, string> {
  const next = { ...current };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (current[key] !== after[key]) continue;
    if (before[key] === undefined) delete next[key]; else next[key] = before[key]!;
  }
  return next;
}

/** Page `index` of `markdown` as the cut reads it now (its text), null when there is no such page. */
export function pageTextAt(markdown: string, index: number): string | null {
  const slide = parseDeck(markdown).slides[index];
  return slide && slide.markdown ? slide.markdown : null;
}
