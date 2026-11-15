-- Soft-delete substrate for content_nodes (ER5.5).
--
-- Maps Onden's deletion model onto NixOS's deletion mechanism. The README
-- already cites NixOS analogies (immutable store paths ↔ blobs; atomic
-- rollback / generations ↔ version chain); this migration adds the
-- profile-pointer half of the same pattern — the part that says "this
-- generation no longer references the path" rather than removing the
-- path itself. Reference-counted GC of blobs + old versions is the
-- follow-on (ER5.6) that completes the NixOS-aligned cycle:
--
--   NixOS                                Onden equivalent
--   ─────────────────────────────────    ────────────────────────────────
--   Store paths                          blobs (migration 030)
--   Generations                          content_node_versions chain
--   Profile pointer ("current")          content_nodes + deleted_at (this)
--   nix-collect-garbage                  prune job (ER5.6, deferred)
--   --delete-older-than N                soft-delete retention window
--
-- Without this migration the ER4 NODE_DELETED → restore flow is broken:
-- content_nodes has 8 FK references with ON DELETE CASCADE, so a hard
-- DELETE wipes content_node_versions (the whole version chain + blob
-- links), node_attributes, node_tags, node_edges, node_block_ids,
-- note_pointers, and node_tasks. Restoring from tx_meta.prev_field_values
-- only brings back the content_nodes row itself — every dependent table
-- is gone. That contradicts Onden's "traceable, not silently mutable"
-- design philosophy AND defeats the strong-event-restore plan from ER1-5.
--
-- The NixOS-aligned fix: don't remove the row; mark it as "not in current
-- generation" with deleted_at. All dependent rows stay (versions, attrs,
-- tags, edges); undelete is a single UPDATE deleted_at = NULL that
-- flips the node back into view. Eventual hard removal happens via the
-- prune job (ER5.6) once a configurable retention window has passed AND
-- no live version chain still references the blobs.
--
-- Reference (memory/feedback_problem_solving_reference_first): every ref
-- note app evaluated treats note deletion as soft-state:
--   - Trilium notes.isDeleted + deleteId (Trilium-main/packages/
--     trilium-core/src/assets/schema.sql) — same pattern, different
--     column names.
--   - SiYuan trash folder (kernel/model/box.go) — moves the .sy file to
--     a per-notebook trash dir rather than rm-rf.
--   - Joplin notes.is_conflict / notes.deleted_time (joplin-dev/
--     packages/lib/services/database/types.ts) — Joplin's E2EE sync
--     requires soft delete to propagate the tombstone.
--   - Logseq tx-data carries :db/retract for individual properties; full
--     block deletion goes through a recycle queue (handler/page.cljs).
-- None of them hard-DELETE the row. Onden was the outlier.

ALTER TABLE content_nodes
  ADD COLUMN IF NOT EXISTS deleted_at          timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by_event_id bigint REFERENCES domain_events(id) ON DELETE SET NULL;

-- Hot-path partial index for the "list live nodes in this workspace"
-- query, which is by far the most common read. Existing
-- content_nodes(workspace_id) indexes still serve admin / trash-bin
-- queries that want to include deleted rows.
CREATE INDEX IF NOT EXISTS content_nodes_active_idx
  ON content_nodes (workspace_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS content_nodes_deleted_idx
  ON content_nodes (workspace_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN content_nodes.deleted_at IS
  'Soft-delete tombstone. NULL = live; non-NULL = trashed at this time.'
  ' All FK-CASCADE dependents (versions, attributes, tags, edges, '
  'block_ids, pointers, tasks) survive the delete, so undelete is a '
  'single UPDATE deleted_at = NULL that brings everything back.';

COMMENT ON COLUMN content_nodes.deleted_by_event_id IS
  'FK to the NODE_DELETED domain_event that wrote the tombstone. Lets the '
  'restore flow find the originating event without timestamp matching.';
