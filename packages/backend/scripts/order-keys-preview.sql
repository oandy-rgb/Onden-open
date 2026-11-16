-- Migration 200 (order keys): what it will do to this database. READ-ONLY, counts only: no titles, no text, no ids.
-- Run it BEFORE the upgrade (it reads the integer sort_order, which the migration leaves in place but stops reading).
--   psql "$DATABASE_URL" -f order-keys-preview.sql
--
-- rows_to_fill:     every row of the two tables, live and trashed, gets an order_key.
-- groups:           sibling groups (same workspace and parent), live + trashed rows together, as the migration numbers them.
-- groups_with_ties: groups where two rows share one sort_order (their visible order today comes from the created_at, id tie-break).
-- longest_group:    rows in the largest group (it gets keys a0.. up to 'b' + two digits when it passes 62 rows).
-- live_*:           the same two numbers for live rows only (what the sidebar shows).
WITH g AS (
  SELECT 'content_nodes' AS table_name, workspace_id, parent_id, count(*) AS n, count(DISTINCT sort_order) AS distinct_values,
         count(*) FILTER (WHERE deleted_at IS NULL) AS live_n, count(DISTINCT sort_order) FILTER (WHERE deleted_at IS NULL) AS live_distinct
    FROM content_nodes GROUP BY workspace_id, parent_id
  UNION ALL
  SELECT 'note_pointers', workspace_id, parent_id, count(*), count(DISTINCT sort_order), count(*), count(DISTINCT sort_order)
    FROM note_pointers GROUP BY workspace_id, parent_id
)
SELECT table_name,
       sum(n) AS rows_to_fill,
       count(*) AS groups,
       count(*) FILTER (WHERE n > 1 AND distinct_values = 1) AS groups_all_equal,
       count(*) FILTER (WHERE n > distinct_values) AS groups_with_ties,
       max(n) AS longest_group,
       count(*) FILTER (WHERE live_n > 0) AS live_groups,
       count(*) FILTER (WHERE live_n > 1 AND live_distinct = 1) AS live_groups_all_equal,
       count(*) FILTER (WHERE live_n > live_distinct) AS live_groups_with_ties,
       max(live_n) AS longest_live_group
  FROM g GROUP BY table_name ORDER BY table_name;
