// The layouts a slide can take (docs/architecture/proposals/slides-2026-10-31.md
// §5.2): one table of data — name, what each is for, and what to offer instead
// when a page's content does not fit — so the picker, the checks and the
// drawing read the same list. Pure; SlideView draws them.

import { slideBlockText, emLength, isFigure, itemText, listItems, type SlideBlock } from "./slideAnalyze.js";
import { NUMBER_LEAD, TIME_LEAD, type LayoutId, type SlidePageParts } from "./slidePages.js";

export type SlideLayoutSpec = {
  id: LayoutId;
  /** i18n key: the name shown on the picker. */
  label: string;
  /** i18n key: one plain sentence under the name. */
  blurb: string;
};

export const SLIDE_LAYOUTS: readonly SlideLayoutSpec[] = [
  { id: "cover", label: "Cover", blurb: "Title and a line under it, on the accent colour." },
  { id: "section", label: "Section slide", blurb: "One big line. Also for a closing slide." },
  { id: "bullets", label: "Bullets", blurb: "A title and a list; a long list runs in two columns." },
  { id: "text", label: "Paragraphs", blurb: "A title and paragraphs, in a comfortable line length." },
  { id: "media", label: "Picture and text", blurb: "A picture on one side, the words on the other." },
  { id: "fullImage", label: "Full picture", blurb: "The picture fills the slide, the title over it." },
  { id: "quote", label: "Quotation", blurb: "A quotation, large." },
  { id: "compare", label: "Two columns", blurb: "Two sides to compare." },
  { id: "three", label: "Three points", blurb: "Three short points as cards." },
  { id: "stat", label: "Numbers", blurb: "One to three big numbers with a word each." },
  { id: "timeline", label: "Steps in order", blurb: "Up to six steps in order." },
  { id: "codeMath", label: "Code or formula", blurb: "A block of code or a formula, with a caption." },
];

export const slideLayoutSpec = (id: LayoutId): SlideLayoutSpec => SLIDE_LAYOUTS.find((layout) => layout.id === id) ?? SLIDE_LAYOUTS[0];

/** The short pieces a layout lays out as items: a list's items, else the lines of the text. */
export function itemsOf(body: readonly SlideBlock[], limit = Infinity): string[] {
  const lists = body.filter((block) => block.kind === "list");
  const all = lists.length > 0
    ? lists.flatMap(listItems)
    : body.filter((block) => !isFigure(block) && block.kind !== "heading").flatMap((block) => slideBlockText(block).split("\n")).filter(Boolean);
  return all.length > limit ? all.filter((_, i) => i < limit) : all;
}

/** A number and the words after it (no number: a short first word is the figure, else the whole item is the words).
 *  `markdown` is an item as listItems gives it; what comes back is plain words (no marks, no `^id`). */
export function splitStat(markdown: string): { figure: string; caption: string } {
  const item = itemText(markdown);
  const match = NUMBER_LEAD.exec(item);
  if (match) return { figure: match[0].trim(), caption: item.slice(match[0].length).replace(/^[\s:：、，,-]+/, "").trim() };
  const [first = "", ...rest] = item.split(/\s+/);
  return emLength(first) <= 4 && rest.length > 0 ? { figure: first, caption: rest.join(" ") } : { figure: "", caption: item };
}

/** A time and what happened (no time: the whole item is the step); plain words, like splitStat. */
export function splitStep(markdown: string): { when: string; what: string } {
  const item = itemText(markdown);
  const match = TIME_LEAD.exec(item);
  return match ? { when: match[0], what: item.slice(match[0].length).replace(/^[\s:：、，,-]+/, "").trim() } : { when: "", what: item };
}

/** The two sides of a comparison: the body cut at its sub-headings; with none, its items in half. */
export function sidesOf(body: readonly SlideBlock[]): [SlideBlock[], SlideBlock[]] {
  const at = body.findIndex((block, i) => i > 0 && block.kind === "heading");
  if (body[0]?.kind === "heading" && at > 0) return [body.slice(0, at), body.slice(at)];
  const items = itemsOf(body);
  const half = Math.ceil(items.length / 2);
  const list = (lines: string[]): SlideBlock[] => (lines.length ? [{ kind: "list", markdown: lines.map((line) => `- ${line}`).join("\n"), items: lines }] : []);
  return [list(items.slice(0, half)), list(items.slice(half))];
}

const LONG_TEXT = 200;

/** A page with a table on it: the table takes the whole width of the slide and, when it is too big, shrinks as a whole. */
export const hasTable = (parts: SlidePageParts): boolean => parts.body.some((block) => block.kind === "table");

/** Step two of 放不下: another layout for the same content, offered (never applied by itself) when the content does
 *  not fit the one chosen. Null when no other layout would help. */
export function alternativeLayout(layout: LayoutId, parts: SlidePageParts): LayoutId | null {
  // Bullets and paragraphs already give a table the full width; another layout would not help it. A picture beside a
  // table leaves the table half a page: Paragraphs gives it the whole width.
  if (hasTable(parts)) {
    if (layout === "bullets" || layout === "text") return null;
    if (layout === "media") return "text";
  }
  const text = parts.body.filter((block) => !isFigure(block)).map(slideBlockText).join("\n");
  switch (layout) {
    case "media": return emLength(text) > LONG_TEXT ? "text" : null;
    case "compare": case "three": case "stat": case "timeline": return "bullets";
    case "quote": return "text";
    case "bullets": return itemsOf(parts.body).some((item) => emLength(itemText(item)) > 40) ? "text" : null;
    default: return null;
  }
}

/** The mirror of step one: a slide with little on it is not left with half a page of nothing. How far its text grows
 *  (0 = the body size, 1 = one level up, 2 = two) from how much there is: the characters, plus a cost per line since
 *  each line takes a row of the slide. The levels are the deck's own `--s-step1`/`--s-step2`, so the style's scale is
 *  the ceiling. A grown slide that then measures too full steps back one level at a time (SlideView), down to step one. */
export type GrowLevel = 0 | 1 | 2;
const LINE_COST = 25;
/** Per layout: the most "size" (characters + lines) that still grows two levels, then one. */
const GROW_LIMITS: Partial<Record<LayoutId, readonly [number, number]>> = {
  bullets: [200, 330], text: [200, 330], compare: [140, 260], three: [140, 260],
};

export function growLevel(layout: LayoutId, parts: SlidePageParts): GrowLevel {
  const limits = GROW_LIMITS[layout];
  if (!limits || parts.body.some((block) => isFigure(block) || block.kind === "code" || block.kind === "math" || block.kind === "table")) return 0;
  const lines = itemsOf(parts.body);
  const lead = parts.statement ?? parts.subtitle;
  const size = lines.reduce((sum, line) => sum + emLength(itemText(line)) + LINE_COST, 0) + (lead ? emLength(lead) + LINE_COST : 0);
  if (size === 0) return 0;
  return size <= limits[0] ? 2 : size <= limits[1] ? 1 : 0;
}

/** Step three: past the two steps the page is simply too full; the words are never cut. */
export const TOO_MUCH_HINT = "This slide has a lot on it. Consider cutting it into two sections in the note.";
/** The same, when the page's table is what does not fit even at the smallest readable size. */
export const TABLE_TOO_MUCH_HINT = "This table is too big for one slide. Consider splitting it into two slides.";
