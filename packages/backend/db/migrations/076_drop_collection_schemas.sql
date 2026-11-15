-- 076_drop_collection_schemas.sql  (P4.1 collection_schemas → node, CONTRACT)
--
-- The class_tag node is now the sole home of a tag's schema: content_nodes.tag_schema
-- (jsonb) holds fields/policy/behaviour/views/…, and the collection's identity IS the
-- node id. Every read and write was migrated onto the node (MIGRATE 1-7 + the write-flow
-- flip), so the EXPAND scaffolding can go:
--   • the cs→node / node→cs sync triggers and their functions,
--   • the tag_schema_id FK + column (the collection id is the node id now),
--   • the collection_schemas table itself.
--
-- Order matters: triggers depend on the functions; tag_schema_json takes the
-- collection_schemas row type as an argument, so it (and the table) must come after
-- the triggers. Dropping the column also drops its COMMENT; DROP TABLE takes the
-- pkey / unique / workspace-idx / workspace_id FK with it.

DROP TRIGGER IF EXISTS cs_sync_tag_schema ON public.collection_schemas;
DROP TRIGGER IF EXISTS node_pull_tag_schema ON public.content_nodes;

DROP FUNCTION IF EXISTS public.sync_tag_schema_from_cs();
DROP FUNCTION IF EXISTS public.pull_tag_schema_into_node();
DROP FUNCTION IF EXISTS public.tag_schema_json(public.collection_schemas);

ALTER TABLE public.content_nodes DROP CONSTRAINT IF EXISTS content_nodes_tag_schema_id_fkey;
ALTER TABLE public.content_nodes DROP COLUMN IF EXISTS tag_schema_id;

DROP TABLE IF EXISTS public.collection_schemas;
