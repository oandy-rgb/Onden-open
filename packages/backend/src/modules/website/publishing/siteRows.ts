// The rows the site's home page and tag pages list, and the takedown of a
// frozen design. Pure: no database, so the row rules and the takedown are
// tested alone (siteRows.test.ts). The queries that choose which notes are
// rows live in frozenDesign.ts.
//
// A row is built from a PUBLISHED note's REDACTED markdown (snapshot.ts runs
// redactPayloadNodes first), so an excerpt can never name a private note.

import { bodyAfterTitle, firstImage, noteSummary, slugify, isSystemAttr } from "@onden/markdown";
import { localDayId } from "../../../localDay.js";
import { siteViewKindOf } from "../../../services/viewLayouts.js";
import { walkHome, type FrozenDesign, type PuckData, type SiteRow, type ViewKind } from "@onden/site";

export const EXCERPT_MAX = 140;

/** The kind a home-page component draws a saved view as: gallery → cards,
 *  table → table, everything else (list, calendar, kanban) → list. */
export function viewKindFor(layout: string | null | undefined): ViewKind {
  return siteViewKindOf(layout) ?? "list";
}

/** `url` when a published page may show it as an image, else "": only
 *  `https://`, `http://` and a site-relative `/…` pass (not `//host`). */
export function safeImageUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) return trimmed;
  if (/^\/(?!\/)[^\s]*$/.test(trimmed)) return trimmed;
  return "";
}

/** The first image of `markdown` a page may show (`firstImage`, then `safeImageUrl`), or "". */
export function firstImageUrl(markdown: string): string {
  const url = firstImage(markdown, (candidate) => safeImageUrl(candidate) !== "");
  return url === undefined ? "" : safeImageUrl(url);
}

/** The first paragraph that has prose, as plain text of at most EXCERPT_MAX
 *  characters ("…" included); "" for a note with none. noteSummary is the
 *  one rule for "a note in one line" (headings, code, tables, link URLs and
 *  emphasis dropped); it is run per paragraph so only the first counts. */
export function excerptOf(markdown: string, title: string): string {
  for (const paragraph of bodyAfterTitle(markdown, title).split(/\n\s*\n/)) {
    const text = noteSummary(paragraph, { maxLen: EXCERPT_MAX - 1 });
    if (text) return text;
  }
  return "";
}

/** A `YYYY-MM-DD` for a created_at as the database client gives it (Date or string): the day on the workspace clock
 *  (localDay.ts), the same cut the site's own dates are shown in. */
export function isoDateOf(createdAt: unknown): string {
  const at = createdAt instanceof Date ? createdAt : typeof createdAt === "string" ? new Date(createdAt) : null;
  return at && !Number.isNaN(at.getTime()) ? localDayId(at) : "";
}

/** One published note as a row. `fields` are the view's visible fields (already
 *  limited to what the owner chose; `_`-prefixed system keys never go out). */
export function siteRowOf(
  note: { id: string; title: string; slug: string; markdown: string; created_at?: unknown },
  fields: Record<string, string | null> = {},
): SiteRow {
  return {
    id: note.id,
    title: note.title,
    slug: note.slug,
    date: isoDateOf(note.created_at),
    fields: Object.fromEntries(Object.entries(fields).filter(([key]) => !isSystemAttr(key))),
    image: firstImageUrl(note.markdown),
    excerpt: excerptOf(note.markdown, note.title),
  };
}

/** Tag URL slugs: `slugify(name)`, a numeric suffix (-2, -3 …) for a clash.
 *  Tags are taken in the given order, so the same tags get the same slugs. */
export function tagSlugs(tags: ReadonlyArray<{ id: string; name: string }>): Map<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const tag of tags) {
    const base = slugify(tag.name, "tag");
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    out.set(tag.id, slug);
  }
  return out;
}

// ── Takedown ────────────────────────────────────────────────────────────────

/** `home` with every note component that names an unpublished note emptied
 *  (noteId ""), so the served site never carries that note's id. The renderer
 *  draws an empty note component as nothing. Returns a new home; a home that
 *  is not Puck data comes back as it was. */
export function scrubHomeNotes<H>(home: H, publishedIds: ReadonlySet<string>): H {
  if (!home || typeof home !== "object" || !Array.isArray((home as { content?: unknown }).content)) return home;
  const out = structuredClone(home) as unknown as PuckData;
  walkHome(out, (component) => {
    const noteId = component.props.noteId;
    if (component.type === "note" && typeof noteId === "string" && noteId && !publishedIds.has(noteId)) component.props.noteId = "";
  });
  return out as unknown as H;
}

/** The site settings' nav links that name a note on the site. A link to a note the site does not serve
 *  would carry that note's id (the renderer would draw a dead link), so it goes; links without a note
 *  (`nodeId` not a string) stay. Returns a new site; a site without a nav comes back as it was. */
export function scrubNavLinks<S extends { nav?: unknown }>(site: S, publishedIds: ReadonlySet<string>): S {
  if (!Array.isArray(site.nav)) return site;
  const nav = (site.nav as Array<{ nodeId?: unknown }>).filter((link) =>
    typeof link?.nodeId !== "string" || link.nodeId === "" || publishedIds.has(link.nodeId));
  return { ...site, nav };
}

/** The pages the site serves now, as takedown reads them: each page's title and
 *  its markdown as served (already redacted against the pages still on the
 *  site), and the rule that makes a [[link]] in typed text inert against them
 *  (redaction.ts inertUnpublishedWikilinks). */
export type ServedPages = {
  pages: ReadonlyMap<string, { title: string; markdown: string }>;
  redact: (text: string) => string;
};

/** `row` with its excerpt made from the served page and its field values made inert again. */
function remade(row: SiteRow, served: ServedPages): SiteRow {
  const page = served.pages.get(row.id);
  return {
    ...row,
    ...(page ? { excerpt: excerptOf(page.markdown, page.title) } : {}),
    fields: Object.fromEntries(Object.entries(row.fields ?? {}).map(([key, value]) => [key, typeof value === "string" ? served.redact(value) : value])),
  };
}

/** `design` minus what the live workspace has taken down (servedSite.applyTakedown):
 *  rows of notes no longer published, an excerpt and field values of a row that
 *  stays made again from the served page (a link to a note taken down since
 *  would otherwise keep its title), tag pages whose tag is no longer shown
 *  or has no rows left, and home note components naming a note no longer
 *  published (scrubHomeNotes). Returns a new design; `shownTagIds` are the
 *  tags the site shows now (siteShowsTagSql). */
export function takeDownDesign<T extends Partial<FrozenDesign>>(
  design: T, publishedIds: ReadonlySet<string>, shownTagIds: ReadonlySet<string>, served: ServedPages,
): T {
  const keep = (rows: unknown): SiteRow[] => (Array.isArray(rows) ? rows as SiteRow[] : [])
    .filter((row) => publishedIds.has(row?.id)).map((row) => remade(row, served));
  const resolved = Object.fromEntries(Object.entries(design.resolved ?? {}).map(([id, rows]) => [id, keep(rows)]));
  const tagPages = Object.fromEntries(Object.entries(design.tag_pages ?? {})
    .map(([tagId, page]) => [tagId, { ...page, rows: keep(page?.rows) }] as const)
    .filter(([tagId, page]) => shownTagIds.has(tagId) && page.rows.length > 0));
  // A name of a tag that is no longer shown goes too: the site names only tags readers can see.
  const tagNames = Object.fromEntries(Object.entries(design.tag_names ?? {}).filter(([tagId]) => shownTagIds.has(tagId)));
  const home = "legacy_home" in design && design.legacy_home ? { legacy_home: scrubHomeNotes(design.legacy_home, publishedIds) } : {};
  return { ...design, ...home, resolved, tag_pages: tagPages, tag_names: tagNames };
}
