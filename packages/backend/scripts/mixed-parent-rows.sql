-- Rows that mix the tag tree and the note tree (audit T12; the rule is in
-- src/services/parentKind.ts). READ-ONLY: it changes nothing. New writes are
-- refused (409 parent_kind_mismatch); these existing rows still read, render,
-- save and trash, and are left for the owner to move.
--
--   psql "$DATABASE_URL" -f packages/backend/scripts/mixed-parent-rows.sql
--
-- tag_under_note: a tag (class_tag) whose parent is not a tag.
-- note_under_tag: a note, board or other non-tag whose parent is a tag.
-- Trashed rows are listed too (deleted = true): they can come back.

BEGIN READ ONLY;

SELECT CASE WHEN c.node_type = 'class_tag' THEN 'tag_under_note' ELSE 'note_under_tag' END AS kind,
       count(*) AS rows,
       count(*) FILTER (WHERE c.deleted_at IS NULL) AS live
  FROM content_nodes c
  JOIN content_nodes p ON p.id = c.parent_id
 WHERE (c.node_type = 'class_tag') <> (p.node_type = 'class_tag')
 GROUP BY 1
 ORDER BY 1;

SELECT CASE WHEN c.node_type = 'class_tag' THEN 'tag_under_note' ELSE 'note_under_tag' END AS kind,
       c.workspace_id, c.id, c.node_type, c.title, c.deleted_at IS NOT NULL AS deleted,
       p.id AS parent_id, p.node_type AS parent_type, p.title AS parent_title
  FROM content_nodes c
  JOIN content_nodes p ON p.id = c.parent_id
 WHERE (c.node_type = 'class_tag') <> (p.node_type = 'class_tag')
 ORDER BY kind, c.workspace_id, p.title, c.title;

ROLLBACK;
