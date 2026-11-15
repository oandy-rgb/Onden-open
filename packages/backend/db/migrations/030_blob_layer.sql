-- W3-prep: blob layer for content-addressable versioning.
--
-- Replaces the canonical-content role that git.ts (simple-git) was nominally
-- handling but in practice failing silently on (the content/ store isn't
-- initialised in dev). Going forward, the PG content_node_versions table
-- holds the version chain pointing into a content-addressable blobs table.
--
-- Reference (Trilium-main/packages/trilium-core/src/assets/schema.sql):
--   Trilium has `blobs(blobId, content, ...)` + revisions referencing blob
--   via `blobId` column. Onden mirrors the shape with two differences:
--     1. SHA-256 hex hash (vs Trilium's SHA-512 base64). Hex is uglier but
--        composes cleaner with URL paths if we ever expose blobs as REST.
--     2. parent_version_id chain — Trilium revisions are linear-by-date
--        only; Onden gains an explicit DAG so fork/branch later doesn't
--        require schema change.
--
-- See memory/project_onden_real_state for Onden's pre-blob shape and
-- memory/feedback_problem_solving_reference_first for why we matched
-- Trilium's blob pattern instead of inventing one.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Content-addressable storage. Identical content saved twice produces one
-- blob row (dedup), and the hash gives us a stable identity for future
-- features like cross-note transclusion or signed snapshots.
CREATE TABLE IF NOT EXISTS blobs (
  hash         TEXT PRIMARY KEY,                       -- sha256 hex of `content`
  content      TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Extend the existing version table. Old `markdown` column stays for
-- rollback safety; a follow-up migration drops it once read paths join
-- blobs (TimelineView + publish diff).
ALTER TABLE content_node_versions
  ADD COLUMN IF NOT EXISTS blob_hash          TEXT,
  ADD COLUMN IF NOT EXISTS parent_version_id  UUID REFERENCES content_node_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS commit_msg         TEXT,
  ADD COLUMN IF NOT EXISTS label              TEXT,
  ADD COLUMN IF NOT EXISTS event_id           BIGINT REFERENCES domain_events(id) ON DELETE SET NULL;

-- Backfill: hash existing markdown into blobs, then point versions at them.
INSERT INTO blobs (hash, content, size_bytes)
SELECT DISTINCT
  encode(digest(markdown, 'sha256'), 'hex'),
  markdown,
  octet_length(markdown)
FROM content_node_versions
WHERE markdown IS NOT NULL
ON CONFLICT (hash) DO NOTHING;

UPDATE content_node_versions
SET blob_hash = encode(digest(markdown, 'sha256'), 'hex')
WHERE blob_hash IS NULL AND markdown IS NOT NULL;

-- Now blob_hash can be required + FK enforced.
ALTER TABLE content_node_versions
  ALTER COLUMN blob_hash SET NOT NULL,
  ADD CONSTRAINT content_node_versions_blob_hash_fk
    FOREIGN KEY (blob_hash) REFERENCES blobs(hash);

-- Backfill parent_version_id: chronological chain within each node. Uses
-- (changed_at, id) as a stable sort so versions written in the same second
-- still order deterministically.
WITH chained AS (
  SELECT id,
         LAG(id) OVER (PARTITION BY node_id ORDER BY changed_at, id) AS prev_id
  FROM content_node_versions
)
UPDATE content_node_versions cnv
SET parent_version_id = chained.prev_id
FROM chained
WHERE cnv.id = chained.id AND chained.prev_id IS NOT NULL;

-- Index for dedup queries ("how many versions reference this blob") and
-- for future "find all notes containing exact body X" semantic queries.
CREATE INDEX IF NOT EXISTS content_node_versions_blob_hash_idx
  ON content_node_versions (blob_hash);

CREATE INDEX IF NOT EXISTS content_node_versions_parent_idx
  ON content_node_versions (parent_version_id);

CREATE INDEX IF NOT EXISTS content_node_versions_event_idx
  ON content_node_versions (event_id);

-- Rewrite the capture trigger to use the blob layer + add a throttle window
-- so rapid keystroke-driven saves don't explode the version table.
CREATE OR REPLACE FUNCTION capture_node_version()
RETURNS TRIGGER AS $$
DECLARE
  new_hash               TEXT;
  last_version_id        UUID;
  last_version_at        TIMESTAMPTZ;
  throttle_minutes       INTEGER := 5;
BEGIN
  -- No-op if nothing meaningful changed.
  IF OLD.markdown = NEW.markdown AND OLD.title = NEW.title THEN
    RETURN NEW;
  END IF;

  new_hash := encode(digest(OLD.markdown, 'sha256'), 'hex');

  -- Ensure the blob exists (dedup: ON CONFLICT skips if another node had
  -- the same content earlier).
  INSERT INTO blobs (hash, content, size_bytes)
  VALUES (new_hash, OLD.markdown, octet_length(OLD.markdown))
  ON CONFLICT (hash) DO NOTHING;

  -- Find the most recent version for this node — it'll be our parent in
  -- the chain and the basis for the throttle check.
  SELECT id, changed_at
  INTO last_version_id, last_version_at
  FROM content_node_versions
  WHERE node_id = OLD.id
  ORDER BY changed_at DESC, id DESC
  LIMIT 1;

  -- Throttle: if a version was captured within the window AND only the body
  -- (not the title) changed, drop the new one. Title changes always capture
  -- because they're rare + semantically significant.
  IF last_version_at IS NOT NULL
     AND last_version_at > (now() - (throttle_minutes::TEXT || ' minutes')::INTERVAL)
     AND OLD.title = NEW.title THEN
    RETURN NEW;
  END IF;

  -- Capture. `markdown` column kept duplicated with the blob until a follow-
  -- up migration drops it once readers are JOIN-on-blob.
  INSERT INTO content_node_versions
    (node_id, workspace_id, title, markdown, blob_hash, parent_version_id)
  VALUES
    (OLD.id, OLD.workspace_id, OLD.title, OLD.markdown, new_hash, last_version_id);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger binding unchanged from before — schema.sql already has:
--   CREATE TRIGGER node_version_capture
--     BEFORE UPDATE ON content_nodes
--     FOR EACH ROW EXECUTE FUNCTION capture_node_version();
-- The OR REPLACE above swaps in the new function body in place.

-- Drop the dead `git_commit` column on content_nodes. No code reads or
-- writes it (verified via grep across packages/) — it was scaffolding for
-- the simple-git layer that never got wired into the read path.
ALTER TABLE content_nodes DROP COLUMN IF EXISTS git_commit;
