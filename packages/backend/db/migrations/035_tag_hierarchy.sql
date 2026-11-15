-- L1 — Tag hierarchy. `#projects/onboarding` is a real parent/child
-- relationship, not just a name with a `/`.
--
-- Substrate:
--   tags.parent_id  uuid REFERENCES tags(id) ON DELETE SET NULL
--   tags.name still stores the LEAF segment only ("onboarding"), not the
--   full path. The full path is reconstructed by walking parent_id up to
--   NULL. This matches SiYuan / Obsidian / Tana conventions:
--     - `#projects/onboarding`  →  tags(name="projects") ← tags(name="onboarding", parent_id=<projects>)
--     - typing `#projects/onboarding` in markdown creates BOTH rows when
--       the chain doesn't exist
--
-- Filter cascade: `tag = projects` should match every descendant. The
-- query layer uses a recursive CTE for the descendant set.
--
-- Why ON DELETE SET NULL (not CASCADE):
--   If a parent tag is deleted, the children survive but float to root.
--   CASCADE would silently wipe whole tag trees on a single mis-click —
--   too dangerous. The user can re-parent or delete each child explicitly.
--
-- References:
--   - SiYuan tag dock builds the tree via name split on '/' (kept name
--     full-path) — we go further with a real parent_id column so
--     reparenting is a single UPDATE, not a rename.
--   - Obsidian nested-tags doc: same '/' convention, in-memory tree.
--   - Tana supertag: every supertag is a node; parent supertag is a
--     reference. Onden's L3 will converge with this; for now L1 keeps
--     the FK on the tags table.

ALTER TABLE tags
  ADD COLUMN parent_id uuid REFERENCES tags(id) ON DELETE SET NULL;

CREATE INDEX tags_parent_idx ON tags (parent_id) WHERE parent_id IS NOT NULL;

-- The existing tags_workspace_id_name_key unique constraint was on
-- (workspace_id, name). With hierarchy, two siblings under different
-- parents could legitimately share a leaf name (e.g.,
-- `#projects/notes` vs `#meetings/notes` — both are "notes" leaves).
-- We relax to (workspace_id, parent_id, name) where parent_id is NULL
-- treated as a sentinel root.
ALTER TABLE tags
  DROP CONSTRAINT tags_workspace_id_name_key;

-- NULL parent_id is treated as a single "root" bucket by COALESCE.
-- Unique on (workspace, coalesce(parent, ROOT), name).
CREATE UNIQUE INDEX tags_workspace_parent_name_uq
  ON tags (workspace_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

COMMENT ON COLUMN tags.parent_id IS
  'L1: tag hierarchy. NULL = root. ON DELETE SET NULL so children survive parent removal.';
