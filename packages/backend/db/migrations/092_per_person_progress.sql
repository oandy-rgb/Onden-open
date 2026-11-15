-- Per-person module progress (docs/architecture/spaces.md, 「模組的個人進度」).
--
-- Notes are shared; how far each person got with them is not. Review state,
-- "seen" in the RSS reader and "done" in read-later were stored once per note
-- (a `_review_state` attribute, rss_staging.seen_at, removing the tag), so one
-- person's study or reading moved everyone else's. RemNote's shared knowledge
-- bases have exactly this complaint; AnkiHub and Feedly keep progress per
-- person. Rows here are keyed by (thing, actor); actor ids are stored as text
-- like imported_media.actor_id, and member removal deletes them
-- (services/memberRemovals.ts).

-- FSRS state per (note, person). Replaces the `_review_state` attribute.
CREATE TABLE IF NOT EXISTS review_states (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  state text NOT NULL,
  -- The state before the latest grade: one-step "undo grade" for its owner.
  previous_state text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, actor_id)
);
CREATE INDEX IF NOT EXISTS review_states_actor_idx ON review_states (workspace_id, actor_id);

-- "I have seen this feed item" per person. rss_staging.seen_at stays the
-- stream's own lifecycle (pre-seen backfill, auto-aging, tombstoning).
CREATE TABLE IF NOT EXISTS rss_seen (
  staging_id uuid NOT NULL REFERENCES rss_staging(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  -- false = this person marked it unseen again, even after the stream aged it.
  seen boolean NOT NULL DEFAULT true,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staging_id, actor_id)
);

-- "I finished reading this" per person, for read-later.
CREATE TABLE IF NOT EXISTS read_later_done (
  node_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  done_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, actor_id)
);

-- Personal overrides of a module tag's settings (review: new cards per day,
-- target recall, longest interval). Layering like VS Code: module default →
-- tag setting → personal override.
CREATE TABLE IF NOT EXISTS actor_module_settings (
  actor_id text NOT NULL,
  tag_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  settings jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, tag_id)
);

-- Backfill: everyone keeps the schedule they saw before. Each human or agent
-- actor gets a copy of every existing review state; reads stay gated by the
-- note's read policy, so a copy for someone who cannot read the note is inert.
INSERT INTO review_states (workspace_id, node_id, actor_id, state, updated_at)
SELECT na.workspace_id, na.node_id, a.id::text, na.value, na.updated_at
  FROM node_attributes na
  JOIN actors a ON a.workspace_id = na.workspace_id
 WHERE na.key = '_review_state'
ON CONFLICT (node_id, actor_id) DO NOTHING;
