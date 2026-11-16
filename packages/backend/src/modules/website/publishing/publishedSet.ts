// Published-site data loaders: the set of notes on the site (by space, with
// each note's 「不發布」) and the live siteConfig overlay.

import { sql } from "kysely";
import { q } from "../../../db.js";
import { db } from "../../../dbKysely.js";
import { LISTED_NODE_SQL } from "../../../spine/reservedNodes.js";
import { PUBLISHED_KEY } from "../../../services/systemAttributes.js";
import { publiclyReadableNodeIds, readableNodeIdSet } from "../../../services/readPolicy.js";
import type { ActorCtx } from "../../../types.js";
import { getSiteConfig } from "../../../services/siteConfig.js";
import type { LeftOutNote } from "@onden/contract";
import { KEPT_OFF_BY_PARENT_ATTR_KEY } from "@onden/markdown";
import { liveNodeSql } from "../../../spine/nodeSql.js";

// Merge live siteConfig (from the workspace-config node) into a snapshot's
// presentation object. Live config wins over snapshot-frozen values so that
// editor-side setting changes show up without forcing a republish.
export async function overlaySiteConfig(workspaceId: string, presentation: Record<string, unknown> | null | undefined): Promise<Record<string, unknown>> {
  const cfg = await getSiteConfig(workspaceId);
  const base = (presentation ?? {}) as Record<string, unknown>;
  const baseSite   = (base.site   ?? {}) as Record<string, unknown>;
  const baseTokens = (base.tokens ?? {}) as Record<string, unknown>;

  // Parse nav back from string if attribute serialized it
  let nav: unknown = baseSite.nav ?? [];
  if (typeof cfg.nav === "string") {
    try { nav = JSON.parse(cfg.nav); } catch { /* keep base */ }
  } else if (Array.isArray(cfg.nav)) {
    nav = cfg.nav;
  }

  return {
    ...base,
    // ⑩ custom appearance — live config wins, snapshot is fallback. Only the
    // single-note HTML export reads these (css.ts buildNoteExportCss); the
    // site's pages take their look from the design.
    custom_css: cfg.custom_css ?? base.custom_css ?? "",
    site_bg: cfg.site_bg ?? base.site_bg ?? "",
    site: {
      ...baseSite,
      brand:   cfg.brand   ?? baseSite.brand   ?? "",
      tagline: cfg.tagline ?? baseSite.tagline ?? "",
      logo:    cfg.logo    ?? baseSite.logo    ?? "",
      nav,
      // SEO / chrome table-stakes — live config wins, snapshot is fallback.
      locale:             cfg.locale             ?? baseSite.locale             ?? "zh-TW",
      description:        cfg.description        ?? baseSite.description        ?? "",
      favicon:            cfg.favicon            ?? baseSite.favicon            ?? "",
      allow_indexing:     cfg.allow_indexing     ?? baseSite.allow_indexing     ?? true,
      analytics_provider: cfg.analytics_provider ?? baseSite.analytics_provider ?? "",
      analytics_id:       cfg.analytics_id       ?? baseSite.analytics_id       ?? "",
      // In-UI custom domain (CNAME). Lives in siteConfig so it PERSISTS across
      // every pages-push (the overlay re-applies it to each snapshot); the
      // pages-push effect emits a CNAME file from this value (pagesPush.ts).
      custom_domain:      cfg.custom_domain      ?? baseSite.custom_domain      ?? "",
    },
    tokens: {
      ...baseTokens,
      accent:       cfg.accent       ?? baseTokens.accent,
      font:         cfg.font         ?? baseTokens.font,
      darkMode:     cfg.darkMode     ?? baseTokens.darkMode,
    },
  };
}

// What the site shows is decided by SPACE (owner 2026-11-10, after Obsidian
// Publish's included folders, Notion's published page tree, Logseq's
// all-pages-public): a note in a space whose `publish` switch is on is on the
// site, unless one of these keeps it off —
//   • the note's own `_published` flag is 'false' (「不發布」, the owner's
//     exception; it wins over the space);
//   • it is blank: no text, no note under it and nothing kept beside the text
//     (ink, a sketch: any attribute that is not `_` bookkeeping), so an empty
//     page never goes out;
//   • it is an article saved from a feed (source_type 'rss'): someone else's
//     writing does not go public because of where it was saved.
// `_published` 'true' brings a blank note or a saved article on anyway; in a
// space that does not publish it does nothing (leftOutNotes says so). Hidden
// notes, tag definitions and system machinery are never pages.
//
// CHOKEPOINT: publishable ⊆ publicly-readable (readPolicy.publiclyReadableNodeIds,
// the space switch). The snapshot builder, the served site's takedown filter
// (servedSite.applyTakedown), a note's site status and the media gate all call
// publishedNodeIds, so none of them can drift from this rule.

/** The note's `_published` flag, joined as `flag` (NULL when it has none). */
const FLAG_JOIN = (alias: string) =>
  `LEFT JOIN node_attributes flag ON flag.node_id = ${alias}.id AND flag.key = '${PUBLISHED_KEY}'`;

/** Nothing on the page: no text, no note under it (a PDF's pages and a board's
 *  cards are notes under it), nothing kept beside the text. */
const BLANK_SQL = (alias: string) => `(COALESCE(${alias}.markdown, '') !~ '\\S'
  AND NOT EXISTS (SELECT 1 FROM content_nodes child WHERE child.parent_id = ${alias}.id AND ${liveNodeSql("child")})
  AND NOT EXISTS (SELECT 1 FROM node_attributes kept WHERE kept.node_id = ${alias}.id AND kept.key NOT LIKE '\\_%'))`;

/** Why a note the space would publish stays off by default, or NULL. */
const KEPT_OFF_SQL = (alias: string) => `CASE WHEN ${alias}.source_type = 'rss' THEN 'saved_article'
  WHEN ${BLANK_SQL(alias)} THEN 'blank' END`;

/** A page the site can have at all: live, shown, a note or board (not a tag
 *  definition or system machinery). */
const PAGE_SQL = (alias: string) => `${alias}.hidden = false AND ${liveNodeSql(alias)} AND ${LISTED_NODE_SQL(alias)}`;

export async function publishedNodeIds(workspaceId: string): Promise<Set<string>> {
  const r = await q<{ id: string }>(
    `SELECT n.id FROM content_nodes n ${FLAG_JOIN("n")}
      WHERE n.workspace_id = $1 AND ${PAGE_SQL("n")}
        AND (flag.value = 'true' OR (flag.value IS DISTINCT FROM 'false' AND ${KEPT_OFF_SQL("n")} IS NULL))`,
    [workspaceId],
  );
  const publicReadable = await publiclyReadableNodeIds(workspaceId);
  return new Set(r.rows.map((row) => row.id).filter((id) => publicReadable.has(id)));
}

/** Of `ids`, the notes that marking 「發布」 (`_published` 'true') would NOT put
 *  on the site, with why: `hidden` (never a page), `space_not_published` (its
 *  space's switch is off, or the space is not the owner's to publish), or
 *  `not_a_page` (trashed, a tag definition, system machinery). The rule is
 *  publishedNodeIds's own: PAGE_SQL, then publiclyReadableNodeIds; the flag
 *  itself does not matter, since 'true' overrides blank and saved-article. */
export async function blockedFromSite(workspaceId: string, ids: readonly string[]): Promise<Map<string, "hidden" | "space_not_published" | "not_a_page">> {
  const pages = await sql<{ id: string; hidden: boolean }>`
    SELECT n.id, n.hidden FROM content_nodes n
     WHERE n.workspace_id = ${workspaceId} AND n.id = ANY(${[...ids]}::uuid[])
       AND ${sql.raw(liveNodeSql("n"))} AND ${sql.raw(LISTED_NODE_SQL("n"))}`.execute(db);
  const page = new Map(pages.rows.map((r) => [r.id, r]));
  const publicReadable = await publiclyReadableNodeIds(workspaceId);
  const blocked = new Map<string, "hidden" | "space_not_published" | "not_a_page">();
  for (const id of ids) {
    const row = page.get(id);
    if (!row) blocked.set(id, "not_a_page");
    else if (row.hidden) blocked.set(id, "hidden");
    else if (!publicReadable.has(id)) blocked.set(id, "space_not_published");
  }
  return blocked;
}

/** The notes publishedNodeIds leaves out that the owner may want to know
 *  about, among those `actor` can read (the owner is not told the titles of
 *  another member's private notes): one marked 「發布」 that is hidden or in a
 *  space that does not publish, and, in a space that publishes, one kept off —
 *  by its own 「不發布」, blank, or a saved article. */
export async function leftOutNotes(workspaceId: string, actor: ActorCtx | null): Promise<LeftOutNote[]> {
  if (!actor) return [];
  const rows = await q<{
    id: string; title: string; hidden: boolean; flag: string | null; by_parent: boolean; kept_off: "blank" | "saved_article" | null;
    space_publishes: boolean; space_id: string | null; kind: "personal" | "shared"; is_default: boolean | null; name: string | null;
  }>(
    `SELECT n.id, n.title, n.hidden, flag.value AS flag,
            EXISTS (SELECT 1 FROM node_attributes mark WHERE mark.node_id = n.id AND mark.key = '${KEPT_OFF_BY_PARENT_ATTR_KEY}' AND mark.value = 'true') AS by_parent,
            ${KEPT_OFF_SQL("n")} AS kept_off,
            COALESCE(s.capabilities->>'publish' = 'true' AND s.deleted_at IS NULL, false) AS space_publishes,
            s.id::text AS space_id, s.kind, s.is_default, s.name
       FROM content_nodes n ${FLAG_JOIN("n")} LEFT JOIN spaces s ON s.id = n.space_id
      WHERE n.workspace_id = $1 AND ${liveNodeSql("n")} AND ${LISTED_NODE_SQL("n")}
        AND COALESCE(s.kind, 'shared') <> 'system'
        AND (flag.value = 'true' OR (s.capabilities->>'publish' = 'true' AND n.hidden = false))
      ORDER BY n.created_at ASC, n.id ASC`,
    [workspaceId],
  );
  const published = await publishedNodeIds(workspaceId);
  const candidates = rows.rows.filter((row) => !published.has(row.id));
  if (candidates.length === 0) return [];
  const readable = await readableNodeIdSet(actor, workspaceId);
  return candidates.filter((row) => readable.has(row.id)).map((row) => ({
    node_id: row.id,
    title: row.title,
    reason: row.hidden ? "hidden" as const
      : !row.space_publishes ? "space_not_published" as const
      : row.flag === "false" ? (row.by_parent ? "kept_off_by_parent" as const : "kept_off" as const)
      : row.kept_off ?? "kept_off" as const,
    space: row.space_id ? { id: row.space_id, kind: row.kind, is_default: row.is_default === true, name: row.name ?? "" } : null,
  }));
}

/** A slug is unique only within its space, so two published notes can share
 *  one, and the site routes pages by slug. The note in the default space keeps
 *  it; any other gets `<slug>-<first 6 of its id>`, counted on (`-2`, `-3` …, as
 *  services/nodes.ts uniqueSlug does) while that address is another page's.
 *  Rewrites `slug` in place. */
export async function uniquePublishedSlugs(rows: Array<{ id: string; slug: string }>): Promise<void> {
  const bySlug = new Map<string, Array<{ id: string; slug: string }>>();
  for (const row of rows) bySlug.set(row.slug, [...(bySlug.get(row.slug) ?? []), row]);
  const clashing = [...bySlug.values()].filter((group) => group.length > 1).flat();
  if (clashing.length === 0) return;
  const inDefault = new Set((await q<{ id: string }>(
    `SELECT n.id::text FROM content_nodes n JOIN spaces s ON s.id = n.space_id AND s.is_default
      WHERE n.id = ANY($1::uuid[])`, [clashing.map((row) => row.id)],
  )).rows.map((row) => row.id));
  const taken = new Set(rows.map((row) => row.slug));
  for (const group of bySlug.values()) {
    if (group.length < 2) continue;
    const keeper = group.find((row) => inDefault.has(row.id)) ?? group[0]!;
    for (const row of group) {
      if (row === keeper) continue;
      const base = `${row.slug}-${row.id.slice(0, 6)}`;
      let slug = base;
      for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
      taken.add(slug);
      row.slug = slug;
    }
  }
}
