-- Fix: #workspace-config tag is missing its schema_id link.
--
-- Migration 009 created the `workspace-config` supertag without an associated
-- collection_schemas row. Migration 015 attempted to UPDATE a `workspace-config`
-- schema with the admin policy — but the row didn't exist, so the UPDATE was a
-- no-op. The tag ends up with schema_id=NULL and the policy lookup
-- (canActorOnAllTags, the bootstrap tags join) treats it as policy-less.
--
-- This migration is idempotent:
--   1. Insert the missing schema row per workspace if absent
--   2. Link the workspace-config tag to it
--   3. Make sure the policy is enforced even on previously-fixed rows

DO $$
DECLARE
  ws RECORD;
  schema_id_var uuid;
BEGIN
  FOR ws IN SELECT id FROM workspaces LOOP
    -- Ensure the schema exists.
    SELECT id INTO schema_id_var
    FROM collection_schemas
    WHERE workspace_id = ws.id AND slug = 'workspace-config';

    IF schema_id_var IS NULL THEN
      INSERT INTO collection_schemas (workspace_id, name, slug, fields, views, behaviour, policy)
      VALUES (
        ws.id, 'Workspace Config', 'workspace-config',
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{"required_role": "admin"}'::jsonb
      )
      RETURNING id INTO schema_id_var;
    ELSE
      -- Guard against drift: re-assert the admin policy.
      UPDATE collection_schemas
      SET policy = '{"required_role": "admin"}'::jsonb
      WHERE id = schema_id_var;
    END IF;

    -- Link the existing workspace-config tag to the schema.
    UPDATE tags
    SET schema_id = schema_id_var
    WHERE workspace_id = ws.id
      AND name = 'workspace-config'
      AND schema_id IS NULL;
  END LOOP;
END $$;
