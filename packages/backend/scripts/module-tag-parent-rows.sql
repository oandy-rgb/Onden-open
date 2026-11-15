-- Rows that put the 功能 layer into the tag tree (src/services/parentKind.ts,
-- docs/architecture/module-library.md「模型：分層的圖」). READ-ONLY: it changes
-- nothing. New writes are refused (409 module_tag_parent); migration 129 repairs
-- these rows (module tag → root; a tag under a module tag → root + extends it).
--
--   psql "$DATABASE_URL" -f packages/backend/scripts/module-tag-parent-rows.sql
--
-- module_with_parent: a module tag that has a parent tag.
-- tag_under_module: a tag whose parent is a module tag.
-- Trashed rows are listed too (deleted = true): they can come back.

BEGIN READ ONLY;

SELECT CASE WHEN c.tag_schema->>'module' IS NOT NULL THEN 'module_with_parent' ELSE 'tag_under_module' END AS kind,
       count(*) AS rows,
       count(*) FILTER (WHERE c.deleted_at IS NULL) AS live
  FROM content_nodes c
  JOIN content_nodes p ON p.id = c.parent_id
 WHERE c.node_type = 'class_tag' AND p.node_type = 'class_tag'
   AND (p.tag_schema->>'module' IS NOT NULL OR c.tag_schema->>'module' IS NOT NULL)
 GROUP BY 1
 ORDER BY 1;

SELECT CASE WHEN c.tag_schema->>'module' IS NOT NULL THEN 'module_with_parent' ELSE 'tag_under_module' END AS kind,
       c.workspace_id, c.id, c.title, c.tag_schema->>'module' AS module, c.deleted_at IS NOT NULL AS deleted,
       p.id AS parent_id, p.title AS parent_title, p.tag_schema->>'module' AS parent_module
  FROM content_nodes c
  JOIN content_nodes p ON p.id = c.parent_id
 WHERE c.node_type = 'class_tag' AND p.node_type = 'class_tag'
   AND (p.tag_schema->>'module' IS NOT NULL OR c.tag_schema->>'module' IS NOT NULL)
 ORDER BY kind, c.workspace_id, p.title, c.title;

ROLLBACK;
