// The pages of a note's 「簡報」 view, cut from the note's text when it is read
// (docs/architecture/proposals/slides-2026-10-31.md §4.1) — nothing is stored.
// Slides are cut by parseDeck (`---`, else `##`); this adds what a slide shows,
// what is only for the speaker, which layout its content asks for, and the page
// key that finds a page's chosen layout again after the note changes (§1.3).

// A paragraph's identity as the Markdown readers take it (the frontend's blockAnchorStore holds the same shape).
export type AnchorSpan = { id: string; from: number; to: number };
import { cutToGraphemes } from "./graphemes.js";
import { plainInline } from "./plainText.js";
import { analyzeSlide, slideBlockText, emLength, isFigure, itemText, listItems, type SlideBlock } from "./slideAnalyze.js";
import { parseDeck, type DeckSource } from "./slideDeck.js";

export const LAYOUT_IDS = ["cover", "section", "bullets", "text", "media", "fullImage", "quote", "compare", "three", "stat", "timeline", "codeMath"] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];
export const isLayoutId = (id: string): id is LayoutId => (LAYOUT_IDS as readonly string[]).includes(id);

/** The stored choice for a page and the key it is stored under: its own key, or its legacyKey for a choice made before
 *  keys read the text in writing order. A stored legacy key is claimed by the page it was the key of: another page whose
 *  new key happens to be the same text does not read it (`hello` / `a` + `hello`: the first page's old `p:hello` is not
 *  the second page's `p:hello`), as long as the claiming page has no choice of its own under its new key. Known limit:
 *  a page that chose "automatic" while a sibling's new key equals its legacy key leaves that sibling's entry to be
 *  claimed by it. */
export function layoutSource(page: SlidePage, layouts: Readonly<Record<string, string>>): { key: string; value: string } | undefined {
  const claimedByPeer = (key: string) => page.deckKeys?.some((p) => p.key !== page.key && p.legacyKey === key && layouts[p.key] === undefined && layouts[key] !== undefined);
  if (layouts[page.key] !== undefined && !claimedByPeer(page.key)) return { key: page.key, value: layouts[page.key]! };
  const legacy = page.legacyKey;
  return legacy !== undefined && layouts[legacy] !== undefined ? { key: legacy, value: layouts[legacy]! } : undefined;
}

/** `layouts` with every choice stored under a page's legacyKey moved to that page's key, in place (same order), for all
 *  pages at once: a write starts from this, so one page's change never reads or removes the entry that belongs to
 *  another (`p:hello` stored for page 1 is not page 2's). Entries no page reads stay as they are. */
export function layoutsByPageKey(pages: readonly SlidePage[], layouts: Readonly<Record<string, string>>): Record<string, string> {
  const target = new Map<string, string>();
  for (const page of pages) {
    const source = layoutSource(page, layouts);
    if (source) target.set(source.key, page.key);
  }
  return Object.fromEntries(Object.entries(layouts).map(([key, value]) => [target.get(key) ?? key, value]));
}

/** The layout chosen for a page (see layoutSource); undefined when none. */
export const chosenLayout = (page: SlidePage, layouts: Readonly<Record<string, string>>): string | undefined => layoutSource(page, layouts)?.value;

/** The layout a page is drawn in: the one chosen for it in `slides_data.layouts`, else the one its content asks for. */
export const layoutOfPage = (page: SlidePage, layouts: Readonly<Record<string, string>>): LayoutId => {
  const chosen = chosenLayout(page, layouts);
  return chosen && isLayoutId(chosen) ? chosen : page.autoLayout;
};

/** What a layout arranges: a page's content sorted by role. */
export type SlidePageParts = {
  /** The first heading's words (no marks). */
  heading: string | null;
  /** The id of the anchor that starts at that heading, if it has one (pagesOf fills it: partsOf reads one slide, not the note). */
  headingId: string | null;
  /** The slide's one big sentence: a page whose only text is one paragraph. */
  statement: string | null;
  /** A line under the heading: the first paragraph of a page that has nothing else, if it is short enough to be one
   *  (MAX_SUBTITLE); a longer one is the body, drawn as text that scales to fit. */
  subtitle: string | null;
  /** Everything else that goes on the slide, in order. */
  body: SlideBlock[];
};

export type SlidePage = {
  /** Finds this page's chosen layout again (pageKey). */
  key: string;
  parts: SlidePageParts;
  /** The paragraphs that are for the speaker only (Markdown). */
  notes: string;
  cites: DeckSource[];
  /** The layout the content asks for; a chosen layout replaces it. */
  autoLayout: LayoutId;
  /** The key this page had before keys read a heading-less page's first text in writing order; set only when it differs.
   *  A layout chosen under it still counts (layoutOfPage), so no stored choice is lost. */
  legacyKey?: string;
  /** Every page of the deck as (key, legacyKey), the same array on each page: layoutSource needs it to tell whose old key a stored one is. */
  deckKeys?: readonly { key: string; legacyKey?: string }[];
  /** The page's heading line as written (`## Steps`), the one `parts.heading` reads the words of; null without a heading (pagesOf always sets it). */
  headingLine?: string | null;
  /** Where the page's text sits in the note (offsets into the Markdown with `\r\n` read as `\n`); null when it could not be found. */
  range?: { from: number; to: number } | null;
};

const MAX_STATEMENT = 60;
/** A line under a title is at most about this long (em, as emLength counts); a first paragraph longer than that is the slide's text, not its subtitle. */
export const MAX_SUBTITLE = 120;
const KEY_TEXT = 24;
export const NUMBER_LEAD = /^[+\-~≈]?[$￥NT]*\d[\d.,]*\s?(%|％|x|X|倍|萬|億|k|K|M|B|人|個|種|款|頁|篇|天|年|月|週|小時|分鐘)?(?=\s|$|[:：、，,])/;
export const TIME_LEAD = /^(\d{4}([-/.]\d{1,2})?|Q[1-4]|\d{1,2}月|\d{1,2}[:：]\d{2})/;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Sort a slide's blocks into the roles layouts arrange. `index` is the slide's place: a first page with a heading and one line is a cover. */
export function partsOf(markdown: string, index: number): { parts: SlidePageParts; notes: string; headingLine: string | null; /** The page's blocks' text in the order written (no heading). */ texts: string[] } {
  const blocks = analyzeSlide(markdown);
  const headingAt = blocks.findIndex((block) => block.kind === "heading");
  const found = headingAt >= 0 ? blocks[headingAt].heading! : null;
  const rest = blocks.filter((_, i) => i !== headingAt);
  const paragraphs = rest.filter((block) => block.kind === "paragraph");
  const shown = rest.filter((block) => block.kind !== "paragraph");
  const parts: SlidePageParts = { heading: found?.text ?? null, headingId: null, statement: null, subtitle: null, body: shown };
  let notes = paragraphs;
  if (shown.length === 0 && paragraphs.length > 0) {
    const [first, ...others] = paragraphs;
    const line = oneLine(slideBlockText(first));
    if (paragraphs.length === 1 && !(index === 0 && found) && emLength(line) <= MAX_STATEMENT) {
      parts.statement = first.markdown; // 大字標語頁
      notes = [];
    } else if (emLength(line) > MAX_SUBTITLE) {
      parts.body = [first]; // a heading and an article: its first paragraph is the slide's text (it scales to fit, never cut off)
      notes = others;
    } else {
      parts.subtitle = first.markdown; // the first paragraph stays so the page is not empty
      notes = others;
    }
  }
  return { parts, notes: notes.map((block) => block.markdown).join("\n\n"), headingLine: headingAt >= 0 ? blocks[headingAt].markdown : null, texts: rest.map(slideBlockText) };
}

const total = (blocks: readonly SlideBlock[]) => blocks.reduce((sum, block) => sum + emLength(slideBlockText(block)), 0);

/** The layout a page's content asks for (the first rule that holds). */
export function autoLayoutOf(parts: SlidePageParts, index: number): LayoutId {
  const { body } = parts;
  if (parts.statement) return "section";
  if (body.length === 0) return index === 0 && parts.heading ? "cover" : "section";
  const kinds = (kind: SlideBlock["kind"]) => body.filter((block) => block.kind === kind);
  const figures = body.filter(isFigure);
  const text = body.filter((block) => !isFigure(block));
  if (kinds("quote").length > 0 && total(kinds("quote")) <= 140 && text.length === kinds("quote").length) return "quote";
  // A picture alone fills the slide; an embed (a drawing, a note, a task list) is drawn as it is beside the words.
  if (figures.length > 0) return text.length === 0 && figures.every((block) => block.kind === "image") ? "fullImage" : "media";
  if (body[0].kind === "code" || body[0].kind === "math") return "codeMath";
  const subheadings = body.filter((block) => block.kind === "heading");
  if (subheadings.length === 2 && body.length >= 4) return "compare";
  const list = kinds("list")[0];
  if (list && kinds("list").length === 1 && text.length === 1) {
    const items = listItems(list);
    // Dates before numbers: "2025 grow" is a step, "90% stay" a figure.
    if (items.length >= 3 && items.length <= 6 && items.every((item) => TIME_LEAD.test(itemText(item)))) return "timeline";
    if (items.length >= 1 && items.length <= 3 && items.every((item) => NUMBER_LEAD.test(itemText(item)))) return "stat";
    if (items.length === 3 && items.every((item) => emLength(itemText(item)) <= 30)) return "three";
  }
  return list ? "bullets" : "text";
}

/** The page key: the heading's anchor id when it has one (it survives a change of the title), else the heading's words, else the first words of the page in the order it is written, else its place. */
function keyOf(parts: SlidePageParts, texts: readonly string[], index: number): string {
  if (parts.headingId) return `^${parts.headingId}`;
  if (parts.heading) return `h:${oneLine(parts.heading).toLowerCase()}`;
  return textKey(texts.find((text) => oneLine(plainInline(text)))) ?? `n:${index + 1}`;
}

const textKey = (text: string | null | undefined) => (text ? `p:${cutToGraphemes(oneLine(plainInline(text)).toLowerCase(), KEY_TEXT)}` : null);

/** The key as it was before keyOf read the text in writing order (statement, subtitle, notes, then body). */
function legacyKeyOf(parts: SlidePageParts, notes: string, index: number): string {
  if (parts.headingId || parts.heading) return keyOf(parts, [], index);
  const first = [parts.statement, parts.subtitle, notes, ...parts.body.map(slideBlockText)].find((text) => text && oneLine(plainInline(text)));
  return textKey(first) ?? `n:${index + 1}`;
}

/** The id of the anchor that starts at the heading line `line` of the slide that begins at `slideAt` in the note: a heading
 *  is a block whose anchor starts at it. Null without an anchor there. */
function headingAnchorId(markdown: string, slideMarkdown: string, slideAt: number, line: string | null, anchors: readonly AnchorSpan[]): string | null {
  if (line === null || slideAt < 0) return null;
  const at = slideMarkdown.indexOf(line);
  return at < 0 ? null : anchors.find((a) => a.from === slideAt + at)?.id ?? null;
}

/** The pages of a note. Two pages that would share a key take `~2`, `~3` … in order. `anchors`: the note's paragraph
 *  anchors read against `markdown` (blockAnchorStore anchorSpansOf); a heading with none is keyed by its words. */
export function pagesOf(markdown: string, anchors: readonly AnchorSpan[] = []): SlidePage[] {
  const seen = new Map<string, number>();
  const used = new Set<string>();
  const legacySeen = new Map<string, number>();
  const text = markdown.replace(/\r\n/g, "\n");
  let cursor = 0;
  const deckKeys: { key: string; legacyKey?: string }[] = [];
  const pages = parseDeck(markdown).slides.map((slide, index) => {
    const { parts, notes, headingLine, texts } = partsOf(slide.markdown, index);
    // Slides come in order, each from the text the last ended at (the text is trimmed, so find it by search).
    const found = slide.markdown ? text.indexOf(slide.markdown, cursor) : -1;
    if (found >= 0) cursor = found + slide.markdown.length;
    if (anchors.length > 0) parts.headingId = headingAnchorId(text, slide.markdown, found, headingLine, anchors);
    const base = keyOf(parts, texts, index);
    // A heading that itself reads `a~2` could meet a suffixed key: take the next number until the key is free.
    let count = (seen.get(base) ?? 0) + 1;
    while (used.has(count === 1 ? base : `${base}~${count}`)) count++;
    seen.set(base, count);
    const key = count === 1 ? base : `${base}~${count}`;
    used.add(key);
    const oldBase = legacyKeyOf(parts, notes, index);
    const oldCount = (legacySeen.get(oldBase) ?? 0) + 1;
    legacySeen.set(oldBase, oldCount);
    const legacyKey = oldCount === 1 ? oldBase : `${oldBase}~${oldCount}`;
    deckKeys.push({ key, ...(legacyKey !== key ? { legacyKey } : {}) });
    const range = found >= 0 ? { from: found, to: found + slide.markdown.length } : null;
    return { key, parts, notes, cites: slide.cites, autoLayout: autoLayoutOf(parts, index), ...(legacyKey !== key ? { legacyKey } : {}), deckKeys, headingLine, range };
  });
  return pages;
}
