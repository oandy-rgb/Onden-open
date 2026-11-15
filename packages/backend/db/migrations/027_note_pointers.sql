-- Pointer clones — symlink-style tree references.
--
-- A note has one canonical home at content_nodes.parent_id ("primary
-- branch"). Pointers are lightweight tree-position rows that make the
-- same note appear under other parents in the sidebar tree. Editing
-- through a pointer edits the canonical note; deleting a pointer
-- removes that tree position only. Deleting the note (via the
-- ON DELETE CASCADE on target_id) cleans up its pointers.
--
-- Compared to Trilium's full multi-branch model: we keep the primary
-- home distinction explicit so existing parent_id consumers (query
-- paths, sync, publish) don't change. Trilium-style "all branches
-- equal" would be a deeper refactor; symlinks here are additive.

CREATE TABLE IF NOT EXISTS note_pointers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES content_nodes(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  sort_order int NOT NULL DEFAULT 0,
  display_prefix text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, target_id)
);

CREATE INDEX IF NOT EXISTS note_pointers_parent_idx
  ON note_pointers (workspace_id, parent_id, sort_order);
CREATE INDEX IF NOT EXISTS note_pointers_target_idx
  ON note_pointers (workspace_id, target_id);
