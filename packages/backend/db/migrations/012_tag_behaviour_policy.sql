-- Unified tag model: a tag definition carries Schema (fields), Policy (who),
-- and Behaviour (what happens). All three live on collection_schemas which is
-- the tag definition table (kept named for FK compatibility). Tag application
-- = node_tags row (denormalized index of an attribute-style relation).
-- Dispatcher operates on attribute changes AND tag apply/remove uniformly.

ALTER TABLE collection_schemas
  ADD COLUMN IF NOT EXISTS behaviour jsonb NOT NULL DEFAULT '{}';

ALTER TABLE collection_schemas
  ADD COLUMN IF NOT EXISTS policy jsonb NOT NULL DEFAULT '{}';

-- Seed built-in tag: #archive
-- Applying it hides the node; removing reveals it. Demonstrates the
-- unified dispatcher path end-to-end.
DO $$
DECLARE
  ws RECORD;
  archive_schema_id uuid;
  archive_tag_id uuid;
BEGIN
  FOR ws IN SELECT id FROM workspaces LOOP
    -- Definition row (the tag's "class" — no user fields, behaviour only)
    SELECT id INTO archive_schema_id
    FROM collection_schemas
    WHERE workspace_id = ws.id AND slug = 'archive';

    IF archive_schema_id IS NULL THEN
      INSERT INTO collection_schemas (workspace_id, name, slug, fields, views, behaviour, policy)
      VALUES (
        ws.id, 'Archive', 'archive',
        '[]'::jsonb,
        '{}'::jsonb,
        '{"on_apply":{"type":"set_hidden","value":true},"on_remove":{"type":"set_hidden","value":false}}'::jsonb,
        '{}'::jsonb
      )
      RETURNING id INTO archive_schema_id;
    ELSE
      -- Refresh behaviour in case migration runs after manual edits
      UPDATE collection_schemas
      SET behaviour = '{"on_apply":{"type":"set_hidden","value":true},"on_remove":{"type":"set_hidden","value":false}}'::jsonb
      WHERE id = archive_schema_id;
    END IF;

    -- Tag pointer to the definition
    SELECT id INTO archive_tag_id
    FROM tags
    WHERE workspace_id = ws.id AND name = 'archive';

    IF archive_tag_id IS NULL THEN
      INSERT INTO tags (workspace_id, name, kind, schema_id, color)
      VALUES (ws.id, 'archive', 'supertag', archive_schema_id, '#888888');
    ELSE
      UPDATE tags
      SET schema_id = archive_schema_id, kind = 'supertag'
      WHERE id = archive_tag_id;
    END IF;
  END LOOP;
END $$;
