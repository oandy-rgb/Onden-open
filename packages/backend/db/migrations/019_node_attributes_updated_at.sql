-- Local-first conflict detection (Day 4).
--
-- node_attributes now carries updated_at so the PUT endpoint can compare
-- the client's local timestamp against the row's server timestamp. When
-- they diverge, the server emits ATTRIBUTE_CONFLICT with both values
-- (last-write-wins still applies — the new write goes through). The Day 5
-- UI surfaces these in an inbox-style view for the reviewer.
--
-- Default of now() backfills existing rows with their import time; that's
-- fine since pre-Day-4 writes had no client timestamp to compare against.

ALTER TABLE node_attributes
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Index for queries that filter by recency (e.g. "show me attributes
-- touched in the last hour" — useful for the Day 5 conflict list).
CREATE INDEX IF NOT EXISTS node_attributes_updated_at_idx
  ON node_attributes (workspace_id, updated_at DESC);
