// The event log as a read model for routes/events.ts: the list query (filters
// and the read policy folded into its SQL) and the cascade preview. The route
// parses the request, calls these and answers.

import { pool } from "../db.js";
import type { ActorCtx } from "../types.js";
import { READ_ONLY_TOOL_NAMES } from "./agentTools/index.js";
import { eventChain } from "./eventChain.js";
import { NODE_TARGET_TYPES_SQL } from "./eventTargets.js";
import { eventAudience, eventVisible, eventVisibleSql, type EventAudience } from "./eventVisibility.js";
import { parseFlag, safeParsePage } from "./paging.js";
import { readableNodeIdSet, readableTrashedNodeIds } from "./readPolicy.js";
import { restoreBlockedReason } from "./restoreContract.js";

export type EventQueryInput = {
  since?: string | null;
  event_type?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  actor_type?: string | null;
  actor_id?: string | null;
  limit?: string | null;
  /** "1": History's "Deleted" view — only deletes whose note is still deleted
   *  by that very event (DELETE_EVENTS_STILL_HOLDING); each row also carries
   *  `target_space_id`, the deleted note's space. A note deleted for good
   *  (NODES_PURGED) has no row left to hold, so it drops out. */
  deleted?: string | null;
};

/** Event types that delete a note, as recorded (services/restoreContract.ts
 *  maps the older ones to NODE_DELETED). */
const DELETE_EVENT_TYPES = ["NODE_DELETED", "CANVAS_DELETED", "COLLECTION_SCHEMA_DELETED"];

/** History's "Deleted" view: a delete whose note it still holds (a note's
 *  deleted_by_event_id is this event; markLive clears it), leaving out a note deleted along with
 *  another one whose delete still holds — it comes back with that one, so the
 *  view lists what to restore, once. Restored, the row drops out. */
const DELETE_EVENTS_STILL_HOLDING = `
  EXISTS (SELECT 1 FROM content_nodes dn
           WHERE dn.workspace_id = domain_events.workspace_id
             AND dn.deleted_by_event_id = domain_events.id)
  AND NOT EXISTS (SELECT 1 FROM content_nodes cn
                   WHERE cn.workspace_id = domain_events.workspace_id
                     AND cn.deleted_by_event_id = domain_events.triggered_by_event_id)`;

export type BuiltQuery =
  | { kind: "ok"; sql: string; params: unknown[]; limit: number }
  | { kind: "error"; error: string };

// Read policy folded INTO the SQL so it binds BEFORE the LIMIT (finding 4): the
// page is filled with `limit` READABLE events, instead of fetching `limit` raw
// rows and filtering them down afterwards (which returned near-empty pages when
// the latest window was mostly restricted-node events, and amplified the cursor
// skip in finding 1).
// Who sees which event: services/eventVisibility.ts.
export type EventReadPolicy = EventAudience;

const VALID_ACTOR_TYPES = new Set(["user", "ai_agent", "system"]);
const EVENT_PAGE = { default: 100, max: 500 };

// Pure: build a parameterized SQL + params array, or return a validation error.
// Workspace id is always param $1; remaining params follow.
//
// Ordering depends on `since` (finding 1): a forward read (`since` set) returns
// OLDEST-first ASC so the caller can advance its cursor through EVERY event in
// the gap, looping until a short page — losslessly draining a burst larger than
// `limit`. The old `ORDER BY id DESC` returned only the newest `limit` ids > since,
// so once the client jumped its cursor to the max, anything below the returned
// window was skipped forever. The initial load (no `since`) keeps DESC: the
// latest page, newest-first, for the timeline's first paint.
export function buildEventQuery(
  workspaceId: string,
  q: EventQueryInput,
  readPolicy?: EventReadPolicy,
): BuiltQuery {
  const clean = (v: string | null | undefined): string | null => {
    if (v === undefined || v === null) return null;
    const t = String(v).trim();
    return t === "" ? null : t;
  };

  const since      = clean(q.since);
  const eventType  = clean(q.event_type);
  const targetType = clean(q.target_type);
  const targetId   = clean(q.target_id);
  const actorType  = clean(q.actor_type);
  const actorId    = clean(q.actor_id);
  const limitRaw   = clean(q.limit);
  const deleted    = clean(q.deleted);

  // Page size: services/paging.ts (the one limit grammar). `since` is this
  // log's event-id cursor, so there is no offset.
  const paged = safeParsePage({ limit: limitRaw }, EVENT_PAGE);
  if (!paged.ok) return { kind: "error", error: paged.error };
  const { limit } = paged.page;

  if (since !== null && !/^\d+$/.test(since)) {
    return { kind: "error", error: "since must be a non-negative integer" };
  }
  // \d+ alone still lets a 20-digit cursor through to `$n::bigint`, where
  // Postgres throws "value out of range for type bigint" → 500. Reject
  // anything beyond int8 range here (boundary sweep finding).
  if (since !== null && BigInt(since) > 9223372036854775807n) {
    return { kind: "error", error: "since is out of range" };
  }
  if (actorType !== null && !VALID_ACTOR_TYPES.has(actorType)) {
    return { kind: "error", error: "actor_type must be one of: user, ai_agent, system" };
  }

  const where: string[] = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];

  if (since !== null)      { params.push(since);      where.push(`id > $${params.length}::bigint`); }
  if (eventType !== null)  { params.push(eventType);  where.push(`event_type = $${params.length}`); }
  if (targetType !== null) { params.push(targetType); where.push(`target_type = $${params.length}`); }
  if (targetId !== null)   { params.push(targetId);   where.push(`target_id = $${params.length}`); }
  if (actorType !== null)  { params.push(actorType);  where.push(`actor_type = $${params.length}`); }
  if (actorId !== null)    { params.push(actorId);    where.push(`actor_id = $${params.length}`); }
  // A successful read-only tool call is audit noise, not history (the audit
  // table keeps it); failed calls still list. Names are code constants.
  where.push(`NOT (event_type = 'AGENT_TOOL_CALLED' AND target_id IN (${READ_ONLY_TOOL_NAMES.map((n) => `'${n}'`).join(", ")}))`);
  // Anchor bookkeeping (services/blockAnchors) is not history a person made; asked for by name it still lists.
  if (eventType === null || !eventType.startsWith("BLOCK_ANCHOR_")) where.push(`event_type NOT LIKE 'BLOCK\\_ANCHOR\\_%'`);
  if (deleted !== null && deleted !== "0") {
    params.push(DELETE_EVENT_TYPES);
    where.push(`event_type = ANY($${params.length}::text[])`, DELETE_EVENTS_STILL_HOLDING);
  }

  // Read-policy clause (finding 4) — bound BEFORE the LIMIT below
  // (services/eventVisibility.ts). target_id is stored as text.
  if (readPolicy) where.push(eventVisibleSql("domain_events", readPolicy, params));

  const order = since !== null ? "ASC" : "DESC";
  params.push(limit);
  // ER7: surface tx_meta, external, triggered_by_event_id; the route derives
  // `restorable` from them and the timeline renders the cause→effect tree.
  // A drawing conflict recorded before D90 carries both drawings inline (MBs
  // each): a list answers without them, as the newer records do (blob refs;
  // services/attributeWrites.ts conflictRecord). The revert reads them itself.
  const sql = `
    SELECT id, actor_type, actor_id, event_type, target_type, target_id,
           CASE WHEN event_type = 'ATTRIBUTE_CONFLICT' AND payload->>'key' IN ('ink_data', 'board_ink', 'note_ink')
                THEN payload - 'incoming_value' - 'overridden_value' ELSE payload END AS payload,
           created_at, tx_meta, external, triggered_by_event_id${deleted !== null && deleted !== "0" ? `,
           -- the deleted note's space: who may delete it for good is decided
           -- there (services/nodeTrash.ts purgeDeleted), and the app shows
           -- 永久刪除 by the same rule (lib/capabilities.ts canPurgeDeleted)
           (SELECT n.space_id::text FROM content_nodes n
             WHERE n.workspace_id = domain_events.workspace_id AND n.id::text = domain_events.target_id) AS target_space_id` : ""}
    FROM domain_events
    WHERE ${where.join(" AND ")}
    ORDER BY id ${order}
    LIMIT $${params.length}
  `;

  return { kind: "ok", sql, params, limit };
}

/** The events `actor` may see under `filters`, each with whether Restore is
 *  offered (D33: by the rule restoreEvent itself refuses with,
 *  services/restoreContract.ts; state-dependent refusals — target gone,
 *  conflicts, authority — still answer at click time). `error` is a 400 message. */
export async function listEvents(
  actor: ActorCtx | null, workspaceId: string, filters: EventQueryInput,
): Promise<{ events: Array<Record<string, unknown>> } | { error: string }> {
  // Who sees which event: services/eventVisibility.ts. The "Deleted" view is
  // about notes no longer live: their events are read by whoever may read the
  // deleted note (the same rule restore uses).
  const deletedView = parseFlag(filters.deleted);
  const readable = deletedView
    ? await readableTrashedNodeIds(actor, workspaceId)
    : await readableNodeIdSet(actor, workspaceId);
  const built = buildEventQuery(workspaceId, filters, await eventAudience(actor, workspaceId, readable));
  if (built.kind === "error") return { error: built.error };
  const result = await pool.query<{ event_type: string; external: boolean; tx_meta: unknown }>(built.sql, built.params);
  return {
    events: result.rows.map((row) => {
      const reason = restoreBlockedReason(row);
      return { ...row, restorable: reason === null, restore_blocked_reason: reason };
    }),
  };
}

/** What ELSE comes back with event `eventId` (P1 governance): the triggered_by
 *  descendant tree, each touched target named, at most 50 rows. A restricted
 *  node's existence is COUNTED but its identity is redacted. No state change. */
export async function cascadePreview(actor: ActorCtx | null, workspaceId: string, eventId: string) {
  // The list names events ten steps deep; the undo cascade itself is unbounded,
  // so `total` counts the whole chain (one cheap walk, no undo work) and lets
  // the UI warn before a large cascade holds the workspace's writes.
  const fullChain = await eventChain(workspaceId, eventId);
  const total = fullChain.length;
  const chain = fullChain.filter((e) => e.depth <= 10);
  const rows = await pool.query<{
    id: string; event_type: string; target_type: string; target_id: string; actor_id: string | null; payload: Record<string, unknown> | null; tx_meta: unknown;
    external: boolean; depth: number; title: string | null;
  }>(
    `SELECT e.id::text, e.event_type, e.target_type, e.target_id, e.actor_id, e.payload, e.tx_meta, e.external, d.depth,
            n.title
       FROM unnest($1::bigint[], $2::int[]) AS d(id, depth)
       JOIN domain_events e ON e.id = d.id
  LEFT JOIN content_nodes n ON e.target_type IN ${NODE_TARGET_TYPES_SQL} AND n.id::text = e.target_id
      ORDER BY d.depth ASC, d.id ASC
      LIMIT 51`,
    [chain.map((e) => e.id), chain.map((e) => e.depth)],
  );
  const readable = await readableNodeIdSet(actor, workspaceId);
  const audience = await eventAudience(actor, workspaceId, readable);
  // The query fetched one past the page (LIMIT 51) so `truncated` can say there is more.
  const pageSize = 50;
  const events = rows.rows.slice(0, pageSize).map((r) => {
    const visible = eventVisible(r, audience);
    return {
      id: r.id,
      event_type: r.event_type,
      target_type: r.target_type,
      external: r.external,
      // redacted targets keep their row (the count stays honest) but lose identity
      target_id: visible ? r.target_id : null,
      title: visible ? r.title : null,
      redacted: !visible,
    };
  });
  return { count: events.length, total, truncated: rows.rows.length > pageSize, events };
}
