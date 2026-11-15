-- 129: the 功能 layer takes no part in the tag tree (owner decision 2026-10-24;
-- docs/architecture/module-library.md「模型：分層的圖」, services/parentKind.ts).
-- A module tag (tag_schema->>'module') has no parent tag, and no tag sits under
-- one: a tag gets a function by extending it (tag_schema.extends), not by moving
-- under it. New writes are refused (409 module_tag_parent); this repairs rows
-- that already break the rule. Rows are never deleted; notes and field values
-- are not touched. Idempotent: a second run finds nothing to change. List the
-- affected rows first with packages/backend/scripts/module-tag-parent-rows.sql.
--
--  1. A tag directly under a module tag becomes a root tag AND extends that
--     module tag (unless it already does), so it keeps the function and its
--     fields. Its own children keep their parent (they stay under it).
--     A title already taken at the root gets " (2)", " (3)"… (the tag name
--     index is per parent).
--  2. A module tag with a parent becomes a root tag (title collisions as above).
--  3. Workspaces that changed re-check everyone's readable set (membership_epoch).

DROP TABLE IF EXISTS module_tag_parent_moves;
CREATE TEMP TABLE module_tag_parent_moves AS
WITH moving AS (
  SELECT c.id, c.workspace_id, c.title, c.created_at,
         CASE WHEN p.tag_schema->>'module' IS NOT NULL AND c.tag_schema->>'module' IS NULL
              THEN p.id END AS add_extends
    FROM content_nodes c
    JOIN content_nodes p ON p.id = c.parent_id
   WHERE c.node_type = 'class_tag' AND p.node_type = 'class_tag'
     AND (p.tag_schema->>'module' IS NOT NULL OR c.tag_schema->>'module' IS NOT NULL)
), ranked AS (
  SELECT m.*,
         (SELECT count(*) FROM content_nodes r
           WHERE r.workspace_id = m.workspace_id AND r.parent_id IS NULL AND r.node_type = 'class_tag'
             AND r.deleted_at IS NULL AND r.title = m.title) AS taken,
         row_number() OVER (PARTITION BY m.workspace_id, m.title ORDER BY m.created_at, m.id) AS rn
    FROM moving m
   WHERE (SELECT deleted_at FROM content_nodes WHERE id = m.id) IS NULL
)
SELECT id, workspace_id, add_extends,
       CASE WHEN taken + rn > 1 THEN title || ' (' || (taken + rn) || ')' ELSE title END AS new_title
  FROM ranked;

-- Trashed rows are re-parented too (they can come back), but they hold no name slot.
INSERT INTO module_tag_parent_moves (id, workspace_id, add_extends, new_title)
SELECT c.id, c.workspace_id,
       CASE WHEN p.tag_schema->>'module' IS NOT NULL AND c.tag_schema->>'module' IS NULL THEN p.id END,
       c.title
  FROM content_nodes c
  JOIN content_nodes p ON p.id = c.parent_id
 WHERE c.node_type = 'class_tag' AND p.node_type = 'class_tag' AND c.deleted_at IS NOT NULL
   AND (p.tag_schema->>'module' IS NOT NULL OR c.tag_schema->>'module' IS NOT NULL);

UPDATE content_nodes t
   SET parent_id = NULL,
       title = mv.new_title,
       tag_schema = CASE WHEN mv.add_extends IS NULL OR COALESCE(t.tag_schema->'extends', '[]'::jsonb) ? mv.add_extends::text
         THEN t.tag_schema
         ELSE jsonb_set(
           COALESCE(t.tag_schema, jsonb_build_object(
             'name', t.title, 'slug', 'module-' || t.id, 'fields', '[]'::jsonb, 'policy', '{}'::jsonb,
             'behaviour', '{}'::jsonb, 'template_children', '[]'::jsonb, 'views', '{}'::jsonb,
             'block_template', '[]'::jsonb, 'description', '', 'version', '1.0.0',
             'dependencies', '[]'::jsonb, 'publish_collection', false)),
           '{extends}',
           CASE WHEN jsonb_typeof(t.tag_schema->'extends') = 'array' THEN t.tag_schema->'extends' ELSE '[]'::jsonb END
             || to_jsonb(mv.add_extends::text)) END,
       updated_at = now()
  FROM module_tag_parent_moves mv
 WHERE t.id = mv.id;

UPDATE workspaces SET membership_epoch = membership_epoch + 1
 WHERE id IN (SELECT workspace_id FROM module_tag_parent_moves);

DROP TABLE module_tag_parent_moves;
