-- Block-ID substrate (Obsidian-style ^block-id).
--
-- Onden's editor model is markdown-primary with opt-in block features
-- (see memory/project_onden_editor_model). Per-block IDs are NOT mandatory:
-- only paragraphs / list-items the user explicitly anchors with `^foo` get
-- a row in this table. Most content stays plain markdown with no overhead.
--
-- Reference for the surface syntax: Obsidian's ^id convention. The ID lives
-- inline in the markdown body (so it survives plain-markdown round-trip;
-- other tools just see trailing text). This table is a DERIVED index
-- populated from markdown on save — content_nodes.markdown stays
-- authoritative.
--
-- Lookup pattern: cross-note block references resolve as
--   `[[note-slug#^id]]` → query (workspace_id, block_id) → node_id +
--   ordinal (which paragraph in the note). Ordinal lets the renderer scroll
--   to the right block; the existence of the row is what makes the link
--   live (vs dangling).

CREATE TABLE IF NOT EXISTS node_block_ids (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id)     ON DELETE CASCADE,
  node_id      uuid NOT NULL REFERENCES content_nodes(id)  ON DELETE CASCADE,
  block_id     text NOT NULL,
  -- 0-based paragraph/list-item position within the node's markdown body —
  -- used by the renderer to scroll to the right element and by the editor
  -- to put the caret on the right line when navigating to a block ref.
  ordinal      int  NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Updated whenever a save rewrites the markdown but keeps the same id.
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- block_id is unique within a workspace: cross-note refs like
-- [[other-note#^id]] need a stable global handle. Note "global" here
-- means workspace-global, NOT cross-workspace.
CREATE UNIQUE INDEX IF NOT EXISTS node_block_ids_workspace_block_idx
  ON node_block_ids (workspace_id, block_id);

-- Per-node lookup for save-flow upsert (when re-syncing IDs from a node's
-- markdown, we need to find the existing rows for that node fast).
CREATE INDEX IF NOT EXISTS node_block_ids_node_idx
  ON node_block_ids (node_id);

-- Allowed characters: letters, digits, dashes (Obsidian's constraint).
-- Anything fancier risks colliding with markdown syntax (caret + space
-- separates these from text marks, so a slash or dot would break parsing).
ALTER TABLE node_block_ids
  ADD CONSTRAINT node_block_ids_chars_chk
    CHECK (block_id ~ '^[a-zA-Z0-9-]+$' AND length(block_id) <= 64);
