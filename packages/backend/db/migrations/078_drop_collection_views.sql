-- 078_drop_collection_views.sql  (P4.1 batch 2: collection_views → node, CONTRACT)
--
-- The class_tag node now owns its saved views in content_nodes.collection_views
-- (jsonb array): every read and write was migrated onto the node (MIGRATE reads +
-- the write-flow flip), so the EXPAND scaffolding and the table can go.
--
-- Order: the trigger depends on sync_collection_views_to_node; that function and
-- collection_views_json reference the collection_views table, so drop them before
-- the table. DROP TABLE takes the pkey / tag+name unique / tag idx / FKs with it.

DROP TRIGGER IF EXISTS cv_sync_to_node ON public.collection_views;
DROP FUNCTION IF EXISTS public.sync_collection_views_to_node();
DROP FUNCTION IF EXISTS public.collection_views_json(uuid);

DROP TABLE IF EXISTS public.collection_views;
