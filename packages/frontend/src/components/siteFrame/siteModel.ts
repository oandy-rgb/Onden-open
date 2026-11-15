// The published site's data, shaped for the pages: one `readSiteData` turns the
// `/api/site` snapshot into what the home, article and tag pages draw, and the
// small pure helpers below (adjacent notes, the note tree, backlinks, the date
// rule) are what the article frame switches use. No React here.
import { validateDesign, type FrozenDesign, type SiteDesign, type SiteRow, type SiteTagPage } from "@onden/site";
import {
  compareChildren, diagramsBySource, mermaidSources, usesSteps, fenceInfoWord, fenceScanner, openingFenceInfo, extractBlock, extractSection, firstImage, linkPlaces, noteSummary, plainExcerpt, plainText, readingMinutes, drawnWikilinks,
  servedBlockPage, servedLinkTarget, sitePathFor, type ContextPiece, type DiagramLayout,
} from "@onden/markdown";
import { dateIdAt } from "../../lib/localDate";
import { siteRedirectsOf } from "../../lib/siteRedirects";
import { withBlockIds } from "../../lib/publishedNode";
import { makeT, type PublishedEdge, type PublishedNode, type SiteChrome } from "../templates";

/** The v3 design as `/api/site` serves it: the saved design plus what was
 *  fixed at publish time (rows by Puck component of the old home page, rows by tag, tag names). */
export type SiteDesignData = SiteDesign & Pick<FrozenDesign, "resolved" | "tag_pages" | "tag_names">;

export type SiteData = {
  title: string;
  homeNodeId: string | null;
  nodes: PublishedNode[];
  edges: PublishedEdge[];
  site: SiteChrome & Record<string, unknown>;
  timeZone?: string;
  /** The hour (0–6) the workspace's day starts at: a page made at 02:00 with 4 is dated the day before. */
  dayStartHour?: number;
  design: SiteDesignData;
  /** Diagrams laid out at publish time, by the text of their ```mermaid block; each checked again here. */
  diagrams: ReadonlyMap<string, DiagramLayout>;
  /** Old addresses of pages served now → their current address (`/site/<old>/` → `/site/<slug>/`,
   *  tag pages under `/site/tag/`). The server keeps only pages still on the site (GAP-240). */
  redirects: ReadonlyMap<string, string>;
};

export type SiteSnapshot = {
  title?: string;
  home_node_id?: string | null;
  payload?: { nodes?: PublishedNode[]; edges?: PublishedEdge[]; presentation?: Record<string, unknown>; diagrams?: unknown; site_redirects?: unknown };
};


const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `/api/site` → page data. A snapshot without a v3 (or v2) design (a workspace that
 *  never made one) gets the default design: publishing never needs a layout. */
export function readSiteData(snapshot: SiteSnapshot): SiteData {
  const payload = snapshot.payload ?? {};
  const presentation = payload.presentation ?? {};
  const site = (isObj(presentation.site) ? presentation.site : {}) as SiteData["site"];
  const nodes = payload.nodes ?? [];
  const homeNodeId = snapshot.home_node_id ?? null;
  const raw = isObj(presentation.design) ? presentation.design : {};
  const { design } = validateDesign(raw);
  // validateDesign keeps only the design itself; the publish-time rows ride next to it.
  const rowsByKey = <T,>(v: unknown): Record<string, T> => (isObj(v) ? (v as Record<string, T>) : {});
  const full: SiteDesignData = {
    ...design,
    resolved: rowsByKey<SiteRow[]>(raw.resolved),
    tag_pages: rowsByKey<SiteTagPage>(raw.tag_pages),
    tag_names: rowsByKey<string>(raw.tag_names),
  };
  return {
    title: snapshot.title ?? "Onden",
    homeNodeId,
    nodes,
    edges: payload.edges ?? [],
    site,
    timeZone: typeof presentation.time_zone === "string" ? presentation.time_zone : undefined,
    dayStartHour: typeof presentation.day_start_hour === "number" ? presentation.day_start_hour : undefined,
    design: full,
    diagrams: diagramsBySource(payload.diagrams),
    redirects: siteRedirectsOf(payload.site_redirects),
  };
}

/** The address of a published note, read off the served pages (sitePathFor). */
export function notePath(nodes: readonly PublishedNode[], slug: string): string {
  const node = nodes.find((n) => n.slug === slug);
  return (node && sitePathFor(node.id, nodes)) ?? `/site/${slug}`;
}

export const tagPath = (slug: string): string => `/site/tag/${slug}/`;

/** The tag page for a tag name (tags on a published note are names). */
export function tagPageByName(design: SiteDesignData, name: string): { id: string; page: SiteTagPage } | null {
  for (const [id, page] of Object.entries(design.tag_pages)) if (page.name === name) return { id, page };
  return null;
}

export function tagPageBySlug(design: SiteDesignData, slug: string): { id: string; page: SiteTagPage } | null {
  for (const [id, page] of Object.entries(design.tag_pages)) if (page.slug === slug) return { id, page };
  return null;
}

/** Only notes carrying one of the date tags show a date (design doc §2.9). */
export function showsDate(node: Pick<PublishedNode, "tags">, dateTags: readonly string[]): boolean {
  return (node.tags ?? []).some((t) => dateTags.includes(t));
}

/** The day a note is dated: the row date the backend fixed at publish when a
 *  list shows the note (so a list and its article agree), else its creation day. */
export function noteDate(node: PublishedNode, design: SiteDesignData, timeZone?: string, dayStartHour = 0): string | null {
  for (const rows of [...Object.values(design.resolved), ...Object.values(design.tag_pages).map((p) => p.rows)]) {
    const row = rows.find((r) => r.id === node.id);
    if (row?.date) return row.date;
  }
  return node.created_at ? isoDay(node.created_at, timeZone, dayStartHour) : null;
}

/** An ISO timestamp's day in the site's zone, as YYYY-MM-DD (the workspace clock, lib/localDate). */
export function isoDay(iso: string, timeZone?: string, dayStartHour = 0): string {
  try {
    return dateIdAt(new Date(iso), timeZone, dayStartHour);
  } catch {
    return iso.slice(0, 10);
  }
}

/** Previous / next note: among the siblings under the same parent first; a
 *  note with no siblings follows the order of its first tag's page. */
export function adjacentNotes(
  node: PublishedNode, nodes: readonly PublishedNode[], design: SiteDesignData,
): { prev: PublishedNode | null; next: PublishedNode | null } {
  let order: PublishedNode[] = [];
  if (node.parent_id) order = nodes.filter((n) => n.parent_id === node.parent_id).sort(compareChildren);
  if (order.length < 2) {
    order = [];
    const first = (node.tags ?? []).map((t) => tagPageByName(design, t)).find((t) => t !== null);
    if (first) order = first.page.rows.flatMap((r) => nodes.find((n) => n.id === r.id) ?? []);
  }
  const at = order.findIndex((n) => n.id === node.id);
  if (at < 0) return { prev: null, next: null };
  return { prev: order[at - 1] ?? null, next: order[at + 1] ?? null };
}

/** Where a note is mentioned by another: a sentence with the link marked, or
 *  an embed of a part of it (the quote is the start of that part). */
export type BacklinkPlace = { kind: "link"; pieces: ContextPiece[] } | { kind: "embed"; quote: string | null };
export type Backlink = { node: PublishedNode; places: BacklinkPlace[] };

/** Characters of an embedded passage a "Linked from" entry quotes. */
const EMBED_QUOTE_LENGTH = 34;

/** What an embed of a part of `target` shows, as the start of its plain text. */
function embedQuote(target: PublishedNode, embed: { blockId: string | null; heading: string | null }, nodes: readonly PublishedNode[]): string | null {
  let part: string | null = null;
  // A block the named page lost reads from the published page that holds it.
  if (embed.blockId) {
    const home = servedBlockPage(withBlockIds(target), embed.blockId, nodes.map(withBlockIds));
    part = extractBlock(home.markdown, embed.blockId, home.part_anchors ?? []);
  }
  else if (embed.heading) part = extractSection(target.markdown, embed.heading)?.replace(/^[^\n]*\n?/, "") ?? null;
  const text = part ? plainText(part) : "";
  return text ? plainExcerpt(text, EMBED_QUOTE_LENGTH) : null;
}

/** The notes that link to this one (active links only: the snapshot's edges),
 *  each with up to three places it does so. Only published notes: the edges
 *  and nodes are the served site's. */
export function backlinksOf(node: PublishedNode, nodes: readonly PublishedNode[], edges: readonly PublishedEdge[]): Backlink[] {
  const seen = new Set<string>([node.id]);
  const out: Backlink[] = [];
  for (const e of edges) {
    if (e.target_node_id !== node.id || seen.has(e.source_node_id)) continue;
    const source = nodes.find((n) => n.id === e.source_node_id);
    if (!source) continue;
    seen.add(source.id);
    const embedded = new Set(source.embeds ?? []);
    const places = linkPlaces(source.markdown, {
      isTarget: (body) => servedLinkTarget(body, nodes, source.id)?.id === node.id,
      isEmbed: (body) => embedded.has(body),
    }).map((p): BacklinkPlace => (p.kind === "link" ? p : { kind: "embed", quote: embedQuote(node, p.embed, nodes) }));
    out.push({ node: source, places });
  }
  return out;
}

// ── Link previews ───────────────────────────────────────────────────────

/** What the hover / tap card of a link to a note shows, already worded for the
 *  site's language (the script that draws it has no strings of its own). */
export type NotePreview = { title: string; meta: string; summary: string; tags: string[] };

/** The `<script type="application/json">` of an article page: the cards of the
 *  notes this page links to, by note id (the `data-note` of each such link). */
export type PagePreviews = { labels: { open: string; close: string; preview: string }; notes: Record<string, NotePreview> };

const PREVIEW_SUMMARY_LENGTH = 60;
/** A page that links to more notes than this previews the first ones. */
const PREVIEW_MAX_NOTES = 50;

/** The published notes this article links to — in its text, and the ones that
 *  link here — each once, never the article itself. */
export function previewTargetsOf(node: PublishedNode, nodes: readonly PublishedNode[], backlinks: readonly Backlink[]): PublishedNode[] {
  const found = new Map<string, PublishedNode>();
  for (const link of drawnWikilinks(node.markdown)) {
    const target = servedLinkTarget(link.body, nodes, node.id);
    if (target && target.id !== node.id) found.set(target.id, target);
  }
  for (const { node: source } of backlinks) found.set(source.id, source);
  return [...found.values()].slice(0, PREVIEW_MAX_NOTES);
}

/** The previews as the text of their `<script type="application/json">`; `<` is
 *  escaped so a title can never close the element. */
export function previewsScriptText(previews: PagePreviews): string {
  return JSON.stringify(previews).replace(/</g, "\\u003c");
}

export function pagePreviews(targets: readonly PublishedNode[], locale: string | undefined, timeZone?: string, dayStartHour = 0): PagePreviews {
  const t = makeT(locale);
  const notes: PagePreviews["notes"] = {};
  for (const n of targets) {
    const meta = [
      n.updated_at ? t("updated").replace("{date}", isoDay(n.updated_at, timeZone, dayStartHour)) : "",
      t("readingTime").replace("{n}", String(readingMinutes(n.markdown))),
    ].filter(Boolean).join(" · ");
    notes[n.id] = {
      title: n.title,
      meta,
      summary: noteSummary(n.markdown, { title: n.title, maxLen: PREVIEW_SUMMARY_LENGTH }),
      tags: n.tags ?? [],
    };
  }
  return { labels: { open: t("openNote"), close: t("closePreview"), preview: t("preview") }, notes };
}

export type TreeItem = { node: PublishedNode; children: TreeItem[] };

/** The published notes as a tree by `parent_id` (the backend clears a parent
 *  that is not itself published, so every note reaches a root). */
export function noteTree(nodes: readonly PublishedNode[]): TreeItem[] {
  const ids = new Set(nodes.map((n) => n.id));
  const kids = new Map<string | null, PublishedNode[]>();
  for (const n of nodes) {
    const key = n.parent_id && ids.has(n.parent_id) && n.parent_id !== n.id ? n.parent_id : null;
    kids.set(key, [...(kids.get(key) ?? []), n]);
  }
  const build = (parent: string | null, depth: number): TreeItem[] =>
    depth > 8 ? [] : (kids.get(parent) ?? []).sort(compareChildren).map((node) => ({ node, children: build(node.id, depth + 1) }));
  return build(null, 0);
}

/** The first image of a note's Markdown, as written (the article cover). */
export function coverImage(markdown: string): string | undefined {
  return firstImage(markdown);
}

/** Whether any published note still has a diagram the reader's browser must draw: a
 *  ```mermaid fence with no layout from publish time (`diagrams`). The pages then carry the
 *  script that does (SiteDiagrams.astro); a site whose diagrams are all drawn ships none of it. */
export function usesDiagrams(nodes: readonly Pick<PublishedNode, "markdown">[], diagrams: ReadonlyMap<string, unknown> = new Map()): boolean {
  return nodes.some((n) => {
    const markdown = n.markdown ?? "";
    const fence = fenceScanner();
    const fences = markdown.split("\n").filter((line) => fence(line) === "open" && fenceInfoWord(openingFenceInfo(line) ?? "") === "mermaid").length;
    return fences > mermaidSources(markdown).filter((source) => diagrams.has(source)).length;
  });
}

/** Whether any published note has a step-by-step figure: the pages then carry
 *  the script that plays it (SiteSteps.astro); a site without one ships none. */
export function usesStepsBlocks(nodes: readonly Pick<PublishedNode, "markdown">[]): boolean {
  return nodes.some((n) => usesSteps(n.markdown ?? ""));
}
