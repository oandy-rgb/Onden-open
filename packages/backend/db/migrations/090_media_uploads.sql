-- Who uploaded each media file (docs/architecture/spaces.md, phase 0).
--
-- A media file had no owner record: canReadMedia let anyone who could read ANY
-- node referencing `/api/media/<file>` read it, so pasting a seen URL into
-- your own note granted permanent access. Reads now follow the OLDEST
-- referencing node (the one the file was attached to); this table answers who
-- may preview an upload before any note references it. Files from before this
-- migration have no row and keep the old "any signed-in member" preview rule.
CREATE TABLE IF NOT EXISTS media_uploads (
  filename text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uploader_actor_id text NOT NULL,  -- actors.id as text, like imported_media.actor_id
  created_at timestamptz NOT NULL DEFAULT now()
);
