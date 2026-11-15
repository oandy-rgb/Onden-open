-- 072_actor_weak_fk_update_guard.sql
--
-- 071's weak-FK triggers were BEFORE INSERT only. That left a hole: a table with
-- no append-only guard can have its actor-reference column changed by an UPDATE
-- (notably INSERT ... ON CONFLICT (event_id) DO UPDATE SET reviewed_by = <phantom
-- uuid>), and an UPDATE does not fire a BEFORE INSERT trigger — so a uuid-shaped
-- reference that resolves to no actor could slip in via UPDATE.
--
-- Fix: extend the guard to BEFORE INSERT OR UPDATE OF <ref column> for the two
-- tables whose actor column is NOT otherwise immutable:
--   * event_reviews.reviewed_by   — no append-only guard; DO UPDATE is reachable.
--   * dispatcher_pending.actor_id  — no append-only guard either (insert+delete in
--     code today, but defended by construction rather than by assumption).
--
-- domain_events.actor_id needs NO update guard: domain_events_no_update (mig 051)
-- already raises on every UPDATE to that table, so the column is immutable.
--
-- The trigger FUNCTION (assert_actor_ref) is unchanged — it reads the column off
-- NEW via to_jsonb, which is populated identically for INSERT and UPDATE.

DROP TRIGGER IF EXISTS event_reviews_reviewed_by_ref ON public.event_reviews;
CREATE TRIGGER event_reviews_reviewed_by_ref
  BEFORE INSERT OR UPDATE OF reviewed_by ON public.event_reviews
  FOR EACH ROW EXECUTE FUNCTION public.assert_actor_ref('reviewed_by');

DROP TRIGGER IF EXISTS dispatcher_pending_actor_ref ON public.dispatcher_pending;
CREATE TRIGGER dispatcher_pending_actor_ref
  BEFORE INSERT OR UPDATE OF actor_id ON public.dispatcher_pending
  FOR EACH ROW EXECUTE FUNCTION public.assert_actor_ref('actor_id');
