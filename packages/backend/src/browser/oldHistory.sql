-- What only older data holds, for makeOldCopy.ts mode `history` (run after the schema is taken back to before migration 220):
-- a save whose text is no longer in blobs, and a note that was never saved through an event (written before history was kept).
-- __LOST_HASH__ is the sha-256 of one save's text, computed by the tool; nothing else is put in from outside.
DELETE FROM blobs WHERE hash = '__LOST_HASH__';
INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
SELECT id, 'manual', 'content', '沒有存檔紀錄的筆記', 'no-save-record', '在有歷史之前就寫好的字' FROM workspaces WHERE slug = 'default';
-- a tag whose description was written before history was kept (no save event names it), and a tag that has never had a description
INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_color)
SELECT id, 'manual', 'class_tag', '沒有存檔紀錄的標籤', 'tag-no-save-record', '標籤在有歷史之前就寫好的說明', '#888888' FROM workspaces WHERE slug = 'default';
INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_color)
SELECT id, 'manual', 'class_tag', '沒有說明的標籤', 'tag-no-description', '', '#888888' FROM workspaces WHERE slug = 'default';
-- a tag whose page whiteboard was drawn before history was kept (no save event names the drawing)
INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_color)
SELECT id, 'manual', 'class_tag', '只有手寫沒有紀錄的標籤', 'tag-drawn-no-record', '', '#888888' FROM workspaces WHERE slug = 'default';
INSERT INTO node_attributes (workspace_id, node_id, key, value, source)
SELECT c.workspace_id, c.id, 'board_ink', '{"v":1,"strokes":[{"id":"old","points":[[0,0],[2,2]]}]}', 'ui' FROM content_nodes c WHERE c.slug = 'tag-drawn-no-record';
