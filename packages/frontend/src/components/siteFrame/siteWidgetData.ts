// What the site's widgets list and the facts that decide whether they draw —
// pure functions over the published snapshot (SiteData). No React here.
import { bodyAfterTitle, compareText, compareTitles, parseGfmTree, readingMinutes } from "@onden/markdown";
import { FEATURED_TAGS, MATURITY_TAGS, NO_FACTS, type WidgetFacts } from "@onden/site";
import { firstParagraph } from "@onden/site/react";
import { byUpdatedDesc } from "../../lib/noteOrder";
import { extractTOC, type PublishedNode } from "../templates";
import { adjacentNotes, backlinksOf, isoDay, noteDate, noteTree, showsDate, type SiteData } from "./siteModel";
import { nodeOf } from "../../lib/nodeIndex";

/** The most notes one list widget writes out. */
export const WIDGET_LIST_MAX = 500;
const recentCount = 10;
const ABOUT_TITLE = /^(關於|关于|about)( me| us)?$/i;

/** Newest update first; a tie goes by title, then id, so the order never depends on how the snapshot was built. */
export function byUpdated(a: PublishedNode, b: PublishedNode): number {
  return byUpdatedDesc({ updated_at: a.updated_at ?? a.created_at }, { updated_at: b.updated_at ?? b.created_at }) || compareTitles(a.title, b.title) || compareText(a.id, b.id);
}

/** The published notes that count as articles: not the home note and not the notes that stand for tags. */
export function articlesOf(data: SiteData): PublishedNode[] {
  const tagNotes = new Set(Object.keys(data.design.tag_pages));
  return data.nodes.filter((n) => n.id !== data.homeNodeId && !tagNotes.has(n.id));
}

export const recentOf = (data: SiteData): PublishedNode[] => [...articlesOf(data)].sort(byUpdated).slice(0, recentCount);

/** The note the self-introduction comes from: the home note, else one called 關於／About; it needs prose. */
export function introNoteOf(data: SiteData): PublishedNode | null {
  const home = nodeOf(data, data.homeNodeId);
  const about = data.nodes.find((n) => ABOUT_TITLE.test(n.title.trim()) || n.slug === "about");
  return [home, about].find((n): n is PublishedNode => !!n && firstParagraph(n) !== "") ?? null;
}

/** The first sentence of a paragraph (to the first 。！？ or . ! ? followed by a space). */
export function firstSentence(paragraph: string): string {
  const match = /^[\s\S]*?(?:[。！？]|[.!?](?=\s|$))/.exec(paragraph.trim());
  return (match ? match[0] : paragraph).trim();
}

export type Topic = { id: string; name: string; slug: string; count: number };
/** The tags with a page on the site, the busiest first. */
export function topicsOf(data: SiteData): Topic[] {
  return Object.entries(data.design.tag_pages)
    .map(([id, page]) => ({ id, name: page.name, slug: page.slug, count: page.rows.length }))
    .sort((a, b) => b.count - a.count || compareTitles(a.name, b.name) || compareText(a.id, b.id));
}

const hasTag = (node: PublishedNode, names: readonly string[]) => (node.tags ?? []).some((t) => names.includes(t));
export const featuredOf = (data: SiteData): PublishedNode[] => articlesOf(data).filter((n) => hasTag(n, FEATURED_TAGS)).sort(byUpdated);

/** 0 = no growth-stage tag, else 1 (seedling) … 3 (evergreen); the highest tag wins. */
export function maturityOf(node: PublishedNode): 0 | 1 | 2 | 3 {
  return MATURITY_TAGS.reduce<0 | 1 | 2 | 3>((best, m) => (hasTag(node, m.names) && m.level > best ? m.level : best), 0);
}

/** The `YYYY` of a `YYYY-MM-DD` day; "" for no day. */
export const yearOfDay = (day: string): string => /^\d{4}/.exec(day)?.[0] ?? "";

/** The first `count` of a list. */
export const firstOf = <T,>(list: readonly T[], count: number): T[] => list.slice(0, count);

/** The day a note is listed under in a by-year list: its date, else the day it was last updated. */
export function dayOf(node: PublishedNode, data: SiteData): string {
  return noteDate(node, data.design, data.timeZone, data.dayStartHour) ?? (node.updated_at ? isoDay(node.updated_at, data.timeZone, data.dayStartHour) : "");
}

/** Notes grouped by year of their day, newest year first, each year's notes newest day first. */
export function groupByYear(nodes: readonly PublishedNode[], data: SiteData): Array<{ year: string; notes: Array<{ node: PublishedNode; day: string }> }> {
  const years = new Map<string, Array<{ node: PublishedNode; day: string }>>();
  for (const node of nodes) {
    const day = dayOf(node, data);
    years.set(yearOfDay(day), [...(years.get(yearOfDay(day)) ?? []), { node, day }]);
  }
  return [...years]
    .map(([year, notes]) => ({ year, notes: notes.sort((a, b) => compareText(b.day, a.day) || byUpdated(a.node, b.node)) }))
    .sort((a, b) => compareText(b.year, a.year));
}

export type Footnote = { label: string; text: string };
type FootnoteTree = { type: string; identifier?: string; children?: FootnoteTree[]; position?: { start: { offset?: number }; end: { offset?: number } } };

/** The footnote definitions (`[^a]: text`) in the order the text first refers to them. Read from the
 *  renderer's own GFM tree, so a `[^x]:` inside a code block is code, not a footnote. */
export function footnotesOf(markdown: string): Footnote[] {
  const defs = new Map<string, string>();
  const order: string[] = [];
  const visit = (node: FootnoteTree) => {
    if (node.type === "footnoteDefinition") {
      const from = node.children?.[0]?.position?.start.offset;
      const to = node.position?.end.offset;
      if (node.identifier && from !== undefined && to !== undefined && !defs.has(node.identifier)) {
        defs.set(node.identifier, markdown.slice(from, to).replace(/\s*\n\s*/g, " ").trim());
      }
      return; // what a note says inside a definition is not a reference from the text
    }
    if (node.type === "footnoteReference" && node.identifier && !order.includes(node.identifier)) order.push(node.identifier);
    node.children?.forEach(visit);
  };
  visit(parseGfmTree(markdown) as FootnoteTree);
  return order.filter((id) => defs.has(id)).map((id) => ({ label: id, text: defs.get(id)! }));
}

/** The facts about the whole site. */
export function siteFacts(data: SiteData): WidgetFacts {
  const articles = articlesOf(data);
  return {
    ...NO_FACTS,
    introNote: introNoteOf(data) !== null,
    articles: articles.length,
    topics: topicsOf(data).length,
    featured: featuredOf(data).length,
    scheme: data.design.style.scheme,
    hasTree: noteTree(data.nodes).some((item) => item.children.length > 0),
  };
}

/** …plus the facts about one article. */
export function articleFacts(data: SiteData, node: PublishedNode): WidgetFacts {
  const { prev, next } = adjacentNotes(node, data.nodes, data.design);
  return {
    ...siteFacts(data),
    headings: extractTOC(node.markdown).length,
    footnotes: footnotesOf(node.markdown).length,
    backlinks: backlinksOf(node, data.nodes, data.edges).length,
    hasPrev: prev !== null,
    hasNext: next !== null,
  };
}

/** …or about one tag page. */
export function tagFacts(data: SiteData, tagId: string): WidgetFacts {
  const note = nodeOf(data, tagId);
  return { ...siteFacts(data), tagDescription: !!note && bodyAfterTitle(note.markdown, note.title).trim() !== "" };
}

/** The line under an article's title as pieces: the date (or 「更新於」 when the note shows none), the reading time, the growth stage. */
export function metaPieces(data: SiteData, node: PublishedNode): { date: string | null; dated: boolean; updated: string | null; minutes: number; maturity: 0 | 1 | 2 | 3; tags: string[] } {
  const dated = showsDate(node, data.design.date_tags);
  return {
    date: dated ? noteDate(node, data.design, data.timeZone, data.dayStartHour) : null,
    dated,
    updated: node.updated_at ? isoDay(node.updated_at, data.timeZone, data.dayStartHour) : null,
    minutes: readingMinutes(bodyAfterTitle(node.markdown, node.title)),
    maturity: maturityOf(node),
    tags: node.tags ?? [],
  };
}
