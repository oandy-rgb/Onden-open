-- A1.8a — prepare to switch tag writes to content_nodes.
--
-- Two things this migration does:
--
-- 1. Add a unique constraint on content_nodes for class_tag rows that
--    mirrors the tags table's old constraint: a class tag's
--    (workspace_id, parent_id, title) must be unique. NULL parent_id
--    is treated as a sentinel root (same trick L1 used on tags).
--
--    The partial index restricts this only to node_type='class_tag'
--    rows — regular content nodes can have duplicate (workspace, parent,
--    title) triples (we never enforced that and don't want to start
--    now).
--
-- 2. DROP the sync trigger from migration 038. After this migration,
--    application code switches tag writes from the `tags` table to
--    content_nodes directly. The trigger no longer has anything to
--    mirror — its sole job was to keep the shadow in step while reads
--    were rewritten. Now that reads are complete (A1.4-A1.6), writes
--    follow.
--
-- The legacy `tags` table is NOT dropped here — that's migration 040
-- (A1.8b), after we've verified writes work against the new substrate.

CREATE UNIQUE INDEX content_nodes_class_tag_workspace_parent_title_uq
  ON content_nodes (
    workspace_id,
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    title
  )
  WHERE node_type = 'class_tag' AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS tags_to_class_tag_sync_aiud ON tags;
DROP FUNCTION IF EXISTS sync_tag_to_class_tag_node();

COMMENT ON INDEX content_nodes_class_tag_workspace_parent_title_uq IS
  'A1.8: enforce uniqueness for class tag identity, replacing tags_workspace_parent_name_uq.';
