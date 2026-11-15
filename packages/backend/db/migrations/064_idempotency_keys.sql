-- Idempotency keys for replayed client writes (offline-sync follow-up to the
-- 2026-06-12 audit #4): the reconnect drain retries queued writes; network
-- ambiguity (response lost after the server applied) or a second device
-- replaying the same queue could double-apply. A queued write carries a
-- client-minted UUID in the Idempotency-Key header; the API records it here
-- and short-circuits repeats. Rows are prunable after a generous window —
-- the queue never retries across weeks.

CREATE TABLE idempotency_keys (
  key uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
