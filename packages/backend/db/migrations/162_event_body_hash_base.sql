-- 162: domain_events records which version a body change came from.
--
-- body_hash: the note body after this event (SHA-256 hex of the UTF-8 markdown, no
--   normalisation — the same hash payload.body_hash carries and blobs is keyed by).
-- base_hash: the body this write was made from. An editor save sends the body it
--   started from (merge base); every other write is based on the body it replaced.
--   NULL: the first version of a note (nothing before it).
-- Both are filled in one place (db.ts insertEvent) from payload.body_hash, never
-- by a caller. Old events are NOT backfilled: readers fall back to payload.body_hash
-- and take the previous body event as the only parent (services/history/versionParents.ts).
-- Columns, not tx_meta: "which event has body_hash = X" needs an index, and a jsonb
-- expression index on every event would cost more than one partial b-tree.
-- Additive and repeatable: no existing row changes.

ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS body_hash text;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS base_hash text;
CREATE INDEX IF NOT EXISTS domain_events_body_hash_idx ON domain_events (body_hash) WHERE body_hash IS NOT NULL;
COMMENT ON COLUMN domain_events.body_hash IS 'Note body after this event (sha256 hex of the markdown, not normalised). Same value as payload.body_hash; events before migration 162 have NULL.';
COMMENT ON COLUMN domain_events.base_hash IS 'Body this write was made from (the editor''s merge base, else the body it replaced). NULL for a note''s first version and for events before migration 162.';
