-- 071_actor_weak_fk.sql
--
-- Weak referential integrity for the three actor-attribution columns that
-- carry an actor reference as bare text and have no FK to actors(id):
--
--   * domain_events.actor_id
--   * dispatcher_pending.actor_id
--   * event_reviews.reviewed_by
--
-- A hard FK is wrong here on purpose (see migration 065's header): these
-- columns hold EITHER a real actors.id uuid OR a free-form attribution
-- sentinel for autonomous/daemon/external origins that have no actor row —
-- 'system-task-scheduler' (services/taskScheduler.ts), 'feed' (modules/rss),
-- and similar. They must also survive their referent actor being deleted
-- (actors are deletable; dispatcher catch-up discards unresolvable intents at
-- replay time, inbox tolerates a vanished reviewer).
--
-- So the by-construction invariant we CAN enforce is exactly the one the app
-- layer already enforces in services/nodes.ts loadActor():
--
--   "if the reference is uuid-shaped, it MUST resolve to a real actor in this
--    workspace; non-uuid strings are sentinels and pass freely."
--
-- This closes the real integrity hole — a uuid actor_id that points at no
-- actor (typo, wrong workspace, deleted-then-reused id, client-supplied junk)
-- can no longer be written — while leaving sentinels and actor deletion
-- untouched. It is a write-time (BEFORE INSERT) check only: there is no
-- ON DELETE binding, so deleting an actor never rewrites or blocks existing
-- rows; it only (correctly) rejects NEW events minted for a now-gone actor.

-- Resolver: true unless `ref` is uuid-shaped AND no such actor exists in `ws`.
-- The uuid regex is the gate — `ref::uuid` is only reached for uuid-shaped
-- input (the CASE short-circuits), so a sentinel string never hits the cast.
CREATE OR REPLACE FUNCTION public.actor_ref_resolves(ws uuid, ref text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN ref IS NULL THEN true
    WHEN ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN true
    ELSE EXISTS (
      SELECT 1 FROM public.actors a WHERE a.id = ref::uuid AND a.workspace_id = ws
    )
  END;
$$;

-- Generic BEFORE INSERT trigger: TG_ARGV[0] = the actor-reference column name.
-- Reads the value (and workspace_id) off the row via to_jsonb so one function
-- serves all three tables.
CREATE OR REPLACE FUNCTION public.assert_actor_ref()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col text := TG_ARGV[0];
  ref text := (to_jsonb(NEW) ->> col);
  ws  uuid := (to_jsonb(NEW) ->> 'workspace_id')::uuid;
BEGIN
  IF NOT public.actor_ref_resolves(ws, ref) THEN
    RAISE EXCEPTION
      '%.% = % is uuid-shaped but resolves to no actor in workspace %',
      TG_TABLE_NAME, col, ref, ws
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS domain_events_actor_ref ON public.domain_events;
CREATE TRIGGER domain_events_actor_ref
  BEFORE INSERT ON public.domain_events
  FOR EACH ROW EXECUTE FUNCTION public.assert_actor_ref('actor_id');

DROP TRIGGER IF EXISTS dispatcher_pending_actor_ref ON public.dispatcher_pending;
CREATE TRIGGER dispatcher_pending_actor_ref
  BEFORE INSERT ON public.dispatcher_pending
  FOR EACH ROW EXECUTE FUNCTION public.assert_actor_ref('actor_id');

DROP TRIGGER IF EXISTS event_reviews_reviewed_by_ref ON public.event_reviews;
CREATE TRIGGER event_reviews_reviewed_by_ref
  BEFORE INSERT ON public.event_reviews
  FOR EACH ROW EXECUTE FUNCTION public.assert_actor_ref('reviewed_by');
