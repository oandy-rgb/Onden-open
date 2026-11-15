// Walks over the causal chain of domain events (triggered_by_event_id): what
// an event set off, and which event started a chain. One place for both, so
// the cascade preview, the batch review and the undo cascade agree on what a
// chain is and none of them can loop on bad data.
//
// Ids only. Event rows carry titles and diffs, so the caller reads the rows it
// needs and applies event visibility (services/eventVisibility.ts) itself.
//
// Cycle safety. triggered_by_event_id is single-valued, so the events
// reachable DOWNWARD from a root form a tree unless the walk comes back to the
// root itself. Refusing to re-enter the root bounds the walk even when bad data
// holds a triggered_by cycle (normal writes cannot make one: a cause is always
// an earlier event).

import { q } from "../db.js";

export type EventChainEntry = { id: string; depth: number };

/** The events `rootEventId` set off, directly or through others, nearest
 *  first (by depth, then id). Depth 1 = triggered by the root.
 *
 *  `includeRoot` puts the root first at depth 0. Every event must be in
 *  `workspaceId`; an unknown root gives []. `maxDepth` keeps only events at
 *  most that many steps from the root (default unbounded; the walk still ends).
 *
 *  Example: the undo cascade —
 *    eventChain(ws, eventId)  // every descendant, root excluded */
export async function eventChain(
  workspaceId: string,
  rootEventId: string,
  opts: { includeRoot?: boolean; maxDepth?: number } = {},
): Promise<EventChainEntry[]> {
  const params: unknown[] = [rootEventId, workspaceId];
  let depthBound = "";
  if (opts.maxDepth !== undefined) {
    params.push(opts.maxDepth);
    depthBound = `AND c.depth < $${params.length}`;
  }
  const r = await q<EventChainEntry>(
    `WITH RECURSIVE chain AS (
       SELECT e.id, 0 AS depth FROM domain_events e
        WHERE e.id = $1::bigint AND e.workspace_id = $2::uuid
       UNION ALL
       SELECT e.id, c.depth + 1 FROM domain_events e
         JOIN chain c ON e.triggered_by_event_id = c.id
        WHERE e.workspace_id = $2::uuid AND e.id <> $1::bigint ${depthBound}
     )
     SELECT id::text, depth FROM chain ${opts.includeRoot ? "" : "WHERE depth > 0"} ORDER BY chain.depth, chain.id`,
    params,
  );
  return r.rows;
}

/** Map each event id to the root of its chain (its topmost triggered_by
 *  ancestor). An event further than `maxDepth` steps from its root, or on a
 *  cyclic chain, maps to itself. (A deleted cause is no break: the foreign key
 *  sets triggered_by_event_id to NULL, so its effect becomes a root.) */
export async function chainRootIds(eventIds: string[], opts: { maxDepth: number }): Promise<Map<string, string>> {
  const roots = new Map<string, string>();
  if (eventIds.length === 0) return roots;
  const r = await q<{ event_id: string; root_id: string }>(
    `WITH RECURSIVE up AS (
       SELECT e.id AS event_id, e.id AS cur_id, e.triggered_by_event_id AS parent_id, 0 AS depth
         FROM domain_events e WHERE e.id = ANY($1::bigint[])
       UNION ALL
       SELECT u.event_id, p.id, p.triggered_by_event_id, u.depth + 1
         FROM up u JOIN domain_events p ON p.id = u.parent_id
        WHERE u.depth < $2
     )
     SELECT event_id::text, cur_id::text AS root_id FROM up WHERE parent_id IS NULL`,
    [eventIds, opts.maxDepth],
  );
  for (const row of r.rows) roots.set(row.event_id, row.root_id);
  for (const id of eventIds) if (!roots.has(id)) roots.set(id, id);
  return roots;
}
