-- collection_schemas was born in the schema.sql snapshot era and no migration
-- ever created it, so the 001→NNN chain crashed here on a truly empty database
-- (anything not initdb-loaded from schema.sql). Create the table as it stood
-- before this migration; later migrations layer their columns on top (007
-- views, 012 behaviour/policy, 021 description/version/dependencies, 026
-- template_children). No-op on a schema.sql-initialized database.
CREATE TABLE IF NOT EXISTS collection_schemas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS collection_schemas_workspace_idx
  ON collection_schemas (workspace_id);

ALTER TABLE collection_schemas
  ADD COLUMN IF NOT EXISTS block_template jsonb NOT NULL DEFAULT '[]';
