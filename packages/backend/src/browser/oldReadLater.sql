-- What an older app (before migration 192) left for read-later, written straight to the database: the module tag, a
-- reference naming the function, the tag on :note_id and one person's "finished" mark. Read by makeOldCopy.ts.
-- Placeholders: __TAG__ (a new id), __WORKSPACE__, __NOTE__.
UPDATE content_nodes SET tag_schema = COALESCE(tag_schema, '{}'::jsonb) || '{"module":"read_later","publish_collection":false}'::jsonb WHERE id = '__TAG__';
INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ('__WORKSPACE__', 'read_later', '__TAG__');
INSERT INTO read_later_done (node_id, actor_id) VALUES ('__NOTE__', 'old-reader');
