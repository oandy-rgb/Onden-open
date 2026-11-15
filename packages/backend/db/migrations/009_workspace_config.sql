-- Workspace-level settings substrate.
-- Each workspace gets one reserved content_node tagged with the
-- `workspace-config` supertag. Site settings (brand, accent, font, theme,
-- nav, chrome blocks) live as attributes/presentation on this node, so
-- the same dispatcher path used for collection items applies to site
-- config — including sandbox, audit, and permission semantics.

-- Allow 'system' as a source_type for system-created nodes (config, future
-- block templates, etc).
ALTER TABLE content_nodes DROP CONSTRAINT IF EXISTS content_nodes_source_type_check;
ALTER TABLE content_nodes ADD CONSTRAINT content_nodes_source_type_check
  CHECK (source_type IN ('manual', 'rss', 'ai', 'system'));

-- Per-workspace setup
DO $$
DECLARE
  ws RECORD;
  cfg_tag_id uuid;
  cfg_node_id uuid;
BEGIN
  FOR ws IN SELECT id FROM workspaces LOOP
    -- Reserved supertag for this workspace's config
    SELECT id INTO cfg_tag_id
    FROM tags
    WHERE workspace_id = ws.id AND name = 'workspace-config' AND kind = 'supertag'
    LIMIT 1;

    IF cfg_tag_id IS NULL THEN
      INSERT INTO tags (workspace_id, name, kind, color)
      VALUES (ws.id, 'workspace-config', 'supertag', '#666666')
      RETURNING id INTO cfg_tag_id;
    END IF;

    -- Existing config node?
    SELECT n.id INTO cfg_node_id
    FROM content_nodes n
    JOIN node_tags nt ON nt.node_id = n.id
    WHERE n.workspace_id = ws.id AND nt.tag_id = cfg_tag_id
    LIMIT 1;

    IF cfg_node_id IS NULL THEN
      INSERT INTO content_nodes
        (workspace_id, source_type, node_type, title, slug, markdown, hidden, sort_order)
      VALUES
        (ws.id, 'system', 'content', 'Site Config', '_workspace_config', '', true, -1)
      RETURNING id INTO cfg_node_id;

      INSERT INTO node_tags (node_id, tag_id) VALUES (cfg_node_id, cfg_tag_id);
    END IF;
  END LOOP;
END $$;
