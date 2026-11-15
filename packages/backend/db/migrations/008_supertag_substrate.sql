-- Schema unification phase 1: supertag substrate
-- Brings back tags / node_tags (dropped in migration 003) as the foundation
-- for Tana-style supertags. Each tag with schema_id is a "supertag" — applying
-- it to a node means "this node is an instance of class X".
-- Hardens node_attributes with type info, inheritability flag, and source trace.

-- ── Tags table ───────────────────────────────────────────────────────────────
-- kind: 'content' = freeform metadata, 'supertag' = class with schema attached
CREATE TABLE IF NOT EXISTS tags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  color        text NOT NULL DEFAULT '#888888',
  kind         text NOT NULL DEFAULT 'content' CHECK (kind IN ('content', 'supertag')),
  schema_id    uuid REFERENCES collection_schemas(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS tags_workspace_idx ON tags (workspace_id);
CREATE INDEX IF NOT EXISTS tags_schema_idx    ON tags (schema_id) WHERE schema_id IS NOT NULL;

-- A node tagged with a supertag = node is "instance of" that class.
CREATE TABLE IF NOT EXISTS node_tags (
  node_id    uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tags(id)          ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, tag_id)
);

CREATE INDEX IF NOT EXISTS node_tags_tag_idx ON node_tags (tag_id);

-- ── node_attributes hardening ────────────────────────────────────────────────
-- Trilium-style per-node attributes. Extended with:
--   is_inheritable: whether this attribute propagates to descendants via parent_id
--   value_type:     type hint for application-layer parsing
--   source:         where the value came from (explicit / inherited / derived)
ALTER TABLE node_attributes
  ADD COLUMN IF NOT EXISTS is_inheritable boolean NOT NULL DEFAULT false;

ALTER TABLE node_attributes
  ADD COLUMN IF NOT EXISTS value_type text NOT NULL DEFAULT 'text'
    CHECK (value_type IN ('text', 'number', 'date', 'bool', 'node_ref'));

ALTER TABLE node_attributes
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'explicit'
    CHECK (source IN ('explicit', 'derived'));

-- Indexes for common queries: filter by inheritable, lookup by key.
CREATE INDEX IF NOT EXISTS node_attributes_inheritable_idx
  ON node_attributes (node_id) WHERE is_inheritable = true;
CREATE INDEX IF NOT EXISTS node_attributes_key_idx
  ON node_attributes (workspace_id, key);

-- ── Auto-create supertag for each existing collection_schema ─────────────────
-- Each collection_schema becomes a supertag. The slug becomes the tag name.
-- Idempotent via ON CONFLICT (UNIQUE (workspace_id, name)).
INSERT INTO tags (workspace_id, name, kind, schema_id)
SELECT workspace_id, slug, 'supertag', id
FROM collection_schemas
ON CONFLICT (workspace_id, name) DO UPDATE
  SET kind = 'supertag', schema_id = EXCLUDED.schema_id;
