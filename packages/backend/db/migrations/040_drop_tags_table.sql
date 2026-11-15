-- A1.8b — Final tag unification step.
--
-- After A1.8a (migration 039 + code switch), no application code reads
-- or writes the legacy `tags` table. Both tables remained as parallel
-- views of the same data (each class tag exists as a tags row AND a
-- content_node row with the same UUID).
--
-- This migration:
--   1. Switches node_tags.tag_id and collection_views.tag_id FKs from
--      tags(id) → content_nodes(id). The UUIDs are the same, so no data
--      migration is needed — the FK constraint just points at a
--      different table.
--   2. Drops indexes on tags that no FK uses anymore.
--   3. DROPs the tags table.
--
-- After this migration, the substrate has ONE primitive for "tag":
-- it's a content_node with node_type='class_tag'. Per thesis
-- 「心智模型統一 + 少模型組合多內容」 — one concept, one storage.
--
-- Pre-conditions verified before applying:
--   - 11 tags rows, 11 content_nodes WHERE node_type='class_tag'
--   - 0 orphan tags (every tags.id has matching content_nodes.id)
--   - No application code writes to `tags` (grep -r INSERT/UPDATE/DELETE
--     INTO tags returns empty)
--   - Sync trigger from migration 038 already dropped in 039
--
-- Reversibility: the data lives in content_nodes; if reversal needed,
-- migrate-back script reconstructs `tags` from the class_tag subset.
-- All 11 currently-live tags' identity preserved (same UUID).

-- 1. Switch node_tags FK from tags(id) → content_nodes(id).
ALTER TABLE node_tags
  DROP CONSTRAINT node_tags_tag_id_fkey;
ALTER TABLE node_tags
  ADD CONSTRAINT node_tags_tag_id_fkey
  FOREIGN KEY (tag_id) REFERENCES content_nodes(id) ON DELETE CASCADE;

-- 2. Switch collection_views FK from tags(id) → content_nodes(id).
ALTER TABLE collection_views
  DROP CONSTRAINT collection_views_tag_id_fkey;
ALTER TABLE collection_views
  ADD CONSTRAINT collection_views_tag_id_fkey
  FOREIGN KEY (tag_id) REFERENCES content_nodes(id) ON DELETE CASCADE;

-- 3. DROP the tags table. CASCADE removes the self-FK + indexes.
DROP TABLE tags CASCADE;

-- 4. workspace_config table referenced tags.id via a tag_id column —
-- already checked: no FK constraint, just a uuid pointer. UUIDs match
-- content_nodes so the data stays valid. If a future migration needs to
-- formalize that pointer, FK it to content_nodes directly.
