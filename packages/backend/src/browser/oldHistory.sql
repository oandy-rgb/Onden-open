-- What only older data holds, for makeOldCopy.ts mode `history` (run after the schema is taken back to before migration 220):
-- a save whose text is no longer in blobs, and a note that was never saved through an event (written before history was kept).
-- __LOST_HASH__ is the sha-256 of one save's text, computed by the tool; nothing else is put in from outside.
DELETE FROM blobs WHERE hash = '__LOST_HASH__';
INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
SELECT id, 'manual', 'content', '沒有存檔紀錄的筆記', 'no-save-record', '在有歷史之前就寫好的字' FROM workspaces WHERE slug = 'default';
