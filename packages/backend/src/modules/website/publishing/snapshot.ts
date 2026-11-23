// Snapshot orchestration: build a publish snapshot from the published
// set (publishedSet.ts: the notes of spaces that publish, minus those kept off) and durably enqueue the pages push. Extracted verbatim from
// routes/publish.ts; the single source of truth for "deploy the site",
// shared by POST /api/publish and the unpublish-triggered re-deploy
// (routes/nodes.ts) and the outbox reconciler.

import { BLOCK_ID_CHARS, PUBLISHED_EDGE_TYPES, stripLegacyIds, writeLegacyIds } from "@onden/markdown";
import { validAnchorRangesByNote } from "../../../services/blockAnchors/index.js";
import { q, withTransaction } from "../../../db.js";
import type { ActorCtx } from "../../../types.js";
import { appendEventAsCurrentActor } from "../../../spine/currentActor.js";
import { CodedStatusError } from "../../../statusError.js";
import { enqueueSiteOutput } from "../../../services/outbox.js";
import { staticSiteUrl } from "./cname.js";
import { overlaySiteConfig, publishedNodeIds, uniquePublishedSlugs } from "./publishedSet.js";
import { scrubUnpublishedParents, attachPublishedTags, linkAliasesBySlug, publishedAliases, publishedNames, redactPayloadNodes } from "./redaction.js";
import { readerHash, type PayloadEdge, type PayloadNode } from "./siteDiff.js";
import { carryEmbeddedPictures, pictureSourceList } from "./drawingEmbeds.js";
import { presentationWords } from "./siteWords.js";
import { forgetReplacedPages, prepareHandwritingPages, storeHandwritingPages, type PageFiles } from "./handwritingPages.js";
import { siteHomeFor } from "./siteHome.js";
import { scrubNavLinks } from "./siteRows.js";
import { freezeQueryBlocks } from "./queryBlocks.js";
import { snapshotRedirects } from "./siteRedirects.js";
import { expandPublishedExcerpts } from "./excerptEmbeds.js";
import { defaultDesign } from "@onden/site";
import { freezeDesign, savedDesign, type UnpublishedRef } from "./frozenDesign.js";
import type { Manifest } from "./types.js";
import { recordSnapshotMedia } from "../../../services/snapshotMedia.js";
import { candidateDiagrams, type SubmittedDiagram } from "./diagrams.js";

/** Who publishes: an ActorCtx, or its id and type alone (an approved agent
 *  request, outbox effects), which read as that person. */
type SnapshotActor = Pick<ActorCtx, "id" | "type"> & Partial<ActorCtx>;
const asReader = (actor: SnapshotActor): ActorCtx => ({ name: "", ...actor });

export type SnapshotOpts = {
  title: string;
  /** An explicit home override; omitted, the site opens on the workspace's
   *  home (siteHome.ts siteHomeFor decides). */
  homeNodeId?: string | null;
  presentation?: Record<string, unknown>;
  sideEffects?: Record<string, unknown>;
  uiContext?: string;
  /** Layouts the publisher's browser made of the notes' mermaid blocks
   *  (diagrams.ts): untrusted, kept only when they check out. */
  diagrams?: readonly SubmittedDiagram[];
  /** Who the published notes' query blocks are evaluated as (D113,
   *  queryBlocks.ts): the publisher. Omitted, they list nothing. */
  actor?: ActorCtx | null;
};

/** What a publish would freeze, before anything is written: the snapshot
 *  row's fields and `payload` exactly as stored. `privateLinks` is the report
 *  of wikilinks made inert on the way (not part of the snapshot). */
type Candidate = {
  title: string;
  homeNodeId: string | null;
  eventCursor: number;
  payload: Record<string, unknown>;
  privateLinks: Array<{ nodeId: string; nodeTitle: string; target: string; shownAs: string }>;
  /** Note components of the home page whose note is not in this publish
   *  (the preview offers to publish them). Not stored: their titles are private. */
  unpublishedRefs: UnpublishedRef[];
  /** The pictures of the handwriting pages the payload names (`ink_pages`),
   *  kept out of the payload: storing the snapshot writes them as media files. */
  handwritingPages: PageFiles;
  /** Diagram blocks the candidate still has no layout for, and uploads that were not kept (diagrams.ts). */
  diagramsNeeded: string[];
  diagramsRejected: number;
};

/** The publish preview is stale: the candidate changed after it was previewed. */
export class PublishPreviewStale extends CodedStatusError {
  constructor() { super(409, "preview_stale", "The site changed after the preview. Check the new preview, then publish."); this.name = "PublishPreviewStale"; }
}

/** The ids a published page's links and embeds name (`#^id`), over-collected: a superset is harmless. */
const BLOCK_REFERENCE = new RegExp(`#\\^([${BLOCK_ID_CHARS}]{1,64})`, "g");

/** Writes, into each published note's text, the marks of the anchors some published page refers to; returns the notes
 *  it did that for. Mutates `rows`. */
async function markReferencedBlocks(workspaceId: string, rows: Array<{ id?: unknown; markdown?: unknown }>): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (const n of rows) {
    if (typeof n.markdown !== "string" || !n.markdown.includes("#^")) continue;
    for (const m of n.markdown.matchAll(BLOCK_REFERENCE)) referenced.add(m[1]!);
  }
  const marked = new Set<string>();
  if (referenced.size === 0) return marked;
  const ranges = await validAnchorRangesByNote(workspaceId, rows.map((n) => String(n.id)));
  for (const n of rows) {
    if (typeof n.markdown !== "string" || n.markdown === "") continue;
    const mine = (ranges.get(String(n.id)) ?? []).filter((a) => referenced.has(a.id));
    if (mine.length === 0) continue;
    const written = writeLegacyIds(n.markdown, mine);
    if (written.written.length === 0) continue;
    n.markdown = written.markdown;
    marked.add(String(n.id));
  }
  return marked;
}

/** The way back for markReferencedBlocks: the marks leave the text; the anchors the page keeps are `part_anchors`
 *  of the note as published (`{ id, from, to }` in its published text), what the site finds a paragraph by. A note whose
 *  marks cannot be taken out without changing what it reads keeps them out of sight: its anchors are not offered. */
function unmarkReferencedBlocks(rows: Array<{ id?: unknown; markdown?: unknown; part_anchors?: unknown }>, marked: ReadonlySet<string>): void {
  for (const n of rows) {
    if (!marked.has(String(n.id)) || typeof n.markdown !== "string") continue;
    const out = stripLegacyIds(n.markdown);
    if ("refused" in out) continue;
    n.markdown = out.markdown;
    n.part_anchors = out.anchors.filter((a) => !a.repeat).map((a) => ({ id: a.id, from: a.from, to: a.to }));
    // The same ids, flat: what the served-page fallback ranks pages by (servedBlockPage).
    (n as { block_ids?: string[] }).block_ids = out.anchors.filter((a) => !a.repeat).map((a) => a.id);
  }
}

/** The published set as the snapshot freezes it: each note redacted, its slug
 *  made unique, drawings and query blocks frozen, tags attached, and the
 *  published edges between them. `onlyNoteId`: only that note carries its
 *  text and edges (the others keep title, slug and parent, which is all the
 *  redaction, slugs and tag lists read of them), so one note's reader view
 *  costs one note's text, not the site's. */
async function frozenPublishedNodes(
  workspaceId: string, publishedIds: string[], actor: ActorCtx | null,
  /** What a link or embed of a note not on the site reads as, in the site's language (siteWords privateText). */
  privateText: string,
  onlyNoteId?: string,
) {
  // order_key + order_stamp: the site lists siblings in the workspace's order
  // (frontend lib/childOrder), not by title (D64).
  const nodes = await q<{ id: string; slug: string; title: string }>(
    `SELECT id, node_type, title, slug, updated_at, parent_id, order_key, order_stamp, created_at,
            CASE WHEN $3::uuid IS NULL OR id = $3::uuid THEN markdown ELSE '' END AS markdown
     FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])
     ORDER BY created_at ASC, id ASC`,
    [workspaceId, publishedIds, onlyNoteId ?? null],
  );
  scrubUnpublishedParents(nodes.rows);
  await uniquePublishedSlugs(nodes.rows);
  // Aliases decide which links stay links; they are never added to the payload.
  const aliases = await publishedAliases(publishedIds);
  // D9 SECURITY: redact at the SOURCE so the frozen snapshot payload is born
  // clean. The static copy (staticSite.ts) renders what the SSR pages read
  // from the served site, which re-runs only the takedown, not the redaction.
  // Without this, a published page's [[wikilink]] to an unpublished/private node would
  // render that private node's TITLE as link text in the static output.
  // nodes.rows IS the published set, so it is the allowlist for inerting links
  // that point out of it.
  const privateLinks: Candidate["privateLinks"] = [];
  // The paragraphs the published pages link to or embed (`[[A#^id]]`, `![[A#^id]]`) are named by their anchors, which
  // are not in the text; the redaction and rewriting below work on text. So those anchors are written into the text as
  // marks for the length of this function and read back out at the end (publishedBlockMarks), leaving the page's text
  // without them and the anchors' places in the text as it is published.
  const marked = await markReferencedBlocks(workspaceId, nodes.rows);
  // ![[note#^id]] of an excerpt becomes the excerpt (quote + source link) —
  // before redaction, which would make an embed of an unpublished note inert.
  await expandPublishedExcerpts(workspaceId, nodes.rows, actor);
  // ![[drawing]] embeds: the picture of what is embedded travels with the note
  // that embeds it, even from a space that does not publish — before
  // redaction, which would make such an embed inert (drawingEmbeds.ts).
  await carryEmbeddedPictures(workspaceId, nodes.rows, actor, aliases);
  const onInert = (node: { id?: unknown; title?: unknown }, link: { target: string; shownAs: string }) => privateLinks.push({
    nodeId: String(node.id), nodeTitle: String(node.title ?? ""), target: link.target, shownAs: link.shownAs,
  });
  redactPayloadNodes(nodes.rows, privateText, onInert, aliases);
  // …and a link by alias names its note by the served slug instead (option 3).
  linkAliasesBySlug(nodes.rows, aliases);
  // A handwriting note draws its own pages on its own page (handwritingPages.ts).
  const handwritingPages = await prepareHandwritingPages(workspaceId, nodes.rows, onlyNoteId);
  // onden-query / onden-base blocks: their result now, frozen on the note,
  // listing published notes only (D113) — the site never runs a query.
  const frozen = await freezeQueryBlocks(workspaceId, nodes.rows as Array<{ id: string; title: string; slug: string; markdown: string }>, {
    actor, listed: nodes.rows, privateText,
  });
  for (const node of nodes.rows as Array<{ id: string; query_blocks?: unknown }>) {
    const blocks = frozen.get(node.id);
    if (blocks) node.query_blocks = blocks;
  }
  unmarkReferencedBlocks(nodes.rows, marked);
  await attachPublishedTags(nodes.rows as Array<{ id: string; tags?: string[] }>);
  // The links a published page renders (Related, backlinks, site nav): active
  // edges of a published type — the frontend's lib/edgeRoles `publishes`.
  // A machine suggestion (status suggested/rejected) or a private relation
  // (highlight provenance, citations) never reaches the static payload.
  const edges = await q(
    `SELECT id, source_node_id, target_node_id, edge_type
     FROM node_edges
     WHERE workspace_id = $1
       AND source_node_id = ANY($2::uuid[])
       AND target_node_id = ANY($2::uuid[])
       AND status = 'active'
       AND edge_type = ANY($3::text[])
       AND ($4::uuid IS NULL OR source_node_id = $4::uuid OR target_node_id = $4::uuid)
     ORDER BY created_at ASC, id ASC`,
    [workspaceId, publishedIds, [...PUBLISHED_EDGE_TYPES], onlyNoteId ?? null],
  );
  return { nodes, edges, aliases, privateLinks, handwritingPages };
}

/** Build the candidate snapshot from the CURRENT published set (publishedSet.ts:
 *  the notes of spaces that publish, minus those kept off). Read-only: the publish preview shows exactly this, and a publish
 *  stores exactly this (buildAndEnqueueSnapshot). Run it inside the publish
 *  transaction when it is about to be stored. */
export async function buildCandidate(workspaceId: string, opts: SnapshotOpts): Promise<Candidate> {
  // The event cursor is read FIRST, so every change up to it is in the data
  // read after it: the cursor is a lower bound of what the snapshot contains
  // (a later change may already be in it, and simply arrives again).
  const cursor = await q<{ cursor: string }>(
    "SELECT coalesce(max(id), 0)::text AS cursor FROM domain_events WHERE workspace_id = $1",
    [workspaceId],
  );
  // CHOKEPOINT: the published set is the ONE shared predicate — the space rule
  // (publicly readable) minus a note kept off (`_published` 'false'), blank, saved or hidden. No
  // inlined exclusion SQL; the snapshot can never diverge from the serve-time
  // takedown filter (servedSite.applyTakedown) because both call publishedNodeIds.
  const publishedIds = [...(await publishedNodeIds(workspaceId))];
  // The site settings (brand, nav, SEO, its language …) are frozen with the content: a
  // changed setting, like an edited note, waits for the next publish (W38a).
  const overlaid = await overlaySiteConfig(workspaceId, opts.presentation ?? {});
  const { privateText } = presentationWords(overlaid);
  const { nodes, edges, aliases, privateLinks, handwritingPages } = await frozenPublishedNodes(workspaceId, publishedIds, opts.actor ?? null, privateText);

  // The home is a page of the published set, decided by siteHomeFor (the
  // explicit override, else the workspace's home, else its one fallback).
  const homeNodeId = await siteHomeFor(workspaceId, nodes.rows, opts.homeNodeId);
  // `settings_frozen` tells the loader not to overlay the settings.
  const site = scrubNavLinks(overlaid.site as { nav?: unknown }, new Set(nodes.rows.map((n) => n.id as string)));
  // The design is the SAVED one (the studio's chrome), never the request's;
  // without a design the default. Its tag pages (and the old free-form home page, when that is the one drawn) are frozen now.
  const design = await savedDesign(workspaceId) ?? defaultDesign();
  const frozenHome = await freezeDesign({
    workspaceId, actor: opts.actor ?? null, design,
    nodes: nodes.rows as unknown as Parameters<typeof freezeDesign>[0]["nodes"],
    names: publishedNames(nodes.rows, aliases), privateText,
  });
  const manifest = { site, design: frozenHome.design } as Manifest;
  // The addresses earlier snapshots served, so a renamed note's (or tag's) old
  // address still reaches it (siteRedirects.ts, GAP-240).
  const redirects = await snapshotRedirects(
    workspaceId, nodes.rows, (frozenHome.design as { tag_pages?: Record<string, { slug: string }> }).tag_pages ?? {},
  );
  const diagrams = await candidateDiagrams(workspaceId, nodes.rows as Array<{ markdown?: unknown }>, opts.diagrams);
  const pictureSources = pictureSourceList(nodes.rows);
  return {
    title: opts.title,
    homeNodeId,
    eventCursor: Number(cursor.rows[0].cursor),
    payload: {
      nodes: nodes.rows, edges: edges.rows,
      ...(diagrams.diagrams.length > 0 ? { diagrams: diagrams.diagrams } : {}),
      ...(redirects ? { redirects } : {}),
      // Bookkeeping, never served (servedSite.applyTakedown drops it): which drawings lend this snapshot a picture.
      ...(pictureSources ? { picture_sources: pictureSources } : {}),
      presentation: manifest, settings_frozen: true, side_effects: opts.sideEffects ?? {}, home_node_id: homeNodeId,
    },
    privateLinks,
    unpublishedRefs: frozenHome.unpublishedRefs,
    handwritingPages,
    diagramsNeeded: diagrams.needed,
    diagramsRejected: diagrams.rejected,
  };
}

/** One note as a publish now would freeze it, with the ids it would put on the
 *  site (its parent only counts when published) and the published edges it is
 *  an end of: what siteDiff.noteReaderView reads. Null when the note would not
 *  be on the site. Costs the note's own text, not the site's (frozenPublishedNodes). */
export async function candidateNote(workspaceId: string, nodeId: string, actor: ActorCtx | null) {
  const publishedIds = [...(await publishedNodeIds(workspaceId))];
  if (!publishedIds.includes(nodeId)) return null;
  const { privateText } = presentationWords(await overlaySiteConfig(workspaceId, null));
  const { nodes, edges } = await frozenPublishedNodes(workspaceId, publishedIds, actor, privateText, nodeId);
  const node = nodes.rows.find((n) => n.id === nodeId);
  return node ? { node: node as PayloadNode, ids: new Set(publishedIds), edges: edges.rows as PayloadEdge[] } : null;
}

/** Stable across rebuilds of the same content and blind to what readers
 *  can't see: the hash of the candidate's reader view (siteDiff.readerHash),
 *  the same view the preview's diff compares, so a preview that lists no
 *  change is never stale and a stale one always lists what changed (D80). */
export function candidateHash(candidate: Pick<Candidate, "title" | "payload">): string {
  return readerHash(candidate.title, candidate.payload);
}

// Build a publish snapshot from the CURRENT published set (publishedSet.ts) and
// durably enqueue the pages push — the single source of truth for "deploy the
// site", shared by POST /api/publish and the unpublish-triggered re-deploy.
// `expectedHash` (from the publish preview): publish only if the candidate is
// still the one previewed, else PublishPreviewStale.
export async function buildAndEnqueueSnapshot(
  workspaceId: string,
  actor: SnapshotActor,
  opts: SnapshotOpts & { expectedHash?: string },
): Promise<Record<string, unknown> & { id: string; artifact_ref: string }> {
  // One transaction with its snapshot row and pages push. READ COMMITTED:
  // each read sees what had committed when it ran, not one frozen view.
  return withTransaction(async () => {
    const candidate = await buildCandidate(workspaceId, { ...opts, actor: opts.actor ?? asReader(actor) });
    if (opts.expectedHash !== undefined && candidateHash(candidate) !== opts.expectedHash) throw new PublishPreviewStale();
    const { homeNodeId } = candidate;
    const artifactRef = (await staticSiteUrl(workspaceId)) ?? "/site/";

    const snapshot = await q<Record<string, unknown> & { id: string; artifact_ref: string }>(
      `INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [workspaceId, candidate.title, homeNodeId, candidate.eventCursor, candidate.payload, artifactRef],
    );
    const snap = snapshot.rows[0];
    // The handwriting pages' files, before the media rows that name them. A
    // preview or warmHandwritingPages already drew them, so this finds them
    // stored and draws only what neither did.
    await storeHandwritingPages(workspaceId, candidate.handwritingPages, actor.id);
    await recordSnapshotMedia(snap.id, candidate.payload);
    await forgetReplacedPages(workspaceId, new Set(candidate.handwritingPages.keys()));
    // ER4: external=true — restore must NOT try to "undo" a publish.
    // The actor is re-read under the event lock (appendEventAsCurrentActor): one removed after the route's site-admin check is refused
    // 401 and this whole transaction — snapshot row, pages push — rolls back, instead of the database's actor check answering 500.
    const eventId = await appendEventAsCurrentActor(asReader(actor), workspaceId,
      "PUBLISH_SNAPSHOT_CREATED", "publish_snapshot", snap.id,
      { artifact_ref: artifactRef, home_node_id: homeNodeId, side_effects: opts.sideEffects ?? {} },
      { external: true, txMeta: { ui_context: opts.uiContext ?? "publish.dialog" } },
    );
    await enqueueSiteOutput({ workspaceId, snapshotId: snap.id, triggeredByEventId: eventId });
    return snap;
  });
}

/** Draw and store the handwriting pages a publish with `opts` would name,
 *  BEFORE its transaction: drawing a large drawing blocks the process for
 *  seconds and must not hold a database transaction open. A publish that
 *  follows a preview finds them already there; this is for the ones that
 *  don't (an approved agent request). */
export async function warmHandwritingPages(workspaceId: string, actor: SnapshotActor, opts: SnapshotOpts): Promise<void> {
  const candidate = await buildCandidate(workspaceId, { ...opts, actor: opts.actor ?? asReader(actor) });
  await storeHandwritingPages(workspaceId, candidate.handwritingPages, actor.id);
}

/** The back-office list of published snapshots (titles, node counts, artifact
 *  refs; no payload), newest first, at most 20. For the site admin only. */
export async function listSnapshots(workspaceId: string) {
  const result = await q(
    `SELECT id, title, home_node_id, event_cursor,
            jsonb_array_length(payload->'nodes') AS node_count,
            artifact_ref, created_at
     FROM publish_snapshots
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [workspaceId],
  );
  // The link is the address the site is at now: a custom domain set or cleared since a publish
  // changes where the static copy lives, and the stored value (made at publish) would not follow.
  const address = (await staticSiteUrl(workspaceId)) ?? "/site/";
  return result.rows.map((row) => ({ ...row, artifact_ref: address }));
}

// Take down what the live workspace removed since the last publish: push the
// latest snapshot again, which the push filters (servedSite.applyTakedown) as
// every other surface does. Builds NO new snapshot, so a note opted in, an
// edited body or a changed setting stays off the site until the owner
// publishes (W38a). Requested by the site_rebuild effect after a change that
// may remove something; a site never published has nothing to take down.
export async function republishSite(workspaceId: string, _actor: SnapshotActor): Promise<boolean> {
  const last = await q<{ id: string }>(
    `SELECT id FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
  if (!last.rows[0]) return false;
  await enqueueSiteOutput({ workspaceId, snapshotId: last.rows[0].id });
  return true;
}
