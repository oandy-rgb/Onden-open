-- Remove the sandbox subsystem (rebuild-foundation decision #9).
--
-- The sandbox was a separate "second world" staging container with its own
-- scope/participants/CoW-merge-review flow. It is removed: agent writes go
-- through the spine directly (attributed + reversible), and content_node_versions
-- reverts to PURE history. This drops:
--   - the sandbox tables (sandboxes, sandbox_participants, sandbox_nodes,
--     sandbox_drafts)
--   - the CoW/pending columns on content_node_versions (is_pending,
--     merge_threshold, merged_at, approved_by) + the pending inbox index
--   - the actor trust/isolation columns (isolation_level, agent_subtype) and
--     the workspace default_agent_threshold
--
-- KEPT: content_node_versions.actor_id — that's "who authored this version",
-- legitimate history attribution, not sandbox state.

DROP TABLE IF EXISTS sandbox_nodes;
DROP TABLE IF EXISTS sandbox_participants;
DROP TABLE IF EXISTS sandboxes;
DROP TABLE IF EXISTS sandbox_drafts;

DROP INDEX IF EXISTS content_node_versions_pending_idx;
ALTER TABLE content_node_versions
  DROP COLUMN IF EXISTS is_pending,
  DROP COLUMN IF EXISTS merge_threshold,
  DROP COLUMN IF EXISTS merged_at,
  DROP COLUMN IF EXISTS approved_by;

ALTER TABLE workspaces DROP COLUMN IF EXISTS default_agent_threshold;

ALTER TABLE actors
  DROP COLUMN IF EXISTS isolation_level,
  DROP COLUMN IF EXISTS agent_subtype;
