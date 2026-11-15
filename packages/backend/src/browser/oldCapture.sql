-- What an older app (before migration 201) left for the capture inbox: the module tag under a random id. Read by makeOldCopy.ts.
-- Placeholders: __TAG__ (a new id made by the app).
UPDATE content_nodes SET tag_schema = COALESCE(tag_schema, '{}'::jsonb) || '{"module":"capture","publish_collection":false}'::jsonb WHERE id = '__TAG__';
