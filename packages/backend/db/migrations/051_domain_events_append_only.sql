-- 051_domain_events_append_only.sql
--
-- Make domain_events genuinely append-only at the DB boundary. The UPDATE
-- immutability trigger (domain_events_no_update) already existed; this adds the
-- missing DELETE protection so the README's "append-only audit log" claim is
-- actually enforced (previously DELETE was unguarded and pruneEvents() deleted
-- on a rolling 90-day window).
--
-- Two invariants, enforced regardless of who issues the DELETE:
--
--   1. SNAPSHOTTED EVENTS ARE IMMORTAL. An event is "snapshotted" when a
--      content_node_versions row references it (v.event_id = e.id): the state
--      it produced is durably captured as a version blob. capture_node_version
--      never throttles AGENT edits, so every agent action is snapshotted and
--      therefore can never be deleted. The only un-snapshotted events are human
--      body-edits collapsed by the 5-minute capture throttle.
--
--   2. NO DELETE WITHOUT THE SANCTIONED PATH. Any DELETE raises unless the
--      transaction first sets the GUC myapp.allow_event_prune = 'on'. Ad-hoc,
--      accidental, or malicious deletes are blocked; only pruneEvents() opts in.
--
-- DEFAULT BEHAVIOUR IS PURE APPEND-ONLY (mode "B"): the prune job is disabled
-- unless EVENT_PRUNE_EXPERIMENTAL=on, so normally the GUC is never set and
-- NOTHING is ever deleted. The experimental "X" mode GCs only un-snapshotted,
-- sufficiently old node events — see pruneEvents() in src/db.ts and the README.

CREATE OR REPLACE FUNCTION public.domain_events_prevent_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Invariant 1: a snapshotted event can never be deleted, by anyone.
  IF EXISTS (SELECT 1 FROM content_node_versions v WHERE v.event_id = OLD.id) THEN
    RAISE EXCEPTION
      'domain_events is append-only: event % is snapshotted and can never be deleted', OLD.id
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

DROP TRIGGER IF EXISTS domain_events_no_delete ON public.domain_events;
CREATE TRIGGER domain_events_no_delete
  BEFORE DELETE ON public.domain_events
  FOR EACH ROW EXECUTE FUNCTION public.domain_events_prevent_delete();
