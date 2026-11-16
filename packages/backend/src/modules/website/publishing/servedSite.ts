// The published site, as every surface serves it: GET /api/site, the zip
// export (GET /api/export-static) and the static host push (pagesPush.ts). All
// of them read the latest publish snapshot minus takedowns (W38a,
// docs/architecture/site-render-model.md): what the site shows is fixed when
// the owner presses Publish, and the live workspace can only REMOVE from it —
// a note unpublished, trashed or made private, a tag hidden (its chips and its
// tag page). A note published after the snapshot, an edited body or a changed
// setting waits for the next publish — and so does a note that was taken down
// and qualifies again (takenDown.ts).

import { sha256Hex } from "../../../utils.js";
import { aliasLinksBySlug, diagramsBySource, mediaUrl, sitePathFor, type ServedPage } from "@onden/markdown";
import { pool, q } from "../../../db.js";
import { dayClock } from "../../../localDay.js";
import { overlaySiteConfig, publishedNodeIds } from "./publishedSet.js";
import { servedNodeIds } from "./takenDown.js";
import { storedNote } from "./latestSnapshot.js";
import { staticSiteUrl } from "./cname.js";
import { findConfigNodeId } from "../../../services/siteConfig.js";
import { anonymousMediaOwners } from "../../../services/mediaOwners.js";
import { keepServedQueryRows, keepShownTags, publishedAliases, publishedNames, inertUnpublishedWikilinks, siteShowsTagSql, redactPayloadNodes, scrubUnpublishedParents } from "./redaction.js";
import { buildSingleNoteHtml } from "./singleNoteHtml.js";
import type { Manifest } from "./types.js";
import { serveDrawingEmbeds } from "./drawingEmbeds.js";
import { serveHandwritingPages } from "./handwritingPages.js";
import { siteHomeFor } from "./siteHome.js";
import { freezeQueryBlocks } from "./queryBlocks.js";
import type { FrozenDesign } from "@onden/site";
import { scrubNavLinks, takeDownDesign } from "./siteRows.js";
import type { ActorCtx } from "../../../types.js";
import { keepServedDiagrams } from "./diagrams.js";
import { servedRedirects } from "./siteRedirects.js";
import { withFormerIds } from "../../../services/idRewrites.js";
import type { ServedSite } from "@onden/contract";

type SiteNode = { id?: string; title?: unknown; slug?: unknown; markdown?: unknown; parent_id?: unknown };
type SiteEdge = { source_node_id?: string; target_node_id?: string };

/** A snapshot payload minus what the live workspace has taken down since it
 *  was built: nodes no longer published (publishedNodeIds: in a space that publishes, not
 *  kept off, hidden or trashed), the edges touching them, and the [[links]] that now
 *  point out of the site. Only removes; returns a new row. */
async function applyTakedown<T extends { home_node_id?: string | null; payload?: Record<string, unknown> | null }>(
  workspaceId: string, row: T, allowed: ReadonlySet<string>,
): Promise<T> {
  // `row` was read for this request (loadServedSite), so its payload is ours to edit.
  const payload: Record<string, unknown> = { ...(row.payload ?? {}) };
  delete payload.taken_down; // bookkeeping (takenDown.ts): `allowed` already excludes those notes
  // Snapshots built before W38a stored the Studio's presentation without the
  // site settings; they keep reading the live settings, on every request as
  // before W38a, until the next publish freezes them.
  if (payload.settings_frozen !== true) {
    payload.presentation = await overlaySiteConfig(workspaceId, payload.presentation as Record<string, unknown> | undefined);
  }
  const nodes = (Array.isArray(payload.nodes) ? payload.nodes as SiteNode[] : [])
    .filter((n) => n.id != null && allowed.has(n.id));
  scrubUnpublishedParents(nodes);
  const aliases = await publishedAliases(nodes.map((n) => n.id));
  redactPayloadNodes(nodes, undefined, aliases);
  serveDrawingEmbeds(nodes); // ![[drawing]] → its frozen picture, if still on the site
  serveHandwritingPages(nodes); // a handwriting note's own pages, after its text
  await keepShownTags(nodes); // a tag hidden or removed since leaves its chips
  keepServedQueryRows(nodes, aliases); // a frozen query list names served pages only (D113)
  payload.nodes = nodes;
  // A diagram holds its block's text: it goes with the page that showed it.
  if ("diagrams" in payload) payload.diagrams = keepServedDiagrams(payload.diagrams, nodes);
  if (payload.presentation && typeof payload.presentation === "object") {
    const presentation = payload.presentation as { site?: { nav?: unknown }; design?: Partial<FrozenDesign> };
    const servedIds = new Set(nodes.map((n) => n.id as string));
    // The site settings are frozen with the snapshot: a nav link to a note taken down since still names it.
    if (presentation.site && typeof presentation.site === "object") presentation.site = scrubNavLinks(presentation.site, servedIds);
    // The frozen home page and tag pages list only notes still on the site and
    // tags still shown, and its note components name only notes still on the
    // site: a takedown is a privacy guarantee that cannot wait for the next publish.
    if (presentation.design && typeof presentation.design === "object") {
      const shownTags = new Set((await q<{ id: string }>(
        `SELECT t.id::text AS id FROM content_nodes t WHERE t.workspace_id = $1 AND ${siteShowsTagSql("t")}`, [workspaceId],
      )).rows.map((r) => r.id));
      const names = publishedNames(nodes, aliases);
      const pages = new Map(nodes.map((n) => [n.id as string, { title: String(n.title ?? ""), markdown: String(n.markdown ?? "") }]));
      presentation.design = takeDownDesign(presentation.design, servedIds, shownTags, {
        pages, redact: (text) => inertUnpublishedWikilinks(text, names),
      });
    }
  }
  // Old addresses go to pages served now only, by their current address; the
  // stored pairs (with ids of notes taken down since) never leave (siteRedirects.ts).
  const design = (payload.presentation as { design?: { tag_pages?: unknown } } | undefined)?.design;
  const redirects = servedRedirects(payload.redirects, nodes, design?.tag_pages);
  delete payload.redirects;
  if (redirects.length > 0) payload.site_redirects = redirects;
  payload.edges = (Array.isArray(payload.edges) ? payload.edges as SiteEdge[] : []).filter((e) =>
    e.source_node_id != null && e.target_node_id != null && allowed.has(e.source_node_id) && allowed.has(e.target_node_id));

  // The home the snapshot froze while it is still on the site, else the one
  // rule every surface uses (siteHome.ts): row and payload always agree.
  const homeId = await siteHomeFor(
    workspaceId, nodes, row.home_node_id ?? (payload.home_node_id as string | null | undefined) ?? null,
  );
  payload.home_node_id = homeId;
  return { ...row, home_node_id: homeId, payload };
}

/** The served site: the latest snapshot minus takedowns. A workspace never
 *  published serves an empty site — nothing is public before the first
 *  Publish. */
export async function loadServedSite(workspaceId: string): Promise<ServedSite> {
  // The snapshot is read already cut down to the notes (and edges between
  // them) still on the site: the payload of a large site is tens of MB, and
  // parsing all of it in Node for every request — to throw most away — blocked
  // the event loop for seconds. The takedown below still filters, so a
  // snapshot row is judged the same either way.
  // (a snapshot made before migration 201 names a note it changed the id of by the old one: still on the site, under either id)
  const allowed = await withFormerIds(workspaceId, await servedNodeIds(workspaceId));
  const snapshot = await pool.query(
    `SELECT id, workspace_id, title, home_node_id, event_cursor, artifact_ref, created_at,
            (payload - 'nodes' - 'edges')
              || jsonb_build_object(
                   'nodes', ARRAY(SELECT n FROM jsonb_array_elements(coalesce(payload->'nodes', '[]'::jsonb)) n
                                   WHERE n->>'id' = ANY($2::text[])),
                   'edges', ARRAY(SELECT e FROM jsonb_array_elements(coalesce(payload->'edges', '[]'::jsonb)) e
                                   WHERE e->>'source_node_id' = ANY($2::text[]) AND e->>'target_node_id' = ANY($2::text[]))
                 ) AS payload
       FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, [...allowed]],
  );
  if (snapshot.rows[0]) {
    // The address is what the static host serves at NOW (custom domain included), not what it was when the snapshot was made.
    const row = { ...snapshot.rows[0], artifact_ref: (await staticSiteUrl(workspaceId)) ?? "/site/" };
    return withTimeZone(await applyTakedown(workspaceId, row, allowed) as ServedSite);
  }
  return withTimeZone({
    id: null,
    title: "Onden Site",
    home_node_id: null,
    event_cursor: 0,
    payload: { nodes: [], edges: [], presentation: {} },
    artifact_ref: "/site/",
    created_at: new Date().toISOString(),
  });
}

/** What the served site is now, as one short string: the same value for the
 *  same served content, a different one after any change to it, takedowns
 *  included (the payload is already the snapshot minus takedowns, and the
 *  title, home and snapshot id are hashed beside it). It is a hash of the
 *  served content, not a cheaper stand-in: a takedown can come from a note, a
 *  tag, a space, a member or the site settings, and no one counter sees all of
 *  them, so a version that skips the content could serve a stale page.
 *  `created_at` is left out: an unpublished workspace stamps it at read time. */
export function servedSiteVersion(site: ServedSite): string {
  return sha256Hex(JSON.stringify([site.id, site.title, site.home_node_id, site.event_cursor, site.artifact_ref, site.payload])).slice(0, 32);
}

/** The served site's pages — what every site address and exported [[link]]
 *  is resolved against (@onden/markdown sitePath.ts). */
export async function servedPages(workspaceId: string): Promise<ServedPage[]> {
  const site = await loadServedSite(workspaceId);
  return (Array.isArray(site.payload.nodes) ? site.payload.nodes as ServedPage[] : [])
    .filter((n) => typeof n.id === "string" && typeof n.slug === "string");
}

/** A note's address on the served site, `/site/<served slug>` (sitePathFor),
 *  or null when readers don't see it there now: never published, marked after
 *  the last Publish, or taken down since. What the app's Copy link hands out
 *  (D42) — the live slug can differ (a clash renamed, a rename after Publish). */
export async function publishedUrlFor(workspaceId: string, nodeId: string): Promise<string | null> {
  // The same answer as sitePathFor over servedPages, without loading and
  // redacting the whole site (tens of MB on a large one) to look up one slug:
  // a page is served exactly when the snapshot carries it and servedNodeIds holds it.
  if (!(await servedNodeIds(workspaceId)).has(nodeId)) return null;
  const stored = await storedNote(workspaceId, nodeId);
  const slug = stored?.node.slug;
  return typeof slug === "string" ? sitePathFor(nodeId, [{ id: nodeId, slug }]) : null;
}

/** The single-note HTML export of `note` (its current text, which may differ
 *  from the site's copy): the live site settings' theme, and [[links]] that
 *  point at the served site's pages, plain text where the site has none. A
 *  link by alias is first rewritten to the page's served slug, as a publish
 *  does (redaction.ts linkAliasesBySlug): the served pages list none. */
export async function singleNoteExport(
  workspaceId: string, note: { id: string; title: string; markdown: string },
  /** The exporter: the note's onden-query / onden-base blocks are evaluated
   *  as them now, listing only the served site's pages (D113). */
  exporter: ActorCtx,
): Promise<string> {
  const overlaid = (await overlaySiteConfig(workspaceId, null)) as Manifest;
  const site = await loadServedSite(workspaceId);
  const pages = (Array.isArray(site.payload.nodes) ? site.payload.nodes as ServedPage[] : [])
    .filter((n) => typeof n.id === "string" && typeof n.slug === "string");
  const manifest = { ...overlaid, site: scrubNavLinks(overlaid.site ?? {}, new Set(pages.map((p) => p.id))) } as Manifest;
  const aliases = await publishedAliases(pages.map((p) => p.id));
  const markdown = aliasLinksBySlug(pages.map((p) => ({ ...p, aliases: aliases.get(p.id) })))(note.markdown, note.id);
  const queryBlocks = (await freezeQueryBlocks(workspaceId, [{ ...note, markdown }], {
    actor: exporter, listed: pages,
  })).get(note.id) ?? [];
  const diagrams = diagramsBySource(site.payload.diagrams);
  return buildSingleNoteHtml({ ...note, markdown, query_blocks: queryBlocks }, manifest, pages, diagrams);
}

/** The workspace's calendar clock (localDay.ts) on the served presentation,
 *  as `time_zone` and `day_start_hour`: the site renders on the frontend server (which does not know the workspace setting) and again in the visitor's browser, and both format
 *  dates in this one zone so they show the same day (D46). Added at serve
 *  time, not frozen into the snapshot: it is a property of the server, like
 *  the day buckets. */
function withTimeZone(site: ServedSite): ServedSite {
  const presentation = site.payload.presentation && typeof site.payload.presentation === "object"
    ? site.payload.presentation as Record<string, unknown> : {};
  return { ...site, payload: { ...site.payload, presentation: { ...presentation, time_zone: dayClock().timeZone, day_start_hour: dayClock().dayStartHour } } };
}

/** Whether the served site shows `/api/media/<filename>` through one of
 *  `owners` (the notes whose reference decides who may read the file,
 *  readPolicy.canReadMedia): an anonymous visitor may fetch it only then. The
 *  owner must be on the site now (in the latest snapshot and not taken down)
 *  and must have carried the file in that snapshot — a published note that
 *  embeds a new image after it, or a note published after it, shows nothing
 *  until the next publish. The site-config node (logo, favicon, design)
 *  counts when the snapshot's settings carry the file, or for a
 *  snapshot from before W38a, whose settings are still read live. */
export async function servedSiteShowsMedia(
  workspaceId: string, filename: string, owners: string[],
  /** Judge this payload instead of the latest snapshot (the publish preview's
   *  candidate: "would it be public after this publish"). */
  site?: Record<string, unknown>,
): Promise<boolean> {
  if (owners.length === 0) return false;
  const needle = mediaUrl(filename);
  const snap = site ? carriedBy(site, owners, needle) : await latestSnapshotCarrying(workspaceId, filename, owners);
  if (!snap) return false;
  if (snap.nodes.length > 0) {
    // The preview's candidate is judged as the publish would make it: returning notes count.
    const published = site ? await publishedNodeIds(workspaceId) : await servedNodeIds(workspaceId);
    if (snap.nodes.some((id) => published.has(id))) return true;
  }
  const configId = await findConfigNodeId(workspaceId);
  if (configId == null || !owners.includes(configId)) return false;
  return snap.in_presentation || !(snap.frozen ?? await latestSnapshotFrozen(workspaceId));
}

/** What the latest snapshot says carries `filename` among `owners`, from
 *  snapshot_media (written at publish, publishing/snapshotMedia.ts) — an index
 *  lookup, not a scan of the payload. `frozen` is left undefined: it needs the
 *  payload and only the site-config case asks for it (latestSnapshotFrozen). */
async function latestSnapshotCarrying(workspaceId: string, filename: string, owners: string[]) {
  const r = (await q<{ nodes: string[]; in_presentation: boolean }>(
    `WITH latest AS (SELECT id FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1)
     SELECT coalesce(array_agg(m.owner_id) FILTER (WHERE m.kind = 'node'), '{}') AS nodes,
            coalesce(bool_or(m.kind = 'presentation'), false) AS in_presentation
       FROM latest l
       LEFT JOIN snapshot_media m ON m.snapshot_id = l.id AND m.filename = lower($2)
                                 AND (m.kind = 'presentation' OR m.owner_id = ANY($3::text[]))
      GROUP BY l.id`, // grouped: no snapshot at all is no row, not an empty one
    [workspaceId, filename, owners],
  )).rows[0];
  return r && { frozen: undefined as boolean | undefined, ...r };
}

/** Whether the latest snapshot froze its site settings (W38a). */
async function latestSnapshotFrozen(workspaceId: string): Promise<boolean> {
  return (await q<{ frozen: boolean }>(
    `SELECT coalesce(payload->>'settings_frozen', '') = 'true' AS frozen FROM publish_snapshots
      WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [workspaceId],
  )).rows[0]?.frozen ?? false;
}

/** servedSiteShowsMedia's snapshot query, on a payload in memory. */
function carriedBy(payload: Record<string, unknown>, owners: string[], needle: string) {
  const has = (value: unknown) => JSON.stringify(value ?? null).toLowerCase().includes(needle.toLowerCase());
  const mine = (row: unknown): row is { id: string } =>
    !!row && typeof row === "object" && owners.includes(String((row as { id?: unknown }).id)) && has(row);
  const nodes = Array.isArray(payload.nodes) ? payload.nodes.filter(mine).map((n) => n.id) : [];
  return { frozen: payload.settings_frozen === true, nodes, in_presentation: has(payload.presentation ?? {}) };
}

/** Whether a site visitor may open `filename`: servedSiteShowsMedia over the
 *  notes the media rule makes decide (mediaOwners.anonymousMediaOwners: an
 *  upload's claimed owner, none for an unclaimed upload, else the live notes
 *  embedding a file with no upload record). `site`: judge that payload instead of the latest snapshot
 *  (the publish preview). The anonymous branch of mediaAccess.canReadMedia. */
export async function siteShowsMedia(workspaceId: string, filename: string, site?: Record<string, unknown>): Promise<boolean> {
  return servedSiteShowsMedia(workspaceId, filename, await anonymousMediaOwners(workspaceId, filename), site);
}
