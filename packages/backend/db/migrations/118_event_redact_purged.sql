-- 118_event_redact_purged.sql
--
-- A permanent delete (services/nodeTrash.ts purgeDeleted) must leave no title
-- or text of the note behind. The event log is append-only (migrations 051 +
-- 052): it kept every NODE_CREATED / NODE_UPDATED / NODE_DELETED payload of a
-- note — titles, attribute values, body hashes pointing at the note's saved
-- versions — so "deleted for good" was not true while those rows stood.
--
-- Erasing in place, not deleting: the purged note's events keep their id,
-- type, target, actor, time and cause link, so event ids (the sync cursor),
-- triggered_by chains and reviews stay intact; only payload and tx_meta are
-- replaced by the marker {"purged": true}. This is the ONE update the log
-- allows, and only:
--   * in a transaction that opted in with myapp.allow_event_redact = 'on'
--     (set_config(..., true), so it ends with the transaction);
--   * to exactly the marker — a redaction cannot rewrite history into
--     something else;
--   * leaving every other column as it was.
-- Everything else still raises 'domain_events is append-only'.

CREATE OR REPLACE FUNCTION public.domain_events_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('myapp.allow_event_redact', true) = 'on'
     AND NEW.payload = '{"purged": true}'::jsonb
     AND NEW.tx_meta = '{"purged": true}'::jsonb
     AND NEW.id = OLD.id
     AND NEW.workspace_id = OLD.workspace_id
     AND NEW.actor_type = OLD.actor_type
     AND NEW.actor_id = OLD.actor_id
     AND NEW.event_type = OLD.event_type
     AND NEW.target_type = OLD.target_type
     AND NEW.target_id = OLD.target_id
     AND NEW.created_at = OLD.created_at
     AND NEW.triggered_by_event_id IS NOT DISTINCT FROM OLD.triggered_by_event_id
     AND NEW.external = OLD.external THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'domain_events is append-only';
END;
$$;
