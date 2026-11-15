-- History rewind ("還原到這時") marks every event it writes with
-- tx_meta.rewind_id, and its undo marks events with tx_meta.undoes_rewind
-- (services/history/rewind.ts). The History feed and the undo look rewinds up
-- by these keys; domain_events has no index on tx_meta, so without these the
-- lookups would scan every event. Both indexes are partial: they only hold the
-- (rare) events of a rewind. No data changes, no event is rewritten.
CREATE INDEX IF NOT EXISTS domain_events_rewind_idx
    ON domain_events (workspace_id, created_at)
 WHERE tx_meta ? 'rewind_id';
CREATE INDEX IF NOT EXISTS domain_events_rewind_undo_idx
    ON domain_events (workspace_id, created_at)
 WHERE tx_meta ? 'undoes_rewind';
