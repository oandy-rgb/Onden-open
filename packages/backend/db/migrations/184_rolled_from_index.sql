-- A repeating task mints its next occurrence once, ever (owner 2026-11-09): completing it asks the event log whether
-- this task already minted one (services/tasksStore.ts taskMintedNextOccurrence: a NODE_CREATED event whose payload
-- names it as `rolled_from`). Without an index that question scans every event of the workspace, inside the event
-- lock. This partial index holds only the minted occurrences' NODE_CREATED events. Adds an index; changes no data.
CREATE INDEX IF NOT EXISTS domain_events_rolled_from_idx
  ON domain_events (workspace_id, (payload->>'rolled_from'))
  WHERE event_type = 'NODE_CREATED' AND (payload->>'rolled_from') IS NOT NULL;
