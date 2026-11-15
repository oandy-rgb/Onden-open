-- 163: a block node knows its anchor, and can stand alone as a note without changing identity.
--
-- anchor_id: the block_anchors row that says where this paragraph is (1:1, workspace-unique). The
--   feature data (task, review schedule, tags) stays keyed by block_nodes.id; the anchor is only the
--   position. Filled on every save after the anchors moved (services/blockAnchors/blockNodeLink.ts);
--   NULL for rows saved while ONDEN_BLOCK_ANCHORS=off or before this migration (filled by their next save).
-- detached_note_id: set while the paragraph lives as its own note ("獨立出去"); NULL = text is in the
--   note ("留在原處"). The row is not hidden then, and its task / schedule are not touched. Bringing the
--   text back ("收回原文") clears it. ON DELETE SET NULL: a purged note leaves the row to the next save.
-- detached_tags: the `{…}` as written (order, spelling) when it was detached, so taking it back writes the
--   same `{…}` when the note's tags are still the same.
-- Additive: no existing row changes.

ALTER TABLE block_nodes ADD COLUMN IF NOT EXISTS anchor_id text;
ALTER TABLE block_nodes ADD COLUMN IF NOT EXISTS detached_note_id uuid REFERENCES content_nodes(id) ON DELETE SET NULL;
ALTER TABLE block_nodes ADD COLUMN IF NOT EXISTS detached_tags text[];
CREATE UNIQUE INDEX IF NOT EXISTS block_nodes_anchor_uq ON block_nodes (workspace_id, anchor_id) WHERE anchor_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS block_nodes_detached_uq ON block_nodes (detached_note_id) WHERE detached_note_id IS NOT NULL;
