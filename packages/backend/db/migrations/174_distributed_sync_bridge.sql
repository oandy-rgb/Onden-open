-- 174: distributed sync (beta), step 2a. Ties the engine (173) to the real notes. Nothing existing changes except one CHECK.
--
--   ds_capture_cursor   one row: the last domain_events id already turned into ops (or counted as unsupported).
--   ds_captured_events  one row per event the capture looked at, so running it twice never makes an op twice.
--   ds_unsupported      what the engine cannot carry yet, by event type: counted, never silently dropped.
--   ds_projection_failures  a remote change the projection could not write through the normal services (diagnostics).
--   space_members.permission gains 'suggest': read, never write. It is the stranger role of a collaboration link
--   (docs/architecture/distributed-sync.md §5). Only the sync projection writes it; the members API still offers view / edit.
-- Off by default (ONDEN_DISTRIBUTED_SYNC): while off these tables stay empty and no code reads or writes them.

CREATE TABLE IF NOT EXISTS ds_capture_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_event_id bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ds_captured_events (
  event_id bigint PRIMARY KEY,
  op_count integer NOT NULL CHECK (op_count >= 0),
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ds_unsupported (
  event_type text PRIMARY KEY,
  event_count bigint NOT NULL DEFAULT 0,
  first_event_id bigint NOT NULL,
  last_event_id bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS ds_projection_failures (
  id bigserial PRIMARY KEY,
  op_id text,
  note_id text,
  step text NOT NULL,
  reason text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE space_members DROP CONSTRAINT IF EXISTS space_members_permission_check;
ALTER TABLE space_members ADD CONSTRAINT space_members_permission_check CHECK (permission IN ('view', 'suggest', 'edit'));
