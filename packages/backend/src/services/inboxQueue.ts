// The inbox's apply-then-review queue as a read model (depth audit D13,
// moved verbatim from routes/inbox.ts GET /): filters, grouping by
// triggered_by root, and facet counts, all over the events this reader may
// see (services/eventVisibility.ts), with the rule applied in SQL before the
// 500-row scan window.

import { pool } from "../db.js";
import type { ActorCtx } from "../types.js";
import { readableNodeIdSet } from "./readPolicy.js";
import { eventAudience, eventVisible, eventVisibleSql } from "./eventVisibility.js";
import { chainRootIds, eventChain } from "./eventChain.js";

import { isRestorable } from "./restoreContract.js";

// AGENT_TOOL_CALLED / AGENT_TOOL_FAILED are per-call AUDIT envelopes, not
// reviewable changes — every agent action already emits its own mutation
// event (NODE_*, TAG_*, ATTRIBUTE_*). Surfacing the audit event too would
// double every row in the governance queue and offer an Approve/Reject on
// something that has no inverse. Keep them in the log; exclude them here.
export const AUDIT_EVENT_TYPES = ["AGENT_TOOL_CALLED", "AGENT_TOOL_FAILED"];

/** An AI's suggestion is listed while a place of it still waits for the person (pending, or stale and
 *  not yet dismissed): the same set the note's suggestion bar draws. Once every place is accepted,
 *  rejected, or gone, the event is only a record and leaves the queue by itself; deciding a place
 *  is not a review of the event, so no event_reviews row is written for it. */
export const suggestionStillWaitingSql = (eventAlias: string) =>
  // The suggestion is found through the id the event records (its primary key), not through a column that has no index.
  `(${eventAlias}.event_type <> 'AI_SUGGESTION_CREATED' OR EXISTS (
      SELECT 1 FROM ai_edit_suggestions s JOIN ai_edit_suggestion_items i ON i.suggestion_id = s.id
       WHERE s.id = CASE WHEN ${eventAlias}.event_type = 'AI_SUGGESTION_CREATED' THEN (${eventAlias}.payload->>'suggestion_id')::uuid END
         AND i.status IN ('pending', 'stale')))`;

export type InboxEventRow = {
  id: string; actor_type: string; actor_id: string; actor_name: string | null;
  event_type: string; target_type: string; target_id: string;
  payload: Record<string, unknown> | null;
  created_at: string; tx_meta: unknown; external: boolean;
  triggered_by_event_id: string | null;
};


// GET /api/inbox — the apply-then-review queue, now with FILTERS + GROUPING
// (the feed traffic upgrade):
//   • ?actor_id= / ?event_type= / ?since=<ISO>  narrow the queue;
//   • every event carries root_event_id (its triggered_by root);
//   • `groups`: events sharing a root are collapsed server-side into one row
//     {root_event, count, sample_titles, actor} — an RSS fetch batch becomes
//     a single "RSS: 12 new articles" card;
//   • `facets`: {by_actor, by_type} counts over the (read-policy-filtered)
//     queue BEFORE the actor/type narrowing, so the UI renders filter chips
//     with numbers.
// Read-policy filtering is unchanged (post-fix semantics): node-targeted
// events are bounded by the caller's COMBINED read set, non-node events stay
// visible to humans but hidden from tag-scoped bearer tokens.
export type InboxQueueFilters = {
  /** At most this many events in `events` (1–500). */
  limit: number;
  actorId: string | null;
  eventType: string | null;
  /** ISO datetime, already validated. */
  since: string | null;
};

export async function inboxQueue(actor: ActorCtx | null, workspaceId: string, filters: InboxQueueFilters) {
  const { limit, actorId: actorIdFilter, eventType: eventTypeFilter, since: sinceRaw } = filters;
  // An event is in the inbox iff it has no event_reviews row (anti-join).
  // `since` narrows in SQL; actor/type narrow AFTER the facet counts so the
  // chips can show what filtering would yield. The scan window is fixed at
  // the 500 cap (not `limit`) so facets/groups see the whole queue.
  // The governance queue is ALSO a read surface — NODE_CREATED/NODE_UPDATED
  // payloads carry titles (and body hashes/diffs). It follows the same rule as
  // /api/events (services/eventVisibility.ts): note events for the note's
  // readers, the rest by tag definition, space membership, owner or author.
  // The rule runs in SQL BEFORE the 500 cap, so events the viewer can't see
  // never use up the window (filtering after LIMIT under-filled the queue).
  // (Same accepted consequence as /api/events: an event whose target note is
  // soft-deleted drops out of the list.) Facets and groups are computed over
  // this same filtered set — a hidden article is absent from chips AND from
  // batch counts, not just from the flat list.
  const audience = await eventAudience(actor, workspaceId, await readableNodeIdSet(actor, workspaceId));
  const params: unknown[] = [workspaceId, AUDIT_EVENT_TYPES, sinceRaw];
  const visibleSql = eventVisibleSql("e", audience, params);
  const result = await pool.query<InboxEventRow>(
    `SELECT e.id::text, e.actor_type, e.actor_id, a.name AS actor_name,
            e.event_type, e.target_type,
            e.target_id, e.payload, e.created_at, e.tx_meta, e.external,
            e.triggered_by_event_id::text
       FROM domain_events e
       LEFT JOIN event_reviews r ON r.event_id = e.id
       LEFT JOIN actors a ON a.id::text = e.actor_id
      WHERE e.workspace_id = $1
        AND e.actor_type = 'ai_agent'
        AND e.event_type <> ALL($2::text[])
        AND r.event_id IS NULL
        AND ${suggestionStillWaitingSql("e")}
        AND ($3::timestamptz IS NULL OR e.created_at >= $3::timestamptz)
        AND ${visibleSql}
      ORDER BY e.id DESC
      LIMIT 500`,
    params,
  );
  const visibleAll = result.rows;

  // Facet counts BEFORE actor/type narrowing (so a chip shows its yield).
  const byActor = new Map<string, { actor_id: string; actor_name: string | null; count: number }>();
  const byType = new Map<string, number>();
  for (const e of visibleAll) {
    const a = byActor.get(e.actor_id) ?? { actor_id: e.actor_id, actor_name: e.actor_name, count: 0 };
    a.count++;
    byActor.set(e.actor_id, a);
    byType.set(e.event_type, (byType.get(e.event_type) ?? 0) + 1);
  }

  const visible = visibleAll.filter((e) =>
    (!actorIdFilter || e.actor_id === actorIdFilter) &&
    (!eventTypeFilter || e.event_type === eventTypeFilter),
  );

  // Group-by-root: collapse events sharing a triggered_by root. The cascade
  // chain is the spine's own provenance (mutate() nests → triggered_by), so a
  // batch (e.g. a body's derived attributes) needs zero extra bookkeeping.
  // Twenty steps up: an event further from its root groups under itself.
  const roots = await chainRootIds(visible.map((e) => e.id), { maxDepth: 20 });
  const byRoot = new Map<string, InboxEventRow[]>();
  for (const e of visible) {
    const root = roots.get(e.id)!;
    const list = byRoot.get(root) ?? [];
    list.push(e);
    byRoot.set(root, list);
  }
  const groupRoots = [...byRoot.entries()].filter(([, members]) => members.length >= 2);
  // Root rows for labeling (a root may itself be filtered out or reviewed).
  const rootRows = new Map<string, InboxEventRow>();
  if (groupRoots.length > 0) {
    const rr = await pool.query<InboxEventRow>(
      `SELECT e.id::text, e.actor_type, e.actor_id, a.name AS actor_name,
              e.event_type, e.target_type, e.target_id, e.payload, e.created_at,
              e.tx_meta, e.external, e.triggered_by_event_id::text
         FROM domain_events e
         LEFT JOIN actors a ON a.id::text = e.actor_id
        WHERE e.id = ANY($1::bigint[])`,
      [groupRoots.map(([root]) => root)],
    );
    for (const row of rr.rows) rootRows.set(row.id, row);
  }
  const groups = groupRoots.map(([root, members]) => {
    const rootRow = rootRows.get(root) ?? null;
    // SECURITY: the root row is fetched by id with NO read-policy filter, so its
    // payload/target_id must be gated by the SAME visibility rule as the members
    // before it goes on the wire — otherwise a group whose root the caller may
    // not see leaks its title/payload via root_event. The group still shows via
    // its (already-filtered) members + sample_titles.
    const rootVisible = !!rootRow && eventVisible(rootRow, audience);
    const titles: string[] = [];
    for (const m of members) {
      const t = (m.payload as Record<string, unknown> | null)?.title;
      if (typeof t === "string" && t && !titles.includes(t)) titles.push(t);
      if (titles.length >= 3) break;
    }
    return {
      root_event_id: root,
      count: members.length,
      sample_titles: titles,
      actor_id: members[0]!.actor_id,
      actor_name: members[0]!.actor_name,
      event_ids: members.map((m) => m.id),
      latest_created_at: members[0]!.created_at,
      root_event: rootVisible && rootRow ? {
        id: rootRow.id,
        event_type: rootRow.event_type,
        target_type: rootRow.target_type,
        target_id: rootRow.target_id,
        payload: rootRow.payload,
        created_at: rootRow.created_at,
      } : null,
    };
  });

  const events = visible.slice(0, limit).map((e) => ({
    // The restore rule itself (restoreContract.ts): reject-and-revert is
    // offered exactly where restoreEvent does not refuse up front.
    ...e, restorable: isRestorable(e), root_event_id: roots.get(e.id)!,
  }));
  return {
    events,
    count: events.length,
    groups,
    facets: {
      by_actor: [...byActor.values()].sort((a, b) => b.count - a.count),
      by_type: [...byType.entries()].map(([event_type, count]) => ({ event_type, count }))
        .sort((a, b) => b.count - a.count),
    },
  };
}

/** The chain's unreviewed, reviewable agent events that `actor` may see. Same
 *  rule as the queue: an event the reviewer may not see is neither listed,
 *  counted, nor decided (no existence leak, no blind governance). */
export async function loadGroupMembers(workspaceId: string, rootEventId: string, actor: ActorCtx) {
  const chain = await eventChain(workspaceId, rootEventId, { includeRoot: true });
  const r = await pool.query<{ id: string; event_type: string; target_type: string; target_id: string; actor_id: string | null; payload: Record<string, unknown> | null; tx_meta: unknown }>(
    `SELECT e.id::text, e.event_type, e.target_type, e.target_id, e.actor_id, e.payload, e.tx_meta
       FROM domain_events e
       LEFT JOIN event_reviews r ON r.event_id = e.id
      WHERE e.id = ANY($1::bigint[])
        AND e.actor_type = 'ai_agent'
        AND e.event_type <> ALL($2::text[])
        AND r.event_id IS NULL
        AND ${suggestionStillWaitingSql("e")}
      ORDER BY e.id ASC`,
    [chain.map((e) => e.id), AUDIT_EVENT_TYPES],
  );
  const audience = await eventAudience(actor, workspaceId, await readableNodeIdSet(actor, workspaceId));
  return r.rows.filter((e) => eventVisible(e, audience));
}
