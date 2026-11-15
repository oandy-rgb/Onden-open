-- 075_drop_orphan_collection_schemas.sql  (P4.1 collection_schemas → node, MIGRATE prep)
--
-- An "orphan" collection_schemas row is one no content_nodes row references via
-- tag_schema_id — not even a soft-deleted one. They arise when a class_tag node
-- is hard-purged (maintenance/prune): the FK is content_nodes.tag_schema_id ->
-- collection_schemas(id) ON DELETE SET NULL, so deleting the NODE leaves the
-- schema row behind with nothing pointing at it. Tests that INSERT a schema row
-- without a node produce the same shape.
--
-- These rows are dead data: with no class_tag node, the tag can never be applied,
-- read, or reached — the only thing that still surfaced them was the bootstrap /
-- collections list-all `SELECT * FROM collection_schemas`. Folding the schema onto
-- the node (P4.1) switches those list reads to be node-rooted, which would silently
-- drop orphans; and CONTRACT will DROP collection_schemas entirely, taking them
-- with it. Remove them here, deliberately, so the node-rooted reads are exactly
-- equivalent and collection_schemas <-> class_tag node becomes strictly 1:1
-- (every surviving schema is referenced by exactly one node, live or soft-deleted).
--
-- IMPORTANT: the NOT EXISTS spans ALL content_nodes regardless of deleted_at, so a
-- merged-away or trashed class_tag (soft-deleted node, schema row kept for undelete)
-- is NOT an orphan and is preserved. Only schemas whose node is fully gone drop.
-- Irreversible by design — the data is already unreachable.

DELETE FROM public.collection_schemas cs
 WHERE NOT EXISTS (
   SELECT 1 FROM public.content_nodes n
    WHERE n.tag_schema_id = cs.id
 );
