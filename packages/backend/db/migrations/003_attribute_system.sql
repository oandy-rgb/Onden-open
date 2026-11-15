-- Attribute system: replace status column and tag tables with node_attributes key-value index

CREATE TABLE IF NOT EXISTS node_attributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  key text NOT NULL,
  value text NOT NULL DEFAULT '',
  UNIQUE (node_id, key)
);

ALTER TABLE content_nodes DROP COLUMN IF EXISTS status;

DROP TABLE IF EXISTS role_visible_tags CASCADE;
DROP TABLE IF EXISTS node_tags CASCADE;
DROP TABLE IF EXISTS tags CASCADE;
