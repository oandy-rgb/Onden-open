-- AFTER migration 200: the same checksums as order-keys-proof-before.sql, from the new order (order_key by byte, then order_stamp, then id).
-- READ-ONLY; ids are only hashed. The output must be identical to what the before-query printed, line for line.
--   psql "$DATABASE_URL" -At -F '|' -f order-keys-proof-after.sql > after.txt && diff before.txt after.txt && echo "same order"
SELECT * FROM (
  SELECT 'content_nodes' AS what, workspace_id::text AS workspace, coalesce(parent_id::text, '-') AS parent, count(*) AS n,
         md5(string_agg(id::text, ',' ORDER BY order_key COLLATE "C", order_stamp COLLATE "C", id)) AS order_checksum
    FROM content_nodes WHERE deleted_at IS NULL GROUP BY workspace_id, parent_id
  UNION ALL
  SELECT 'note_pointers', workspace_id::text, coalesce(parent_id::text, '-'), count(*),
         md5(string_agg(id::text, ',' ORDER BY order_key COLLATE "C", order_stamp COLLATE "C", id))
    FROM note_pointers GROUP BY workspace_id, parent_id
  UNION ALL
  SELECT 'content_nodes incl. trashed', workspace_id::text, coalesce(parent_id::text, '-'), count(*),
         md5(string_agg(id::text, ',' ORDER BY order_key COLLATE "C", order_stamp COLLATE "C", id))
    FROM content_nodes GROUP BY workspace_id, parent_id
) x ORDER BY what, workspace, parent;
