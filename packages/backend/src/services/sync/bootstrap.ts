// GET /api/bootstrap's payload (depth audit D10, moved verbatim from
// index.ts): everything the client mirrors on a cold start — the event cursor
// it is current to (read BEFORE any row; the same cursor contract the delta
// in delta.ts continues from), the actor's readable nodes (slim or full), and
// the edges, tasks, pointers, attributes, memberships, events, tags, site
// config and chrome that go with them. Website › Collections reads the tag
// catalog (a collection IS a schema tag), so there is no separate collections
// projection to keep fresh (D97).

import { anchorRowsForNotes } from "../blockAnchors/index.js";
import { bindingRowsForNotes } from "../blockLinks.js";
import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { notATaskNodeSql, taskRowsForBootstrap } from "../tasksStore.js";
import { readTagCatalog } from "../tagCatalog.js";
import { findConfigNodeId, getSiteConfig, getChromeBlocks, siteConfigAt, chromeBlocksAt } from "../siteConfig.js";
import { readPositionsForSurface } from "../boardStore.js";
import { getCanvasMemberships } from "../canvasMemberships.js";
import { readableNodeIdSet } from "../readPolicy.js";
import { workspaceWireRow } from "../workspaceModules.js";
import { edgeColumnsSql, attributeColumnsSql, pointerColumnsSql, workspaceColumnsSql } from "../syncProjection.js";
import { SIBLING_ORDER_N, SIBLING_ORDER_P } from "../orderKeys.js";
import { dayClock } from "../../localDay.js";
import type { ServerNode } from "@onden/contract";
import { nodeRowColumnsSql, NODE_EVENT_META_COLUMNS_SQL } from "../nodeRowProjection.js";
import { isWorkspaceOwner, reviewAuthority } from "../../spine/authority.js";
import { withActorReadSnapshot } from "../actorReadSnapshot.js";
import { eventAudience, eventVisibleSql } from "../eventVisibility.js";
import { encodeBootstrapNodes } from "./bootstrapWire.js";
import { config } from "../../config.js";
import { INK_PAGE_ATTRS } from "@onden/markdown";
import { PDF_TEXT_ATTR } from "@onden/markdown/contract";
import { liveNodeSql } from "../../spine/nodeSql.js";
import { serverIdentityField } from "../../spine/stamps.js";

// Scale plane: the cap conflates two distinct concerns that we now separate.
//   • "don't ship all BODIES" — CORRECT. The full markdown of every node is what
//     blows the heap / payload at scale; slim mode (?bodies=none) already strips
//     it (markdown → "", body_len rides along) and the editor lazy-
//     hydrates on open.
//   • "don't ship all NODES" — WRONG, and the bug (review #3, HIGH). A node
//     SKELETON (id/title/slug/parent_id/type/attrs/label_tag_ids/edges, NO body)
//     is tiny — a few hundred bytes — so even tens of thousands stay a modest
//     payload. Capping the node SET made every node past the cap PERMANENTLY
//     INVISIBLE (the rest never loaded, and the client even clobbered its
//     complete local mirror down to the truncated set).
//
// Fix: the cap applies ONLY to the FULL-body bootstrap (where each row carries
// its markdown, so an unbounded set is a real heap/payload risk). In SLIM mode
// the node set is UNCAPPED — every skeleton ships, bodies stay omitted/lazy — so
// no node is ever invisible. The default boot path is slim past
// SLIM_MODE_NODE_THRESHOLD (2000) on the frontend, so big workspaces always take
// the uncapped-skeleton path; a full-body fetch only happens for small ones.
const BOOTSTRAP_NODE_LIMIT = config.int("BOOTSTRAP_NODE_LIMIT", 5000, { min: 1 });

// A lean bootstrap (the client asks with `x-onden-bootstrap: lean`) sends each
// attribute once and no drawings:
//   • no nodes[].attrs map — it repeated every typed `attributes` row; the
//     client rebuilds the map from those rows (lib/data/syncEngine);
//   • none of these keys' values: drawings, the largest values a workspace
//     has (ink_data was 38 of 64 MB of a 20k-note slim payload). Every reader
//     loads them on open (lib/ink/store → GET /api/nodes/:id/attributes) and
//     keeps a copy on the device for offline; deltas still carry changes.
// Older clients send no header and get the old shape.
//   • `pdf_text` (a PDF's text for search, up to ~60,000 characters a note) is left out too: the offline local search does not find
//     PDF text, the server's search and the semantic index do. `note_pages` (a few hundred bytes) stays in.
export const BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS = [...INK_PAGE_ATTRS, "pdf_annotations", PDF_TEXT_ATTR] as const;

/** The bootstrap payload for `authenticated`, re-read with its current role
 *  and scopes. `slimBodies`: every node without its markdown (body_len
 *  instead; the editor fetches bodies on open) and no node cap — see
 *  the comment above. `metaOnly` (?nodes=none): none of the per-node
 *  channels (nodes, edges, tasks, pointers, attributes), only what
 *  the sync delta does not carry — graph positions, suggestions,
 *  recent events, catalog, site config, chrome and the actor's flags — plus
 *  the boards each note is on in full (the delta keeps them current per
 *  shipped node, D98; this snapshot re-bases them). A
 *  client with a current mirror refreshes those on reopen; the nodes come
 *  through its event cursor (lib/data/syncEngine.ts, boot).
 *
 *  One read snapshot (withActorReadSnapshot), like the sync delta: the actor,
 *  the cursor, the read set and every row come from the same moment, so a
 *  role, space or content change committing mid-request can't give rows the
 *  read set doesn't cover, or rows newer than the cursor says. */
export async function buildBootstrap(authenticated: ActorCtx | null, workspaceId: string, { slimBodies, metaOnly = false, lean = false, compact = false }: { slimBodies: boolean; metaOnly?: boolean; lean?: boolean; compact?: boolean }) {
  const { payload, configFound } = await withActorReadSnapshot(authenticated, workspaceId, (actor) => readBootstrap(actor, workspaceId, slimBodies, metaOnly, lean, compact));
  if (!configFound) {
    // No Site Config note yet (a new workspace, or a restored tag not yet
    // adopted): getSiteConfig adopts the tag — a write, so after the read-only
    // snapshot — and answers {} / null when there is still no note. The note
    // itself is created by the admin's first settings change.
    const config = await getSiteConfig(workspaceId);
    payload.site_config = config;
    payload.chrome = await getChromeBlocks(workspaceId);
  }
  return payload;
}

/** The site config and chrome. Reads only, so it runs inside the
 *  bootstrap's or the sync delta's read snapshot (sync/delta.ts re-ships these
 *  after a SITE_CONFIG_UPDATED, D119). `configFound` false: the workspace has
 *  no Site Config note yet (both null). */
export async function readSiteSettings(workspaceId: string): Promise<{ site_config: unknown; chrome: unknown; configFound: boolean }> {
  const configNodeId = await findConfigNodeId(workspaceId);
  if (!configNodeId) return { site_config: null, chrome: null, configFound: false };
  const config = await siteConfigAt(configNodeId);
  return { site_config: config, chrome: await chromeBlocksAt(configNodeId), configFound: true };
}

async function readBootstrap(actor: ActorCtx, workspaceId: string, slimBodies: boolean, metaOnly: boolean, lean: boolean, compact: boolean) {
  // Scale plane (P0-3): ?bodies=none ships every node WITHOUT its markdown —
  // `body_len` rides along (nodeNeedsBody on the client); the editor lazy-
  // fetches the real body via GET /api/nodes/:id on open. The default stays
  // full-fat until the frontend flips over (probe: payload parse, not server
  // time, is the 3k-note ceiling — Logseq classic's exact failure shape).
  // GAP-249: the event cursor this payload is current to. Read BEFORE any row
  // so every change after it is still replayed: a client that starts its event
  // sync here may see an event whose effect it already has (idempotent
  // re-fetch), never miss one this payload lacks. Without it a fresh device
  // synced from since=0 and replayed the whole history (every body) right after
  // the slim bootstrap that exists to avoid exactly that.
  const cursorRes = await q(
    // now() is the snapshot transaction's start: a note created after it has a
    // later created_at, so clients can tell "new since this list" by it.
    "SELECT COALESCE(MAX(id), 0)::text AS last_event_id, now() AS server_time FROM domain_events WHERE workspace_id = $1",
    [workspaceId],
  );
  const lastEventId = String(cursorRes.rows[0].last_event_id);
  const serverTime = (cursorRes.rows[0].server_time as Date).toISOString();
  // The membership epoch of the readable set this payload lists (same snapshot,
  // read before the rows). A client that reconciled to the same epoch while
  // this downloaded need not check membership again (syncEngine
  // membershipMovedSince).
  const epochRes = await q(`SELECT membership_epoch FROM workspaces WHERE id = $1`, [workspaceId]);
  const membershipEpoch = Number(epochRes.rows[0]?.membership_epoch ?? 0);

  // The set of node ids this actor can READ (tag read-policy, cascaded through
  // ancestors). Extracted to services/readPolicy so the same predicate guards
  // every node-returning endpoint, not just bootstrap.
  // The node ids this actor can READ: membership of each note's space.
  const visibleNodeIds = [...await readableNodeIdSet(actor, workspaceId)];

  const ws = await q(`SELECT ${workspaceColumnsSql("w")} FROM workspaces w WHERE w.id = $1`, [workspaceId]);
  // Nodes carry:
  //   • class_tag_ids — IDs of class tags applied to this node (a class tag is
  //     a tag whose schema_id is non-null; it carries fields/policy/behaviour).
  //     Used to distinguish plain knowledge notes from collection items.
  //   • attrs — a {key: value} map of all node_attributes for the node. Avoids
  //     a follow-up roundtrip when components like NodeAttributesPanel /
  //     inbox preview need to read attribute state, and keeps the "single
  //     bootstrap call" property of the main store.
  // F4.x — event metadata for the Bases evaluator: last_actor /
  // last_modified_at / recent_actors. Sourced from domain_events filtered to
  // target_type='content_node'. Per F3 review C3 these are presentational
  // only and the eval layer must not use them for permission decisions —
  // backend trust boundary stays on canActorOnNode.
  // The metadata comes from node_event_meta (one row per note and actor,
  // maintained as events are appended; migration 130), grouped once over the
  // visible set and LEFT JOINed — it no longer scans the event log, so a cold
  // start costs the same at 1M events as at 1k. Shape: nodes with no events keep
  // last_actor/last_modified_at NULL and recent_actors an empty array.
  const nodes = metaOnly ? { rows: [] as ServerNode[] } : await q<ServerNode>(
    `WITH evt_meta AS (
       SELECT m.node_id AS target_id,
         ${NODE_EVENT_META_COLUMNS_SQL}
       FROM node_event_meta m
       WHERE m.node_id = ANY($2::text[])
       GROUP BY m.node_id
     )
     SELECT ${nodeRowColumnsSql("n", { attrs: !lean, markdown: !slimBodies })}
     FROM content_nodes n
     LEFT JOIN evt_meta em ON em.target_id = n.id::text
     WHERE n.workspace_id = $1 AND n.id = ANY($2::uuid[]) AND ${liveNodeSql("n")}
       AND ${notATaskNodeSql("n")}
     ORDER BY ${SIBLING_ORDER_N}
     ${slimBodies ? "" : "LIMIT $3"}`,
    // Slim mode ships EVERY node skeleton (no LIMIT) — bodies are stripped below,
    // so the set is small even at tens of thousands and no node is invisible.
    // The cap only binds the FULL-body bootstrap, where an unbounded set carries
    // every markdown and is a genuine heap/payload risk.
    slimBodies ? [workspaceId, visibleNodeIds] : [workspaceId, visibleNodeIds, BOOTSTRAP_NODE_LIMIT],
  );
  // The dependent queries below filter against the IDS WE ACTUALLY RETURNED, not
  // the full visibility set, so should the FULL-body path still cap, a node
  // dropped past the cap can't reappear as a dangling edge / pointer / membership
  // endpoint pointing at an absent node. In slim mode the returned set IS the
  // complete visible set, so this pruning is a no-op there (nothing is dropped).
  // Meta only: no node rows, but every readable node still counts for the
  // boards, suggestions and events below (what a slim payload would return).
  const returnedNodeIds = metaOnly ? visibleNodeIds : nodes.rows.map((n: Record<string, unknown>) => String(n.id));
  // Edges filtered to ones where BOTH endpoints are visible — otherwise
  // we'd expose a hidden node's existence via "X has a knowledge link
  // to <opaque uuid>" in the graph.
  const edges = metaOnly ? { rows: [] } : await q(
    `SELECT ${edgeColumnsSql("e")} FROM node_edges e
     WHERE e.workspace_id = $1
       AND e.source_node_id = ANY($2::uuid[])
       AND e.target_node_id = ANY($2::uuid[])
     ORDER BY e.created_at ASC`,
    [workspaceId, returnedNodeIds],
  );
  // Tasks are NODES (migration 062) but the bootstrap payload keeps the frozen
  // `tasks` array shape, synthesized from task nodes. Task nodes are EXCLUDED
  // from the general nodes array above (notATaskNodeSql) — a thousand todos
  // must not become a thousand sidebar/graph node rows.
  const tasks = { rows: metaOnly ? [] : await taskRowsForBootstrap(workspaceId, visibleNodeIds) };
  const pointers = metaOnly ? { rows: [] } : await q(
    `SELECT ${pointerColumnsSql("p")}
     FROM note_pointers p
     WHERE p.workspace_id = $1
       AND p.target_id = ANY($2::uuid[])
       AND (p.parent_id IS NULL OR p.parent_id = ANY($2::uuid[]))
     ORDER BY ${SIBLING_ORDER_P}`,
    [workspaceId, returnedNodeIds],
  );
  // Typed attributes of the returned nodes, so the client mirror keeps each
  // one's type, inheritance and source (nodes[].attrs stays a key → value map).
  const attributes = metaOnly ? { rows: [] } : await q(
    `SELECT ${attributeColumnsSql("na")} FROM node_attributes na
      WHERE na.workspace_id = $1 AND na.node_id = ANY($2::uuid[])
        ${lean ? "AND na.key <> ALL($3::text[])" : ""}`,
    lean ? [workspaceId, returnedNodeIds, [...BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS]] : [workspaceId, returnedNodeIds],
  );
  // Flatten canvas membership for the "Appears on canvases" backlink panel.
  // Since canvas-as-node (migration 057) membership IS the node_positions
  // table — a row whose surface is a live canvas node's id (see
  // services/canvasMemberships.ts) — this server-side flatten lets the
  // frontend show node→canvases without each consumer querying placements.
  const canvasMemberships = { rows: await getCanvasMemberships(workspaceId, returnedNodeIds) };
  // Audit #1: node-targeted suggestions/events follow the same visibility set
  // as the nodes themselves — a restricted node must not leak its title/body
  // through a suggestion payload or the activity feed. (collection_schemas
  // stay unfiltered on purpose: schemas are the workspace vocabulary, served
  // to every role like /api/tags.)
  const suggestions = await q(
    `SELECT * FROM ai_suggestions
      WHERE workspace_id = $1
        AND (target_type <> 'node' OR target_id = ANY($2::uuid[]))
      ORDER BY created_at DESC`,
    [workspaceId, returnedNodeIds],
  );
  // Events about notes this reader can read (all of them, tasks included, not
  // just the ones returned above), plus what they may see of the rest
  // (services/eventVisibility.ts).
  const eventParams: unknown[] = [workspaceId];
  const eventScope = eventVisibleSql("domain_events", await eventAudience(actor, workspaceId, new Set(visibleNodeIds)), eventParams);
  const events = await q(
    // Named columns: body_hash/base_hash (migration 162) are server-side lineage, not client data.
    `SELECT id, workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, created_at,
            tx_meta, triggered_by_event_id, external
       FROM domain_events
      WHERE workspace_id = $1 AND ${eventScope}
      ORDER BY id DESC LIMIT 50`,
    eventParams,
  );
  // The tag catalog: the same rows GET /api/tags and the sync delta send
  // (services/tagCatalog.ts), read in this snapshot. The client replaces its
  // stored catalog with this list, so a thinner copy here would drop parent_id,
  // reserved_key and the rest offline (T3). usage_count is one correlated count
  // per tag, as on GET /api/tags.
  const tags = await readTagCatalog(actor, workspaceId);
  const actorIsOwner = actor ? await isWorkspaceOwner(actor) : false;
  const canReview = actor ? await reviewAuthority(actor) : false;
  // Read by id inside the snapshot; a missing note is created by buildBootstrap.
  const { site_config, chrome, configFound } = await readSiteSettings(workspaceId);
  // Global-graph manual positions (node_positions surface='graph'). Replaces the
  // old `_graph_x/_graph_y` node attributes the frontend reads — those writes
  // were rejected by the attribute API, so graph layout never persisted.
  // Only nodes the actor may read (a hidden note's id must not ride out here).
  const graphPositions = await readPositionsForSurface(actor, workspaceId, "graph");
  // Slim mode never reads the bodies (nodeRowColumnsSql markdown:false):
  // markdown is "" and body_len is the length the editor's lazy fetch
  // (nodeNeedsBody on the client) goes by. (The per-node excerpt had no
  // reader in the app; R23.)
  const nodeRows = nodes.rows;
  const wire = compact ? encodeBootstrapNodes(workspaceId, nodeRows, attributes.rows) : null;
  const payload = {
    bodies: slimBodies ? "none" : "full",
    // The per-node channels are absent, not empty: never read as "no notes".
    ...(metaOnly ? { nodes_omitted: true } : {}),
    // Lean: nodes carry no attrs map, and these keys' values are not here.
    ...(lean ? { attrs_omitted: true, deferred_attribute_keys: [...BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS] } : {}),
    last_event_id: lastEventId,
    // Which server's event log the positions count in (the sync delta carries the same; frontend lib/answerPositions.ts).
    ...(await serverIdentityField()),
    membership_epoch: membershipEpoch,
    server_time: serverTime,
    workspace: ws.rows[0] ? workspaceWireRow(ws.rows[0]) : ws.rows[0],
    // Compact (lean2): see bootstrapWire.ts. `nodes`/`attributes` replaced.
    ...(wire ?? { nodes: nodeRows, attributes: attributes.rows }),
    edges: edges.rows,
    tasks: tasks.rows,
    pointers: pointers.rows,
    // Where each readable note's paragraph anchors are (services/blockAnchors); memory-only on the client.
    // A ?nodes=none snapshot says nothing about them (the client keeps what it holds).
    ...(metaOnly ? {} : {
      note_anchors: await anchorRowsForNotes(workspaceId, returnedNodeIds),
      // The links written in those notes and the anchor each means (services/blockLinks.ts).
      note_link_bindings: await bindingRowsForNotes(workspaceId, returnedNodeIds),
    }),
    // Block nodes are always on now (the ONDEN_BLOCK_NODES flag is gone).
    // Shells cached before that (service worker) still read this and show no
    // block-node UI without it; current clients ignore it. Remove one
    // release after the flag removal is deployed, once those shells reloaded.
    // paragraph_anchors: always true now (a block's identity is its anchor); kept on the wire for clients that still read it.
    features: { block_nodes: true, paragraph_anchors: true },
    // The calendar zone of every date rule (localDay.ts), so the client's
    // offline agenda and "today" use it too. Sent when the owner chose one or
    // ONDEN_TIMEZONE is set; otherwise omitted: the server then runs on UTC and
    // the client keeps the browser's zone rather than adopting UTC (a diary
    // before 08:00 in Taipei would otherwise land in yesterday's note). The
    // owner's choice and the day start hour also ride on `workspace`, which the
    // sync delta re-ships when they change.
    ...(ws.rows[0]?.time_zone || config.str("ONDEN_TIMEZONE")?.trim() ? { timezone: dayClock().timeZone } : {}),
    canvas_memberships: canvasMemberships.rows,
    graph_positions: graphPositions,
    suggestions: suggestions.rows,
    events: events.rows,
    // The workspace owner alone changes tag definitions and administers the
    // workspace (spine/authority.ts isWorkspaceOwner); the UI offers those
    // controls only to them.
    actor_is_owner: actorIsOwner,
    // May approve or reject agent changes in the inbox (spine/authority.ts
    // reviewAuthority); the inbox shows its decision buttons only then.
    can_review: canReview,
    // An empty *filtered* list is not an empty workspace. Only an unrestricted
    // principal/admin can treat this projection as an onboarding-empty signal.
    // This is UI eligibility, not a bypass of the normal create/write gates.
    // Meta only carries no node rows to judge by: omitted (the client keeps its own).
    ...(metaOnly ? {} : { example_seed_eligible: actorIsOwner && nodeRows.length === 0 }),
    tags,
    site_config,
    chrome,
  };
  return { payload, configFound };
}
