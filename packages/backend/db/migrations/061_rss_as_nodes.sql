-- RSS rebuild ([[rss-rebuild]]): subscriptions become NODES, the parallel
-- tables go away.
--
-- The old rss_sources / rss_items tables were deliberately never spine-migrated
-- scaffolding (see the spineGate allowlist they sat on). The rebuilt reader
-- (src/modules/rss) follows the module contract instead: a subscription source
-- is an ordinary node carrying the #subscription tag, with its feed state in
-- reserved `_rss_*` node_attributes; an article is a hidden node created via
-- the spine by the RSS feed actor. Parallel tables don't merge, don't restore,
-- don't govern ([[collab-merge-model]]) — node + tag + namespaced attrs do.
--
-- This migration:
--   1. converts every rss_sources row into a #subscription-tagged source node
--      (find-or-creating the `subscription` class tag per workspace);
--   2. stamps the legacy rss_items' existing hidden nodes with the new
--      `_rss_*` attributes and reparents them under their source node;
--   3. DROPs both legacy tables.
--
-- Re-runnable: everything is guarded (to_regclass / ON CONFLICT), so the
-- migration-fixture test can seed the legacy tables and execute this file
-- again against an already-migrated database.

DO $$
DECLARE
  src record;
  v_tag_id uuid;
  v_src_node uuid;
BEGIN
  IF to_regclass('public.rss_sources') IS NULL THEN
    RETURN; -- fresh install (or already migrated): nothing to carry over
  END IF;

  FOR src IN SELECT * FROM rss_sources ORDER BY created_at LOOP
    -- Find-or-create the `subscription` class tag in this workspace. Matched
    -- BY NAME, like #review — an ordinary tag, no special-casing in tag CRUD.
    SELECT id INTO v_tag_id FROM content_nodes
     WHERE workspace_id = src.workspace_id AND node_type = 'class_tag'
       AND title = 'subscription' AND deleted_at IS NULL
     LIMIT 1;
    IF v_tag_id IS NULL THEN
      INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
      VALUES (src.workspace_id, 'manual', 'class_tag', 'subscription',
              'tag-subscription-' || substr(md5(src.workspace_id::text), 1, 6))
      RETURNING id INTO v_tag_id;
    END IF;

    -- Skip sources already migrated (re-run safety): a node with this
    -- workspace's _rss_url == src.url that carries #subscription.
    SELECT n.id INTO v_src_node
      FROM content_nodes n
      JOIN node_attributes na ON na.node_id = n.id AND na.key = '_rss_url' AND na.value = src.url
      JOIN node_tags nt ON nt.node_id = n.id AND nt.tag_id = v_tag_id
     WHERE n.workspace_id = src.workspace_id AND n.deleted_at IS NULL
     LIMIT 1;
    IF v_src_node IS NULL THEN
      INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden)
      VALUES (src.workspace_id, 'rss', 'content', src.title,
              'rss-source-' || substr(src.id::text, 1, 8), src.url, false)
      RETURNING id INTO v_src_node;
      INSERT INTO node_tags (node_id, tag_id) VALUES (v_src_node, v_tag_id) ON CONFLICT DO NOTHING;
      INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
      VALUES (src.workspace_id, v_src_node, '_rss_url', src.url, 'text', false, 'explicit')
      ON CONFLICT (node_id, key) DO UPDATE SET value = EXCLUDED.value;
    END IF;

    -- Carry the legacy items over onto their existing hidden nodes: stamp the
    -- _rss_* attrs and group them under the source node. Items whose node was
    -- purged (node_id NULL or row gone) have nothing left to migrate.
    UPDATE content_nodes n SET parent_id = v_src_node
      FROM rss_items i
     WHERE i.rss_source_id = src.id AND i.node_id = n.id AND n.parent_id IS NULL;

    INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
    SELECT i.workspace_id, i.node_id, '_rss_guid', COALESCE(NULLIF(i.url, ''), i.id::text), 'text', false, 'explicit'
      FROM rss_items i JOIN content_nodes n ON n.id = i.node_id
     WHERE i.rss_source_id = src.id
    ON CONFLICT (node_id, key) DO NOTHING;

    INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
    SELECT i.workspace_id, i.node_id, '_rss_source', v_src_node::text, 'text', false, 'explicit'
      FROM rss_items i JOIN content_nodes n ON n.id = i.node_id
     WHERE i.rss_source_id = src.id
    ON CONFLICT (node_id, key) DO NOTHING;

    INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
    SELECT i.workspace_id, i.node_id, '_rss_url', i.url, 'text', false, 'explicit'
      FROM rss_items i JOIN content_nodes n ON n.id = i.node_id
     WHERE i.rss_source_id = src.id AND i.url <> ''
    ON CONFLICT (node_id, key) DO NOTHING;

    -- 'imported' was the legacy unread state; anything else was acted on.
    INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
    SELECT i.workspace_id, i.node_id, '_rss_read',
           CASE WHEN i.status = 'imported' THEN 'false' ELSE 'true' END, 'text', false, 'explicit'
      FROM rss_items i JOIN content_nodes n ON n.id = i.node_id
     WHERE i.rss_source_id = src.id
    ON CONFLICT (node_id, key) DO NOTHING;

    v_src_node := NULL;
  END LOOP;
END $$;

DROP TABLE IF EXISTS rss_items;
DROP TABLE IF EXISTS rss_sources;
