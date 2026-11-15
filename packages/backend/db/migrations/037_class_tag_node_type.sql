-- A1 main — tag-as-node convergence.
--
-- Per thesis 2026-06-05 「心智模型統一 + 少模型組合多內容」:
-- a class tag IS a node, not a separate entity. After this migration:
--
--   content_nodes.node_type IN ('content', 'class_tag')
--
-- Each existing tag becomes a row in content_nodes with the SAME UUID,
-- so all existing FKs (node_tags.tag_id, collection_views.tag_id,
-- tags.parent_id self-ref) keep working — they just point at the same
-- UUID which now lives in both tables.
--
-- This makes the migration safe: existing code continues to query
-- `tags` and gets the right rows; new code can query content_nodes
-- WHERE node_type='class_tag' and gets the same rows. Subsequent
-- commits rewrite consumers to use the new path, then a later commit
-- drops the tags table once nothing reads from it.
--
-- Reference for the pattern: see project_feature_tag_systems memory.
-- Tana / Logseq both use this model in greenfield; Onden converges
-- here via a "shadow row in content_nodes with same UUID" trick.
--
-- Verification before (2026-06-05 11 tags, 0 label tags, 4 phantom FKs):
--   See: SELECT COUNT(*) FROM tags;
--   See: project_er_series_shipped — restore/Trash auto-apply to nodes
--        so class_tag nodes get audit + restore for free.

-- 1. Extend the node_type CHECK to include 'class_tag'.
ALTER TABLE content_nodes
  DROP CONSTRAINT content_nodes_node_type_check;
ALTER TABLE content_nodes
  ADD CONSTRAINT content_nodes_node_type_check
  CHECK (node_type IN ('content', 'class_tag'));

-- 2. Add tag-specific nullable columns to content_nodes.
-- These are only meaningful for node_type='class_tag' rows.
-- color is hex string (matches tags.color shape); schema_id links to
-- the collection_schemas row that defines the tag's fields.
ALTER TABLE content_nodes
  ADD COLUMN tag_color text,
  ADD COLUMN tag_schema_id uuid REFERENCES collection_schemas(id) ON DELETE SET NULL;

CREATE INDEX content_nodes_class_tag_idx
  ON content_nodes (workspace_id, node_type)
  WHERE node_type = 'class_tag';

-- 3. INSERT a content_node row for each existing tag, preserving UUID.
-- This is the "shadow row" — same id as the tag, so existing FKs work.
INSERT INTO content_nodes (
  id, workspace_id, source_type, node_type, title, slug, markdown,
  parent_id, tag_color, tag_schema_id, sort_order, created_at, updated_at
)
SELECT
  t.id,
  t.workspace_id,
  'manual'::text                          AS source_type,
  'class_tag'::text                       AS node_type,
  t.name                                  AS title,
  -- prefix to avoid collision with content slugs
  'tag-' || regexp_replace(lower(t.name), '[^a-z0-9-]+', '-', 'g') AS slug,
  ''::text                                AS markdown,
  t.parent_id                             AS parent_id,
  t.color                                 AS tag_color,
  t.schema_id                             AS tag_schema_id,
  0                                       AS sort_order,
  t.created_at                            AS created_at,
  t.created_at                            AS updated_at
FROM tags t
ON CONFLICT (id) DO NOTHING;  -- safety; new content_nodes shouldn't exist for tag ids

-- 4. Verification — both tables should have matching row counts.
DO $$
DECLARE
  tag_count int;
  class_tag_node_count int;
BEGIN
  SELECT COUNT(*) INTO tag_count FROM tags;
  SELECT COUNT(*) INTO class_tag_node_count FROM content_nodes WHERE node_type = 'class_tag';
  IF tag_count <> class_tag_node_count THEN
    RAISE EXCEPTION 'tag/class_tag node count mismatch: tags=%, class_tag_nodes=%', tag_count, class_tag_node_count;
  END IF;
END $$;

COMMENT ON COLUMN content_nodes.tag_color IS
  'A1 L3-A: hex color for node_type=class_tag rows. NULL for regular content.';
COMMENT ON COLUMN content_nodes.tag_schema_id IS
  'A1 L3-A: schema definition FK for node_type=class_tag rows. NULL for regular content.';
