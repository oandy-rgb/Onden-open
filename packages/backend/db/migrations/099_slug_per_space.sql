-- A slug is unique within a space, not the whole workspace
-- (docs/research/integration-audit-2026-10-13.md, v1 gap 2): creating "Plan"
-- and getting "plan-2" used to reveal that someone in another space has a
-- note called Plan. Tag definitions (no space) stay unique among themselves.
DROP INDEX IF EXISTS content_nodes_workspace_slug_uq;
CREATE UNIQUE INDEX IF NOT EXISTS content_nodes_space_slug_uq ON content_nodes
  (workspace_id, COALESCE(space_id, '00000000-0000-0000-0000-000000000000'::uuid), slug)
  WHERE deleted_at IS NULL;
COMMENT ON INDEX content_nodes_space_slug_uq IS 'Slug unique per space (tags: per workspace). Closes the uniqueSlug() read-then-insert race: app code retries on 23505 (services/nodes.ts retryOnSlugConflict).';
