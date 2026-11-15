-- #page built-in tag — per-node website page settings.
--
-- Replaces the manifest.pageLayouts[node_id] jsonb in publish snapshots.
-- Applying #page sets default layout='full'. Layout / sidebar_ratio /
-- slug_override / hide_in_nav live as node attributes; publish pipeline
-- reads them per node.

DO $$
DECLARE
  ws RECORD;
  page_schema_id uuid;
  page_tag_id uuid;
  page_fields jsonb := jsonb_build_array(
    jsonb_build_object(
      'name', 'layout', 'label', 'Layout', 'type', 'select',
      'options', jsonb_build_array('full', 'narrow', 'sidebar-left', 'sidebar-right')
    ),
    jsonb_build_object(
      'name', 'sidebar_ratio', 'label', 'Sidebar ratio', 'type', 'number'
    ),
    jsonb_build_object(
      'name', 'slug_override', 'label', 'Slug override', 'type', 'text'
    ),
    jsonb_build_object(
      'name', 'hide_in_nav', 'label', 'Hide in nav', 'type', 'boolean'
    )
  );
  page_views jsonb := jsonb_build_object();
  page_behaviour jsonb := jsonb_build_object(
    'on_apply', jsonb_build_object(
      'type', 'set_attribute', 'key', 'layout', 'value', 'full', 'value_type', 'text'
    )
  );
BEGIN
  FOR ws IN SELECT id FROM workspaces LOOP
    SELECT id INTO page_schema_id
    FROM collection_schemas
    WHERE workspace_id = ws.id AND slug = 'page';

    IF page_schema_id IS NULL THEN
      INSERT INTO collection_schemas (workspace_id, name, slug, fields, views, behaviour, policy)
      VALUES (ws.id, 'Page', 'page', page_fields, page_views, page_behaviour, '{}'::jsonb)
      RETURNING id INTO page_schema_id;
    ELSE
      UPDATE collection_schemas
      SET fields = page_fields, behaviour = page_behaviour
      WHERE id = page_schema_id;
    END IF;

    SELECT id INTO page_tag_id
    FROM tags
    WHERE workspace_id = ws.id AND name = 'page';

    IF page_tag_id IS NULL THEN
      INSERT INTO tags (workspace_id, name, kind, schema_id, color)
      VALUES (ws.id, 'page', 'supertag', page_schema_id, '#10b981');
    ELSE
      UPDATE tags SET schema_id = page_schema_id, kind = 'supertag' WHERE id = page_tag_id;
    END IF;
  END LOOP;
END $$;
