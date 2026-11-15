-- What an older app (before migration 195) left for review, written straight to the database: the module tag, a reference naming
-- the function on that tag, and a paragraph that was a card through the tag. The note card's membership (node_tags) is written by
-- the app, as a person tagging it. Read by makeOldCopy.ts.
-- Placeholders: __TAG__ (a new id), __WORKSPACE__, __NOTE__ (the note that holds the paragraph card).
UPDATE content_nodes SET tag_schema = COALESCE(tag_schema, '{}'::jsonb) || '{"module":"review","publish_collection":false}'::jsonb WHERE id = '__TAG__';
INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ('__WORKSPACE__', 'review', '__TAG__');
WITH b AS (
  INSERT INTO block_nodes (workspace_id, note_id, block_ref, kind, label)
  VALUES ('__WORKSPACE__', '__NOTE__', 'oldreviewcard', 'paragraph', '舊版複習的段落') RETURNING id
) INSERT INTO block_node_tags (block_node_id, tag_id, workspace_id) SELECT id, '__TAG__', '__WORKSPACE__' FROM b;
