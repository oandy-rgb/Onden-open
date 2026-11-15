-- Allow DELETE on domain_events for retention cleanup (trigger previously blocked it)
DROP TRIGGER IF EXISTS domain_events_no_update ON domain_events;
CREATE TRIGGER domain_events_no_update
  BEFORE UPDATE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION domain_events_immutable();
