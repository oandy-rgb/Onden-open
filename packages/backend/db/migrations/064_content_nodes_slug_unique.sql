-- Slug uniqueness moves into the DATABASE. uniqueSlug() (services/nodes.ts)
-- is read-then-pick: two concurrent creates with the same title can both see
-- "free" and both insert the same slug — and the slug is the publish-surface
-- routing key, so a collision silently shadows one node behind the other.
-- Same pattern as content_nodes_class_tag_workspace_parent_title_uq (A1.8):
-- a partial unique index over live rows; soft-deleted rows keep their slug so
-- undelete/restore is unaffected (an undelete colliding with a newer live
-- slug surfaces as 23505, the honest answer).
--
-- Pre-existing duplicates (created before this constraint existed) would make
-- the index build fail, so they are de-duped first: every row after the
-- oldest in a (workspace_id, slug) group gets a suffix. The suffix is the
-- row's own uuid prefix rather than "-2"/"-3" because a counter suffix could
-- itself collide with another live slug; 8 hex chars of the row's id cannot
-- collide twice and stays recognizable next to the original.
WITH dupes AS (
  SELECT id,
         row_number() OVER (PARTITION BY workspace_id, slug ORDER BY created_at, id) AS rn
    FROM content_nodes
   WHERE deleted_at IS NULL
)
UPDATE content_nodes n
   SET slug = n.slug || '-' || left(n.id::text, 8)
  FROM dupes d
 WHERE n.id = d.id AND d.rn > 1;

CREATE UNIQUE INDEX content_nodes_workspace_slug_uq
  ON content_nodes (workspace_id, slug)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX content_nodes_workspace_slug_uq IS
  'Closes the uniqueSlug() read-then-insert race: app code retries on 23505 against this index (services/nodes.ts retryOnSlugConflict).';
