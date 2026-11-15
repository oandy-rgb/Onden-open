// Publish-time freezing of the home page and tag pages (design doc §5.3).
// The site never runs a query (D113): a walk over the design JSON asks the
// database once and stores the rows it lists. No rendering here — the
// frontend draws the design from these rows.
//
// What is listed is decided in ONE place, for every surface that reads the
// design: only PUBLISHED notes are rows. The saved view runs as the publisher
// (the owner chose it for the site) narrowed to the published ids, so a view
// can never name a note the site does not serve.

import { defaultDesign, usesLegacyHome, validateDesign, walkHome, type FrozenDesign, type PuckComponentData, type SiteDesign, type SiteRow, type SiteTagPage, type ViewKind } from "@onden/site";
import { compareText, compareTitles } from "@onden/markdown";
import { q } from "../../../db.js";
import type { ActorCtx } from "../../../types.js";
import { LISTED_NODE_SQL } from "../../../spine/reservedNodes.js";
import { memberTagIds } from "../../../services/tagHierarchy.js";
import { executeTagView, listTagViews } from "../../../services/tagViews.js";
import { getChromeBlocks } from "../../../services/siteConfig.js";
import { inertUnpublishedWikilinks, siteShowsTagSql, type PublishedName } from "./redaction.js";
import { TAG_PAGE_ROWS_MAX } from "@onden/markdown";
import { scrubHomeNotes, siteRowOf, tagSlugs, viewKindFor } from "./siteRows.js";

/** A published note as the freeze reads it: the candidate's node, already
 *  redacted and with its served slug. */
export type FreezeNode = { id: string; title: string; slug: string; markdown: string; created_at?: unknown };

/** A note component whose note is not in this publish: reported to the
 *  preview, never stored (its title is not the site's to know). */
export type UnpublishedRef = { componentId: string; noteId: string; title: string };

/** The design saved in the studio (the config node's chrome) as v3 (a stored v2 design is moved by
 *  validateDesign), or null when none is saved or it is older than v2 (an old chrome is never rendered). */
export async function savedDesign(workspaceId: string): Promise<SiteDesign | null> {
  const chrome = await getChromeBlocks(workspaceId);
  if (!chrome || typeof chrome !== "object" || ![2, 3].includes((chrome as { v?: number }).v ?? 0)) return null;
  return validateDesign(chrome).design;
}

type FreezeInput = {
  workspaceId: string;
  /** The publisher: the saved view runs as them. Null: no saved view runs (members only). */
  actor: ActorCtx | null;
  /** The design to freeze: the saved one, else the default. */
  design: SiteDesign;
  nodes: readonly FreezeNode[];
  /** For the link rule on field values (redaction.publishedNames). */
  names: readonly PublishedName[];
};

type Listing = { rows: SiteRow[]; viewKind: ViewKind };
const byNewest = (created: ReadonlyMap<string, number>) => (a: SiteRow, b: SiteRow) =>
  (created.get(b.id) ?? 0) - (created.get(a.id) ?? 0) || compareText(a.id, b.id);

export async function freezeDesign(input: FreezeInput): Promise<{ design: FrozenDesign; unpublishedRefs: UnpublishedRef[] }> {
  const { workspaceId, actor, nodes, names } = input;
  const design = structuredClone(input.design);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const publishedIds = [...byId.keys()];
  const created = new Map(nodes.map((n) => [n.id, createdMs(n.created_at)]));
  const newest = byNewest(created);

  // The tags the site shows (siteShowsTagSql), by id.
  const shown = new Map((await q<{ id: string; title: string }>(
    `SELECT t.id::text AS id, t.title FROM content_nodes t WHERE t.workspace_id = $1 AND ${siteShowsTagSql("t")}
      ORDER BY t.title ASC, t.id ASC`, [workspaceId],
  )).rows.map((t) => [t.id, t.title]));

  const asRow = (id: string, fields: Record<string, string | null> = {}): SiteRow | null => {
    const note = byId.get(id);
    if (!note) return null;
    const safe = Object.fromEntries(Object.entries(fields).map(([key, value]) =>
      [key, typeof value === "string" ? inertUnpublishedWikilinks(value, names) : value]));
    return siteRowOf(note, safe);
  };

  /** The published members of `tagId` (the tag, its child tags and the tags that extend it), newest first. */
  const members = async (tagId: string): Promise<SiteRow[]> => {
    const found = await q<{ id: string }>(
      `SELECT DISTINCT n.id::text AS id FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id
        WHERE nt.tag_id = ANY($1::uuid[]) AND n.id = ANY($2::uuid[]) AND ${LISTED_NODE_SQL("n")}`,
      [await memberTagIds(workspaceId, tagId), publishedIds],
    );
    return found.rows.map((r) => asRow(r.id)).filter((r): r is SiteRow => r !== null).sort(newest);
  };

  /** The rows of saved view `viewId` over published notes (the view's own order); null when it does not run. */
  const viewListing = async (tagId: string, viewId: string): Promise<Listing | null> => {
    if (!actor) return null;
    const exec = await executeTagView(actor, workspaceId, tagId, viewId, { limit: 500, offset: 0 }, publishedIds);
    if (!exec) return null;
    const rows = exec.rows.map((r) => asRow(r.id, r.attributes)).filter((r): r is SiteRow => r !== null);
    return { rows, viewKind: viewKindFor(exec.view.layout) };
  };

  const firstViewId = async (tagId: string): Promise<string> => {
    if (!actor) return "";
    const views = await listTagViews(actor, workspaceId, tagId) as Array<{ id?: unknown }> | null;
    return typeof views?.[0]?.id === "string" ? views[0].id : "";
  };

  const listings = new Map<string, Promise<Listing | null>>();
  /** The tag's listing for `viewId` ("" = its first saved view, else the members); null when its tag is not shown. */
  const listing = (tagId: string, viewId: string): Promise<Listing | null> => {
    const key = `${tagId}\n${viewId}`;
    let found = listings.get(key);
    if (!found) {
      found = (async () => {
        if (!shown.has(tagId)) return null;
        const id = viewId || await firstViewId(tagId);
        return (id ? await viewListing(tagId, id) : null) ?? { rows: await members(tagId), viewKind: "list" as const };
      })();
      listings.set(key, found);
    }
    return found;
  };

  const resolved: Record<string, SiteRow[]> = {};
  const mentioned = new Set<string>();
  const unpublished: Array<{ componentId: string; noteId: string }> = [];
  const components: PuckComponentData[] = [];
  // Only the home page that is drawn is frozen: the widgets list from the published notes themselves.
  if (usesLegacyHome(design)) walkHome(design.legacy_home!, (component) => components.push(component));
  for (const component of components) {
    const props = component.props;
    const tagId = typeof props.tagId === "string" ? props.tagId : "";
    const limit = typeof props.limit === "number" ? props.limit : 6;
    if (component.type === "note") {
      if (typeof props.noteId === "string" && props.noteId && !byId.has(props.noteId)) {
        unpublished.push({ componentId: props.id, noteId: props.noteId });
      }
    } else if (component.type === "tag_view") {
      const viewId = typeof props.viewId === "string" ? props.viewId : "";
      const found = tagId ? await listing(tagId, viewId) : null;
      const sorted = [...(found?.rows ?? [])];
      if (props.sort === "title") sorted.sort((a, b) => compareTitles(a.title, b.title) || compareText(a.id, b.id));
      else sorted.sort(newest);
      resolved[props.id] = sorted.slice(0, limit);
      if (found) mentioned.add(tagId);
      if (!props.viewKind) props.viewKind = found?.viewKind ?? "list";
    } else if (component.type === "timeline") {
      const found = tagId && shown.has(tagId) ? await members(tagId) : [];
      resolved[props.id] = found.slice(0, limit);
      if (found.length > 0) mentioned.add(tagId);
    }
  }

  // A page for every shown tag with a published member (applied directly);
  // its rows follow the tag's first saved view, which may reach members of
  // its child tags too.
  const withMembers = new Set((await q<{ id: string }>(
    `SELECT DISTINCT nt.tag_id::text AS id FROM node_tags nt WHERE nt.node_id = ANY($1::uuid[])`, [publishedIds],
  )).rows.map((r) => r.id));
  const pageRows = new Map<string, Listing>();
  for (const tagId of shown.keys()) {
    if (!withMembers.has(tagId)) continue;
    const found = await listing(tagId, "");
    if (found && found.rows.length > 0) pageRows.set(tagId, { ...found, rows: found.rows.slice(0, TAG_PAGE_ROWS_MAX) });
  }
  const slugs = tagSlugs([...pageRows.keys()].map((id) => ({ id, name: shown.get(id)! })));
  const tagPages: Record<string, SiteTagPage> = {};
  for (const [tagId, page] of pageRows) {
    tagPages[tagId] = { name: shown.get(tagId)!, slug: slugs.get(tagId)!, viewKind: page.viewKind, rows: page.rows };
    mentioned.add(tagId);
  }
  const tagNames = Object.fromEntries([...mentioned].filter((id) => shown.has(id)).map((id) => [id, shown.get(id)!]));

  const titles = unpublished.length === 0 ? new Map<string, string>() : new Map((await q<{ id: string; title: string }>(
    `SELECT id::text AS id, title FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
    [workspaceId, [...new Set(unpublished.map((u) => u.noteId))]],
  )).rows.map((r) => [r.id, r.title]));

  return {
    design: {
      v: 3, preset: design.preset, boxes: design.boxes, style: design.style, css: design.css, date_tags: design.date_tags, reading: design.reading,
      legacy_home: usesLegacyHome(design) ? scrubHomeNotes(design.legacy_home, new Set(byId.keys())) : null,
      resolved, tag_pages: tagPages, tag_names: tagNames,
    },
    unpublishedRefs: unpublished.map((u) => ({ ...u, title: titles.get(u.noteId) ?? "" })),
  };
}

function createdMs(value: unknown): number {
  const at = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at.getTime() : 0;
}
