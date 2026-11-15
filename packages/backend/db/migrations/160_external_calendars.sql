-- 160: external calendars (read-only iCal subscriptions shown on the day timeline).
--
-- external_calendars: one row per calendar a person subscribed to. Personal: every
-- query is by actor_id, no space, no domain event, nothing synced as a note. The
-- calendar's address is a secret (it often carries a private token), so it is kept
-- only as AES-256-GCM ciphertext (ONDEN_SECRET_KEY, services/aiCredentials.ts); the
-- host alone is kept in the clear, to tell calendars apart in the list.
-- last_error is a short code (unreachable / not_calendar / too_large / blocked), never text from the other server.
--
-- external_calendar_events: the instances the last fetch expanded for a window of
-- days around now (repeats already unrolled). Replaced whole on each fetch. Not nodes:
-- not in the tree, search or published pages. All-day events keep calendar dates
-- (start_date .. end_date, end exclusive); the others keep instants.
-- Additive: no existing row changes.

CREATE TABLE IF NOT EXISTS external_calendars (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  color text NOT NULL CHECK (char_length(color) <= 16),
  url_ciphertext bytea NOT NULL,
  url_host text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  last_attempt_at timestamptz,
  last_error text CHECK (last_error IS NULL OR last_error IN ('unreachable', 'not_calendar', 'too_large', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS external_calendars_actor_idx ON external_calendars (actor_id, created_at);

CREATE TABLE IF NOT EXISTS external_calendar_events (
  calendar_id uuid NOT NULL REFERENCES external_calendars(id) ON DELETE CASCADE,
  instance_key text NOT NULL,
  title text NOT NULL,
  location text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  all_day boolean NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  start_date date,
  end_date date,
  PRIMARY KEY (calendar_id, instance_key)
);
CREATE INDEX IF NOT EXISTS external_calendar_events_range_idx ON external_calendar_events (calendar_id, starts_at);
