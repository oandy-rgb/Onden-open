-- Grows a seeded 5k workspace to 20k by cloning the "筆記 N" notes three times (N → N+5000/10000/15000), in SQL
-- (one-by-one API creation is O(workspace) per note; see report). Clones keep: title/body (heading, 第 N 篇 and the
-- [[link]] to the previous note renumbered so links stay inside each copy), parent folder, space, tags (+states),
-- attributes, wikilink edges, node_event_meta. Clones have NO domain_events (same as 10-21's clone.sql).
-- usage: psql ... -v ON_ERROR_STOP=1 -f clone.sql   (idempotent only on a fresh 5k: run once)
BEGIN;
SET LOCAL session_replication_role = replica;  -- skip derive/check triggers; rows are copies of valid rows
CREATE TEMP TABLE m AS
  SELECT n.id AS old_id, gen_random_uuid() AS new_id, k.off, substring(n.title from '^筆記 (\d+)$')::int AS num
  FROM content_nodes n CROSS JOIN (VALUES (5000),(10000),(15000)) k(off)
  WHERE n.title ~ '^筆記 \d+$' AND n.deleted_at IS NULL AND substring(n.title from '^筆記 (\d+)$')::int < 5000;
INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, created_at, updated_at, parent_id, hidden, sort_order, presentation, tag_color, tag_schema, collection_views, reserved_key, tag_is_inheritable, space_id)
SELECT m.new_id, n.workspace_id, n.source_type, n.node_type, '筆記 ' || (m.num + m.off), n.slug || '-c' || (m.off / 5000),
  replace(replace(replace(n.markdown, '# 筆記 ' || m.num || E'\n', '# 筆記 ' || (m.num + m.off) || E'\n'), '第 ' || m.num || ' 篇', '第 ' || (m.num + m.off) || ' 篇'),
          '[[筆記 ' || (m.num - 1) || ']]', '[[筆記 ' || (m.num + m.off - 1) || ']]'),
  n.created_at, n.updated_at, n.parent_id, n.hidden, n.sort_order, n.presentation, n.tag_color, n.tag_schema, n.collection_views, NULL, n.tag_is_inheritable, n.space_id
FROM m JOIN content_nodes n ON n.id = m.old_id;
INSERT INTO node_tags (node_id, tag_id, created_at) SELECT m.new_id, t.tag_id, t.created_at FROM m JOIN node_tags t ON t.node_id = m.old_id;
INSERT INTO node_tag_states (node_id, tag_id, is_applied, state_id, previous_state_id) SELECT m.new_id, t.tag_id, t.is_applied, t.state_id, t.previous_state_id FROM m JOIN node_tag_states t ON t.node_id = m.old_id;
INSERT INTO node_attributes (workspace_id, node_id, key, value, is_inheritable, value_type, source, updated_at) SELECT a.workspace_id, m.new_id, a.key, a.value, a.is_inheritable, a.value_type, a.source, a.updated_at FROM m JOIN node_attributes a ON a.node_id = m.old_id;
INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, created_at, origin)
SELECT e.workspace_id, ms.new_id, mt.new_id, e.edge_type, e.status, e.created_at, e.origin FROM node_edges e JOIN m ms ON ms.old_id = e.source_node_id JOIN m mt ON mt.old_id = e.target_node_id AND mt.off = ms.off;
INSERT INTO node_event_meta (node_id, actor_id, last_event_at) SELECT m.new_id::text, x.actor_id, x.last_event_at FROM m JOIN node_event_meta x ON x.node_id = m.old_id::text;
COMMIT;
SELECT (SELECT count(*) FROM content_nodes) nodes, (SELECT count(*) FROM node_edges) edges, (SELECT count(*) FROM node_tags) tags, (SELECT count(*) FROM node_attributes) attrs;
