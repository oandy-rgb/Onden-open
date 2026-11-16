-- Proof that migration 200 did not change what anyone sees. READ-ONLY. For every sibling group it returns how many live rows
-- the group has and a checksum of their ids IN THE ORDER THE APP SHOWS TODAY (sort_order, then created_at, then id: the sidebar's
-- rule). Never titles or text. Run this BEFORE the upgrade and save the output; run order-keys-proof-after.sql AFTER it. The two
-- outputs must be identical, line for line (compare with `diff`).
--   psql "$DATABASE_URL" -At -F '|' -f order-keys-proof-before.sql > before.txt
SELECT * FROM (
  SELECT 'content_nodes' AS what, workspace_id::text AS workspace, coalesce(parent_id::text, '-') AS parent, count(*) AS n,
         md5(string_agg(id::text, ',' ORDER BY sort_order, created_at, id)) AS order_checksum
    FROM content_nodes WHERE deleted_at IS NULL GROUP BY workspace_id, parent_id
  UNION ALL
  SELECT 'note_pointers', workspace_id::text, coalesce(parent_id::text, '-'), count(*),
         md5(string_agg(id::text, ',' ORDER BY sort_order, created_at, id))
    FROM note_pointers GROUP BY workspace_id, parent_id
  UNION ALL
  SELECT 'content_nodes incl. trashed', workspace_id::text, coalesce(parent_id::text, '-'), count(*),
         md5(string_agg(id::text, ',' ORDER BY sort_order, created_at, id))
    FROM content_nodes GROUP BY workspace_id, parent_id
) x ORDER BY what, workspace, parent;
