-- 185: drop content_nodes.tag_is_inheritable — a block node takes no tag from the block above or its note any more
-- (owner 2026-11-09, block-nodes.md §5; #1411), so 「不往下繼承」 means nothing and nothing reads the flag.
--
-- Deletes data: the flag on class_tag rows (set false on module tags by migration 135 and workspaceModules; no UI
-- ever set it). No note, tag or block row changes otherwise. The owner agreed to the drop (2026-11-09, 「刪」).
-- Rolling back to an older backend: it selects the column (nodeRowProjection), so add it back first —
-- ALTER TABLE content_nodes ADD COLUMN tag_is_inheritable boolean; — NULL everywhere is what it read as "by kind".
ALTER TABLE content_nodes DROP COLUMN IF EXISTS tag_is_inheritable;
