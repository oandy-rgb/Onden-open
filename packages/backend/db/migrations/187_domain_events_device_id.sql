-- 187: domain_events.device_id — which browser or install a write came from (distributed-ready proposal §2 item 1).
-- The page sends one fixed UUID per device (X-Onden-Device-Id); spine/mutate records it on the event it writes, and a
-- cascade keeps its root's. NULL for tokens, background work and system events. Adds a nullable column only: no backfill,
-- no index, nothing read changes, and it is never sent to a client. Written at INSERT only (the append-only trigger stays).
-- Rolling back to an older backend: it never names the column, so nothing needs undoing.
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS device_id uuid;
