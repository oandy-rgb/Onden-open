-- 048: actor-aware version throttle — exempt agent writes from the throttle.
--
-- capture_node_version (migrations 030/032) throttles body-only changes within
-- a 5-minute window so human keystroke-driven saves don't explode the version
-- table. But that throttle SILENTLY DROPS the intermediate states — a burst of
-- body-only edits collapses to a single version per window (verified directly:
-- editing v1→v2→v3 within the window keeps v1 and the last pre-window state,
-- but loses v2).
--
-- For AGENT writes that loses traceability we can't afford: agent edits are
-- discrete tool calls (updateNode), each semantically distinct — not
-- keystrokes — and the human–agent parity / reproducibility guarantee requires
-- a COMPLETE agent version trail. So agents now bypass the throttle (every body
-- change captures a version); humans keep the 5-minute window unchanged.
--
-- The actor kind is read from the transaction-local `myapp.actor_type` GUC that
-- the spine's mutate() sets alongside `myapp.event_id` (see db.ts
-- setEventIdForTrigger). When the setting is absent — a content_nodes UPDATE
-- that didn't come through the spine — it's treated as a human write (throttle
-- applies). That's the safe default: it can only ADD throttling, never drop an
-- agent version.
--
-- Everything else (blob dedup, parent_version_id chain, event_id wiring from
-- 032) is byte-for-byte identical to the 032 function body.

CREATE OR REPLACE FUNCTION capture_node_version()
RETURNS TRIGGER AS $$
DECLARE
  new_hash         TEXT;
  last_version_id  UUID;
  last_version_at  TIMESTAMPTZ;
  throttle_minutes INTEGER := 5;
  event_id_setting TEXT;
  event_id_val     BIGINT := NULL;
BEGIN
  -- No-op if nothing meaningful changed.
  IF OLD.markdown = NEW.markdown AND OLD.title = NEW.title THEN
    RETURN NEW;
  END IF;

  new_hash := encode(digest(OLD.markdown, 'sha256'), 'hex');

  -- Ensure the blob exists (dedup: ON CONFLICT skips when another node has
  -- already saved the same content).
  INSERT INTO blobs (hash, content, size_bytes)
  VALUES (new_hash, OLD.markdown, octet_length(OLD.markdown))
  ON CONFLICT (hash) DO NOTHING;

  -- Most recent version for this node — parent in the chain AND the basis
  -- for the throttle check.
  SELECT id, changed_at
  INTO last_version_id, last_version_at
  FROM content_node_versions
  WHERE node_id = OLD.id
  ORDER BY changed_at DESC, id DESC
  LIMIT 1;

  -- Throttle body-only edits captured within the window — EXCEPT for agents,
  -- whose every edit must be captured. Title changes always capture.
  IF last_version_at IS NOT NULL
     AND last_version_at > (now() - (throttle_minutes::TEXT || ' minutes')::INTERVAL)
     AND OLD.title = NEW.title
     AND coalesce(current_setting('myapp.actor_type', true), '') <> 'ai_agent' THEN
    RETURN NEW;
  END IF;

  -- Transaction-local event_id set by the calling service (mutate()).
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
