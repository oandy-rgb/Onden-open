-- Tag-policy-bounded sandbox scope.
--
-- A sandbox can now be opened against a set of tag UUIDs (scope_tag_ids).
-- When non-empty:
--   * Joining the sandbox requires canActorOnTag(role, tagId, 'apply') for EVERY scope tag.
--   * Adding a source node to the sandbox requires that node to carry at least one tag
--     intersecting with scope_tag_ids (so untagged or unrelated nodes are excluded).
--
-- An empty scope (the default) preserves the existing role-based behaviour via
-- allowed_roles. Migration is non-destructive: existing rows get '{}'.

ALTER TABLE sandboxes
  ADD COLUMN IF NOT EXISTS scope_tag_ids uuid[] NOT NULL DEFAULT '{}';

-- Index for the "find sandboxes scoped to a given tag" query path (Day 5 UI hook).
CREATE INDEX IF NOT EXISTS sandboxes_scope_tag_ids_gin
  ON sandboxes USING gin (scope_tag_ids);
