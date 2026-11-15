-- 131: who last touched a note, and when, kept per (note, actor) as events are appended.
--
-- Before: bootstrap computed last_actor / last_modified_at / recent_actors by
-- grouping and sorting the whole node-event log on every cold start (1.1 s at
-- 140k events, 2.6 s at 700k; docs/research/review-2026-10-24/performance.md #1).
-- The log only grows, so that cost grew with it.
--
-- Now one row per (note, actor) holds the time of that actor's latest change to
-- the note. The reader derives all three values from the few rows of a note:
-- last_actor = the actor with the newest row, last_modified_at = that time,
-- recent_actors = actors whose row is within 30 days (decided at read time, so
-- the window still moves without any job). A trigger on domain_events keeps it
-- current in the same transaction as the event, for every insert path; events
-- are append-only, so a row never needs to go back in time.
--
-- Counted as before: node events only, and not the saved-view events aimed at a
-- note (COLLECTION_VIEW_*), which are presentation, not a change to it.

CREATE TABLE node_event_meta (
  node_id text NOT NULL,
  actor_id text NOT NULL,
  last_event_at timestamptz NOT NULL,
  PRIMARY KEY (node_id, actor_id)
);

INSERT INTO node_event_meta (node_id, actor_id, last_event_at)
SELECT target_id, actor_id, max(created_at)
  FROM domain_events
 WHERE target_type = 'node' AND event_type NOT LIKE 'COLLECTION\_VIEW\_%'
 GROUP BY target_id, actor_id;

CREATE FUNCTION node_event_meta_record() RETURNS trigger AS $$
BEGIN
  IF NEW.target_type = 'node' AND NEW.event_type NOT LIKE 'COLLECTION\_VIEW\_%' THEN
    INSERT INTO node_event_meta (node_id, actor_id, last_event_at)
    VALUES (NEW.target_id, NEW.actor_id, NEW.created_at)
    ON CONFLICT (node_id, actor_id) DO UPDATE
      SET last_event_at = GREATEST(node_event_meta.last_event_at, EXCLUDED.last_event_at);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER domain_events_node_event_meta
  AFTER INSERT ON domain_events
  FOR EACH ROW EXECUTE FUNCTION node_event_meta_record();
