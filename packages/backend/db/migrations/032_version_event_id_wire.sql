-- Wire content_node_versions.event_id properly (ER3, was W4-deferred).
--
-- Migration 030 added the event_id column but left it NULL for every row
-- because the capture_node_version trigger has no way to know what event
-- the calling app code is about to emit. This migration closes that gap
-- using PG's transaction-local config setting:
--
--   1. App code emits the domain_event FIRST and captures the returned id.
--   2. App calls SELECT set_config('myapp.event_id', '<id>', true).
--      (`true` = transaction-local, vanishes at COMMIT/ROLLBACK.)
--   3. App runs the UPDATE that triggers capture_node_version.
--   4. Trigger reads current_setting('myapp.event_id', true) and stores
--      the value into content_node_versions.event_id.
--
-- This is atomic within the transaction; no race, no extra query, no
-- two-phase wire. When the setting is absent (e.g., a direct psql UPDATE
-- or a code path that hasn't been updated yet) current_setting returns
-- '' and the version row is captured with event_id=NULL — safe degradation.
--
-- Backfill strategy:
--   For existing NULL-event_id versions, match each version with the
--   closest domain_event whose target_id matches the version's node_id
--   and whose created_at is within 5 seconds of the version's changed_at.
--   Best-effort: rows that pre-date a corresponding event stay NULL.
--
-- Reference: there is no exact ref-app pattern for this — Trilium /
-- Logseq / SiYuan all keep version capture in their service layer rather
-- than in a DB trigger, so they wire the version → event link directly.
-- Onden's trigger-based capture predates the event_id column; this
-- migration is the bridge that keeps the trigger as the safety net while
-- letting the app layer drive the actual linkage.

CREATE OR REPLACE FUNCTION capture_node_version()
RETURNS TRIGGER AS $$
DECLARE
  new_hash               TEXT;
  last_version_id        UUID;
  last_version_at        TIMESTAMPTZ;
  throttle_minutes       INTEGER := 5;
  event_id_setting       TEXT;
  event_id_val           BIGINT := NULL;
BEGIN
  -- No-op if nothing meaningful changed.
  IF OLD.markdown = NEW.markdown AND OLD.title = NEW.title THEN
    RETURN NEW;
  END IF;

  new_hash := encode(digest(OLD.markdown, 'sha256'), 'hex');

  -- Ensure the blob exists (dedup point — ON CONFLICT skips when another
  -- node has already saved the same content).
  INSERT INTO blobs (hash, content, size_bytes)
  VALUES (new_hash, OLD.markdown, octet_length(OLD.markdown))
  ON CONFLICT (hash) DO NOTHING;

  -- Find the most recent version for this node — parent in the chain
  -- AND basis for the throttle check.
  SELECT id, changed_at
  INTO last_version_id, last_version_at
  FROM content_node_versions
  WHERE node_id = OLD.id
  ORDER BY changed_at DESC, id DESC
  LIMIT 1;

  -- Throttle: skip a body-only change captured within the window. Title
  -- changes always capture (rare, significant — see migration 030).
  IF last_version_at IS NOT NULL
     AND last_version_at > (now() - (throttle_minutes::TEXT || ' minutes')::INTERVAL)
     AND OLD.title = NEW.title THEN
    RETURN NEW;
  END IF;

  -- Read the transaction-local event_id setting that the calling service
  -- should have set via set_config('myapp.event_id', <id>, true). Empty
  -- string when the setting wasn't established — degraded path, version
  -- captures with event_id=NULL (still recoverable post-hoc via the
  -- backfill block at the bottom of this migration).
  event_id_setting := current_setting('myapp.event_id', true);
  IF event_id_setting IS NOT NULL AND event_id_setting <> '' THEN
    event_id_val := event_id_setting::BIGINT;
  END IF;

  INSERT INTO content_node_versions
    (node_id, workspace_id, title, markdown, blob_hash, parent_version_id, event_id)
  VALUES
    (OLD.id, OLD.workspace_id, OLD.title, OLD.markdown, new_hash, last_version_id, event_id_val);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Backfill best-effort. Targets versions whose event_id is NULL and finds
-- the nearest domain_event for the same node within ±5 seconds. Versions
-- that pre-date any matching event (or whose corresponding event was
-- pruned) remain NULL — documented as "historical, not restorable through
-- the event-id link" in the restore endpoint.
WITH matched AS (
  SELECT DISTINCT ON (v.id)
    v.id     AS version_id,
    de.id    AS event_id
  FROM content_node_versions v
  JOIN domain_events de
    ON de.target_type = 'node'
   AND de.target_id   = v.node_id::text
   AND de.event_type IN ('NODE_UPDATED', 'NODE_CREATED', 'NODE_VERSION_APPROVED')
   AND ABS(EXTRACT(EPOCH FROM (de.created_at - v.changed_at))) < 5
  WHERE v.event_id IS NULL
  ORDER BY v.id, ABS(EXTRACT(EPOCH FROM (de.created_at - v.changed_at))) ASC
)
UPDATE content_node_versions cnv
SET event_id = m.event_id
FROM matched m
WHERE cnv.id = m.version_id;
