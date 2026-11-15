-- Policy axis: add demo policies on built-in tags + a strict #admin-only tag.
--
-- Role hierarchy: viewer < editor < reviewer < admin
-- Policy shape: { required_role: "editor", operations: { apply: "admin" } }
-- Operation-specific rule wins; falls back to required_role; falls back to viewer.

DO $$
DECLARE
  ws RECORD;
  admin_only_schema_id uuid;
  admin_only_tag_id uuid;
BEGIN
  FOR ws IN SELECT id FROM workspaces LOOP

    -- Tighten #task: editor+ to apply / remove / change attributes
    UPDATE collection_schemas
    SET policy = '{"required_role": "editor"}'::jsonb
    WHERE workspace_id = ws.id AND slug = 'task';

    -- Tighten #page: editor+
    UPDATE collection_schemas
    SET policy = '{"required_role": "editor"}'::jsonb
    WHERE workspace_id = ws.id AND slug = 'page';

    -- #workspace-config: admin only (this is global site settings)
    UPDATE collection_schemas
    SET policy = '{"required_role": "admin"}'::jsonb
    WHERE workspace_id = ws.id AND slug = 'workspace-config';

    -- New: #admin-only — restrictive demo. Only admin can apply/remove,
    -- only admin can read (read enforcement comes later).
    SELECT id INTO admin_only_schema_id
    FROM collection_schemas
    WHERE workspace_id = ws.id AND slug = 'admin-only';

    IF admin_only_schema_id IS NULL THEN
      INSERT INTO collection_schemas (workspace_id, name, slug, fields, views, behaviour, policy)
      VALUES (
        ws.id, 'Admin Only', 'admin-only',
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{"required_role": "admin"}'::jsonb
      )
      RETURNING id INTO admin_only_schema_id;
    ELSE
      UPDATE collection_schemas
      SET policy = '{"required_role": "admin"}'::jsonb
      WHERE id = admin_only_schema_id;
    END IF;

    SELECT id INTO admin_only_tag_id
    FROM tags
    WHERE workspace_id = ws.id AND name = 'admin-only';

    IF admin_only_tag_id IS NULL THEN
      INSERT INTO tags (workspace_id, name, kind, schema_id, color)
      VALUES (ws.id, 'admin-only', 'supertag', admin_only_schema_id, '#dc2626');
    ELSE
      UPDATE tags SET schema_id = admin_only_schema_id, kind = 'supertag' WHERE id = admin_only_tag_id;
    END IF;
  END LOOP;
END $$;
