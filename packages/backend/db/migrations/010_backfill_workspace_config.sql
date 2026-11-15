-- One-time backfill: extract site settings from the latest publish_snapshot
-- and write them as attributes onto the workspace config node. Idempotent:
-- skips workspaces whose config node already has attributes.

DO $$
DECLARE
  ws RECORD;
  cfg_node_id uuid;
  pres jsonb;
  site jsonb;
  tokens jsonb;
  v text;
BEGIN
  FOR ws IN SELECT id FROM workspaces LOOP
    -- Find the workspace's config node via the reserved supertag
    SELECT n.id INTO cfg_node_id
    FROM content_nodes n
    JOIN node_tags nt ON nt.node_id = n.id
    JOIN tags      t  ON t.id      = nt.tag_id
    WHERE n.workspace_id = ws.id
      AND t.name = 'workspace-config'
      AND t.kind = 'supertag'
    LIMIT 1;

    IF cfg_node_id IS NULL THEN CONTINUE; END IF;

    -- Skip if already populated (don't clobber existing config)
    IF EXISTS (SELECT 1 FROM node_attributes WHERE node_id = cfg_node_id) THEN
      CONTINUE;
    END IF;

    -- Get the latest snapshot's presentation
    SELECT payload->'presentation' INTO pres
    FROM publish_snapshots
    WHERE workspace_id = ws.id
    ORDER BY created_at DESC
    LIMIT 1;

    IF pres IS NULL THEN CONTINUE; END IF;

    site   := pres->'site';
    tokens := pres->'tokens';

    -- site.brand / tagline / nav
    IF site IS NOT NULL THEN
      v := site->>'brand';
      IF v IS NOT NULL AND v <> '' THEN
        INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
        VALUES (ws.id, cfg_node_id, 'brand', v, 'text', 'derived');
      END IF;
      v := site->>'tagline';
      IF v IS NOT NULL AND v <> '' THEN
        INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
        VALUES (ws.id, cfg_node_id, 'tagline', v, 'text', 'derived');
      END IF;
      IF site->'nav' IS NOT NULL AND jsonb_typeof(site->'nav') = 'array' THEN
        INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
        VALUES (ws.id, cfg_node_id, 'nav', (site->'nav')::text, 'text', 'derived');
      END IF;
    END IF;

    -- tokens.* (accent, font, darkMode, layout, sidebarRatio)
    IF tokens IS NOT NULL THEN
      v := tokens->>'accent';
      IF v IS NOT NULL AND v <> '' THEN
        INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
        VALUES (ws.id, cfg_node_id, 'accent', v, 'text', 'derived');
      END IF;
      v := tokens->>'font';
      IF v IS NOT NULL AND v <> '' THEN
        INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
        VALUES (ws.id, cfg_node_id, 'font', v, 'text', 'derived');
      END IF;
      v := tokens->>'darkMode';
      IF v IS NOT NULL AND v <> '' THEN
        INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
        VALUES (ws.id, cfg_node_id, 'darkMode', v, 'bool', 'derived');
      END IF;
      v := tokens->>'layout';
      IF v IS NOT NULL AND v <> '' THEN
        INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
        VALUES (ws.id, cfg_node_id, 'default_layout', v, 'text', 'derived');
      END IF;
      v := tokens->>'sidebarRatio';
      IF v IS NOT NULL AND v <> '' THEN
        INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
        VALUES (ws.id, cfg_node_id, 'default_sidebar_ratio', v, 'number', 'derived');
      END IF;
    END IF;

    -- presentation.template
    v := pres->>'template';
    IF v IS NOT NULL AND v <> '' THEN
      INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
      VALUES (ws.id, cfg_node_id, 'template', v, 'text', 'derived');
    END IF;

    -- presentation.blocks (top-level chrome blocks) → node.presentation
    IF pres->'blocks' IS NOT NULL AND jsonb_typeof(pres->'blocks') = 'array' THEN
      UPDATE content_nodes
      SET presentation = jsonb_build_object('blocks', pres->'blocks'),
          updated_at = now()
      WHERE id = cfg_node_id;
    END IF;
  END LOOP;
END $$;
