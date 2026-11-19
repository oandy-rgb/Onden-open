-- 212: the event position a write committed at, kept with its idempotency key, so a replay of the same key answers with the ORIGINAL
-- position (X-Onden-Event-Position), not "no position" and never the head the server has moved on to (frontend lib/answerPositions.ts).
-- Adds only: one nullable column. No existing row is read, changed or deleted; rows from before it keep NULL (a replay of them carries
-- no position, as before this migration). Number assigned by the sync line (note-cf).
--
--   event_position   the id of the last domain_events row the key's transaction committed (spine/idempotency.ts recordClaimPosition,
--                    written in the same transaction as the claim, after insertEvent); NULL for a claim that wrote no event.
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS event_position bigint;
