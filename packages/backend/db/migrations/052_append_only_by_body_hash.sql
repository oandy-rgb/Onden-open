-- 052_append_only_by_body_hash.sql
--
-- Step 4 of the events->hash->blobs history merge. Re-anchor the append-only
-- DELETE guard so "immortal" is defined by the event carrying content, not by a
-- separate content_node_versions snapshot.
--
-- Before (051): an event was un-deletable iff a content_node_versions row
--   referenced it (v.event_id = OLD.id).
-- After  (052): an event is un-deletable iff it carries a body_hash — i.e. it
--   points to retained content in the blob store. The event IS the snapshot.
--
-- This preserves the original guarantee ("snapshotted events are immortal; only
-- un-retained churn is ever prunable") while removing the dependency on
-- content_node_versions, which is being retired. Every body-changing event now
-- carries body_hash, so every edit's content is retained and its event immortal;
-- only events without body_hash (pre-merge events, or pure metadata node events)
-- fall in the prunable set. Default behaviour is still pure append-only (mode B):
-- pruneEvents only runs under EVENT_PRUNE_EXPERIMENTAL.

CREATE OR REPLACE FUNCTION public.domain_events_prevent_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Invariant 1: an event that carries content (body_hash -> blobs) is immortal.
  IF OLD.payload ? 'body_hash' THEN
    RAISE EXCEPTION
      'domain_events is append-only: event % carries content (body_hash) and can never be deleted', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Invariant 2: deletion only via the sanctioned, opt-in retention path.
  IF current_setting('myapp.allow_event_prune', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION
      'domain_events is append-only: deletion is only permitted via the sanctioned retention path'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;
