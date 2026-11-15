-- 153: Web Push for task reminders (docs/architecture/day-timeline.md §5).
--
-- push_subscriptions: one row per browser/device a person turned lock-screen
-- reminders on for. The endpoint is the device's address at its push service
-- (unique: a device re-subscribing replaces its row, even under another
-- account); p256dh/auth are the keys the payload is encrypted to. A subscription
-- is only ever read by the server to send, never returned to a client.
--
-- push_reminder_sent: which reminder moment of which task was already pushed
-- (the same key the app uses, packages/markdown taskReminder). The claim is the
-- insert, so a restart or a second backend process cannot send it twice.
-- Both are operational state, not domain events: nothing here is undone or synced.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  CONSTRAINT push_subscriptions_endpoint_uq UNIQUE (endpoint)
);
CREATE INDEX IF NOT EXISTS push_subscriptions_actor_idx ON push_subscriptions (actor_id);

CREATE TABLE IF NOT EXISTS push_reminder_sent (
  task_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  moment text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, moment)
);
CREATE INDEX IF NOT EXISTS push_reminder_sent_at_idx ON push_reminder_sent (sent_at);
