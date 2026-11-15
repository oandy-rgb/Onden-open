// Membership reconciliation reads (depth audit D8, moved from routes/sync.ts):
// the paginated CURRENT readable-id stream and the full projection of ids the
// client found newly readable. Both carry the membership version the client
// checks across pages.

import { sha256Hex } from "../../utils.js";
import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { readableNodeIdSet, restrictRowsToScope } from "../readPolicy.js";
import { taskRowReadable, taskRowsByIds, notATaskNodeSql } from "../tasksStore.js";
import { withActorReadSnapshot } from "../actorReadSnapshot.js";
import { readTagCatalog } from "../tagCatalog.js";
import { anchorRowsForNotes, type AnchorWireRow } from "../blockAnchors/index.js";
import { bindingRowsForNotes } from "../blockLinks.js";
import type { ServerNode } from "@onden/contract";
import { nodeRowColumnsSql, nodeEventMetaJoinSql } from "../nodeRowProjection.js";
import { attributeColumnsSql } from "../syncProjection.js";
import { edgeRowsTouching, pointerRowsTouching, readablePointer } from "./rows.js";
import { MAX_KNOWN_IDS } from "./delta.js";
import { liveNodeSql } from "../../spine/nodeSql.js";

/** A request names more ids than the endpoint serves (413 at the route). */
export class SyncRequestTooLarge extends Error {
  readonly code = "too_many_ids";
  constructor(readonly limit: number) { super(`too many ids (limit ${limit})`); this.name = "SyncRequestTooLarge"; }
}

// ── GET /sync/membership — paginated CURRENT readable-id stream (Step B) ─────
//
// The server does NOT persist a prior per-actor membership, so it cannot compute
// `revoked`/`newlyReadable` from the epoch alone. Instead it streams the CURRENT
// readable id set (ids only — cheap); the CLIENT diffs it against its complete
// local set (option 3, membership-and-permission-epoch.md §4). The client runs
// this ONLY when the epoch advanced (else it stays on the cheap event-cursor).
//
// Pages and hydration share a checked version, not a long-lived transaction.
// Epoch alone misses node creation/deletion; the event position catches those.
// This position is a read guard, NEVER an acknowledgement of scanned events.
export const MEMBERSHIP_PAGE_SIZE = 1000;
/** The largest page a client may ask for (`limit`). */
export const MEMBERSHIP_PAGE_MAX = 5000;

// ── The readable set's digest (GET /sync/membership/digest) ──────────────────
//
// A reopen used to page the whole readable set to find out that nothing
// changed: 20 sequential pages at 20k notes, ~14 s on a phone on 4G. The
// digest lets the client compare first. The rule, which the client repeats
// (frontend lib/data/membershipDigest.ts):
//   • the set's ids, sorted by UTF-16 code unit (JavaScript's default sort),
//     joined with "\n", UTF-8, SHA-256, lower-case hex → `digest`;
//   • a bucket is the ids sharing their first MEMBERSHIP_BUCKET_CHARS
//     characters; each bucket's digest is the same hash over its own ids,
//     cut to its first 16 hex digits → `buckets[prefix]`.
// Equal digests mean equal sets; unequal buckets name where to look, so a
// handful of changed notes costs one small scoped page rather than all of
// them. The digest only ever lets the client SKIP work when the sets match;
// any difference still goes through the paged diff, which removes what is no
// longer readable.
export const MEMBERSHIP_BUCKET_CHARS = 2;
const BUCKET_DIGEST_HEX = 16;

const idsDigest = (ids: readonly string[]) => sha256Hex(ids.join("\n"));

/** Digest + per-bucket digests of an id set (see the rule above). */
export function membershipDigestOf(ids: Iterable<string>): { count: number; digest: string; buckets: Record<string, string> } {
  const sorted = [...ids].sort();
  const groups = new Map<string, string[]>();
  for (const id of sorted) {
    const key = id.slice(0, MEMBERSHIP_BUCKET_CHARS);
    const group = groups.get(key);
    if (group) group.push(id); else groups.set(key, [id]);
  }
  const buckets: Record<string, string> = {};
  for (const [key, group] of groups) buckets[key] = idsDigest(group).slice(0, BUCKET_DIGEST_HEX);
  return { count: sorted.length, digest: idsDigest(sorted), buckets };
}

/** `prefixes` query value → the bucket prefixes it names (lower-case hex of
 *  MEMBERSHIP_BUCKET_CHARS each), or null for none/invalid (= every bucket). */
export function parseBucketPrefixes(raw: string | undefined | null): string[] | null {
  if (!raw) return null;
  const list = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const valid = new RegExp(`^[0-9a-f]{${MEMBERSHIP_BUCKET_CHARS}}$`);
  if (list.length === 0 || list.some((p) => !valid.test(p))) return null;
  return [...new Set(list)];
}

async function membershipVersion(workspaceId: string) {
  const result = await q<{ epoch: string; event_cursor: string }>(
    `SELECT membership_epoch AS epoch,
       COALESCE((SELECT MAX(id) FROM domain_events WHERE workspace_id=$1),0)::text AS event_cursor
     FROM workspaces WHERE id=$1`, [workspaceId],
  );
  return { epoch: Number(result.rows[0].epoch), event_cursor: result.rows[0].event_cursor };
}

function versionChanged(version: { epoch: number; event_cursor: string }, epoch: unknown, eventCursor: unknown) {
  return (epoch != null && String(version.epoch) !== String(epoch))
    || (eventCursor != null && version.event_cursor !== eventCursor);
}

/** The actor's readable set as a digest (see the rule above), read in one
 *  snapshot with the membership version and the tag catalog — what the first
 *  page carries, so a client whose set matches needs nothing else. A version
 *  that moved since the expectation answers retry_required with no digest. */
export async function membershipDigest(
  authenticated: ActorCtx | null,
  workspaceId: string,
  opts: { expectedEpoch?: unknown; expectedEventCursor?: unknown } = {},
) {
  return withActorReadSnapshot(authenticated, workspaceId, async (actor) => {
    const version = await membershipVersion(workspaceId);
    if (versionChanged(version, opts.expectedEpoch, opts.expectedEventCursor)) {
      return { ...version, retry_required: true as const };
    }
    const readable = await readableNodeIdSet(actor, workspaceId);
    return { ...version, ...membershipDigestOf(readable), tags: await readTagCatalog(actor, workspaceId) };
  });
}

/** One page of the actor's readable ids, keyset-paged by `cursor` ("" =
 *  first page, which also carries the tag catalog); `limit` is capped at
 *  MEMBERSHIP_PAGE_MAX (absent or not positive: MEMBERSHIP_PAGE_SIZE).
 *  `prefixes` keeps only the ids of those buckets (the digest's unequal ones).
 *  A version that moved since `expectedEpoch` / `expectedEventCursor` answers
 *  retry_required with no ids — never an empty "revoke everything" page. */
export async function membershipPage(
  authenticated: ActorCtx | null,
  workspaceId: string,
  opts: { cursor: string; expectedEpoch?: unknown; expectedEventCursor?: unknown; limit?: number; prefixes?: string[] | null },
) {
  const { cursor } = opts;
  const limitRaw = opts.limit ?? NaN;
  const pageSize = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, MEMBERSHIP_PAGE_MAX)
    : MEMBERSHIP_PAGE_SIZE;
  const prefixes = opts.prefixes?.length ? new Set(opts.prefixes) : null;
  const expected = opts.expectedEpoch;
  const expectedEventCursor = opts.expectedEventCursor;
  return withActorReadSnapshot(authenticated, workspaceId, async (actor) => {
    const version = await membershipVersion(workspaceId);
    // An empty page with a stale expectation is a retry, never a revoke-all set.
    if (versionChanged(version, expected, expectedEventCursor)) {
      return { ids: [], next_cursor: null, ...version, retry_required: true };
    }
    const readable = await readableNodeIdSet(actor, workspaceId);

    // Keyset page over the sorted id set — a stable, terminating scan (no OFFSET
    // skip/dup) while the version holds.
    const scoped = prefixes ? [...readable].filter((id) => prefixes.has(id.slice(0, MEMBERSHIP_BUCKET_CHARS))) : [...readable];
    const sorted = scoped.sort();
    const startIdx = cursor ? sorted.findIndex((id) => id > cursor) : 0;
    const slice = startIdx < 0 ? [] : sorted.slice(startIdx, startIdx + pageSize);
    const nextCursor = slice.length === pageSize ? slice[slice.length - 1]! : null;
    return { ids: slice, next_cursor: nextCursor, ...version,
      // Scope changes need a catalog replacement even if no tag event exists.
      // Transmit once per checked membership scan, never on every poll/page.
      ...(cursor === "" ? { tags: await readTagCatalog(actor, workspaceId) } : {}),
    };
  });
}

// ── POST /sync/nodes — FULL projection for a set of ids (Step B2 / review #3) ─
//
// The membership stream returns ids only; after the client diffs it against its
// local set, it fetches the CONTENT of newly-readable ids here. Returns the SAME
// channels as a /api/sync upsert — nodes + attributes + edges + tasks — so the
// client builds a complete delta and applySync persists EVERY channel (not just
// node rows). Returning node rows alone left "epoch saved but projection
// incomplete" (no local node_attributes, no edges, no task rows) once the interim
// known[] path is retired (review #3). Everything is RE-FILTERED through
// readableNodeIdSet (defense-in-depth: never serve a row the actor can't read,
// even if asked); edges/tasks require BOTH endpoints readable (no existence leak).
const NO_ANCHORS: { upsert: AnchorWireRow[]; replace_for: string[] } = { upsert: [], replace_for: [] };

export async function nodesFor(
  authenticated: ActorCtx | null,
  workspaceId: string,
  ids: string[],
  opts: { expectedEpoch?: unknown; expectedEventCursor?: unknown } = {},
) {
  return withActorReadSnapshot(authenticated, workspaceId, async (actor) => {
    // Silent truncation lets the client save an epoch with missing projections.
    if (ids.length > MAX_KNOWN_IDS) throw new SyncRequestTooLarge(MAX_KNOWN_IDS);
    const version = await membershipVersion(workspaceId);
    if (versionChanged(version, opts.expectedEpoch, opts.expectedEventCursor)) {
      return { nodes: [], attributes: { upsert: [], delete: [] }, edges: [], tasks: [], note_anchors: NO_ANCHORS, ...version, retry_required: true };
    }
    if (ids.length === 0) {
      return { nodes: [], attributes: { upsert: [], delete: [] }, edges: [], tasks: [], note_anchors: NO_ANCHORS, ...version };
    }
    const readableSet = await readableNodeIdSet(actor, workspaceId);
    // Non-task content nodes (task nodes travel as synthesized task rows below).
    const nodesRes = await q<ServerNode>(
      `SELECT ${nodeRowColumnsSql("n")}
       FROM content_nodes n
       ${nodeEventMetaJoinSql("n")}
       WHERE n.workspace_id = $1 AND n.id = ANY($2::uuid[]) AND ${liveNodeSql("n")}
         AND ${notATaskNodeSql("n")}`,
      [workspaceId, ids],
    );
    // The requested non-task nodes' attributes (the attributes CHANNEL — so the
    // client persists them to its local node_attributes, which a node upsert alone
    // does not). A task node's attributes travel inside its task row, as in the
    // bootstrap and the delta; rows sent here would never be updated or removed.
    const attrsRes = await q(
      `SELECT ${attributeColumnsSql("na")}
       FROM node_attributes na
       JOIN content_nodes n ON n.id = na.node_id AND ${liveNodeSql("n")}
       WHERE na.workspace_id = $1 AND na.node_id = ANY($2::uuid[])
         AND ${notATaskNodeSql("n")}`,
      [workspaceId, ids],
    );
    // Edges touching any requested node, both endpoints alive (filtered to both-
    // readable below).
    const edgesRes = { rows: await edgeRowsTouching(workspaceId, ids) };
    // Synthesized task rows for any requested task-node ids.
    const taskRows = await taskRowsByIds(workspaceId, ids);
    const pointerRows = await pointerRowsTouching(workspaceId, ids);

    const nodes = restrictRowsToScope(nodesRes.rows, (r) => r.id as string, readableSet);
    const attributes = restrictRowsToScope(attrsRes.rows, (r) => r.node_id as string, readableSet);
    const edges = edgesRes.rows.filter(
      (r) => readableSet.has(r.source_node_id as string) && readableSet.has(r.target_node_id as string),
    );
    const tasks = taskRows.filter((r) => taskRowReadable(readableSet, r));
    const pointers = pointerRows.filter((r) => readablePointer(r, readableSet));
    // The readable requested notes' paragraph anchors, complete for them (the client replaces what it holds).
    const noteIds = nodes.map((r) => r.id as string);
    const note_anchors = { upsert: await anchorRowsForNotes(workspaceId, noteIds), replace_for: noteIds };
    const note_link_bindings = { upsert: await bindingRowsForNotes(workspaceId, noteIds), replace_for: noteIds };
    return { nodes, attributes: { upsert: attributes, delete: [] }, edges, tasks, pointers, note_anchors, note_link_bindings, ...version };
  });
}
