-- Scale fix (大量資料). /api/bootstrap computes last_actor / last_modified_at /
-- recent_actors per node via correlated subqueries over domain_events filtered
-- by (target_type, target_id) and ordered by created_at. There was no index on
-- those columns — only (actor_id, …), (workspace_id, …) and triggered_by — so
-- every node full-scanned domain_events: O(nodes × events). Measured at 3000
-- nodes / 9000 events the bootstrap nodes query took ~10.4s; with this index it
-- drops to ~36ms (~290×). The same index also backs eventRestore + any
-- per-target event lookup.
--
-- Plain (non-CONCURRENTLY) so it can run inside migrate()'s single-statement
-- apply; on a single-tenant self-hosted DB the brief write lock at upgrade time
-- is acceptable. Revisit CONCURRENTLY if a deploy ever has a very large
-- domain_events at upgrade.
CREATE INDEX IF NOT EXISTS domain_events_target_idx
  ON domain_events (target_type, target_id, created_at DESC);
