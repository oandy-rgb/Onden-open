-- 053_drop_content_node_versions.sql
--
-- Final step of the events->hash->blobs history merge. The CoW version table and
-- its trigger are now fully superseded: version history, restore, the "recent"
-- feed (step 3), the append-only guard, and blob GC (step 4) all derive from the
-- event log + the content-addressed blob store. Nothing reads content_node_versions
-- any more, and every body a node has ever had is retained in blobs (each event
-- carries body_hash). So retire the parallel mechanism:
--
--   - DROP the CoW capture trigger + its function (it only fed this table + wrote
--     OLD-body blobs that always equal a prior event's body_hash — redundant).
--   - DROP the content_node_versions table.
--
-- Consequence: version history is now per-event (every save is a version) rather
-- than the trigger's 5-minute-throttled snapshots. Finer-grained, no lost
-- intermediate states; a "collapse same-minute" view, if wanted, is a query/UI
-- concern, not a storage one.

DROP TRIGGER IF EXISTS node_version_capture ON public.content_nodes;
DROP FUNCTION IF EXISTS public.capture_node_version();
DROP TABLE IF EXISTS public.content_node_versions;
