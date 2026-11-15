-- Saved-view layouts, 2026-10-18:
--  • The list layout was removed (user: 「拿掉列表，只留表格」); the table does
--    everything it did, grouping included. Stored list views become tables,
--    in place and in order; their filters, sorts, group_by and fields stay.
--    services/tagViews.ts takes a "list" sent by an older client as "table".
--  • The table became a view module like calendar, kanban and gallery (user:
--    「表格我想做標籤」), imported by default: add "table" to every recorded
--    module list (NULL lists are left to the boot backfill, which imports it).
-- Repeatable.
UPDATE content_nodes n
   SET collection_views = (
         SELECT jsonb_agg(CASE WHEN x.e->>'layout' = 'list' THEN jsonb_set(x.e, '{layout}', '"table"') ELSE x.e END ORDER BY x.ord)
           FROM jsonb_array_elements(n.collection_views) WITH ORDINALITY AS x(e, ord)
       )
 WHERE jsonb_typeof(n.collection_views) = 'array'
   AND n.collection_views @> '[{"layout": "list"}]';

UPDATE workspaces
   SET modules = modules || '["table"]'::jsonb
 WHERE modules IS NOT NULL
   AND jsonb_typeof(modules) = 'array'
   AND NOT modules ? 'table';
