-- 161: block anchors — where a paragraph lives, kept beside the text, never in it.
--
-- A paragraph's identity used to be a `^id` inside the body. Now the body has no
-- mark at all; this table says "anchor X is the block at [from, to) of note N, and
-- this is what it said". The server moves the positions on every body write
-- (services/blockAnchors/), checks the result against `quote`, and when it cannot
-- follow the text it looks the quote up again: found and unique = valid, doubtful =
-- maybe (the user confirms), nothing close = lost (the best guess is kept).
-- It never points silently somewhere else.
-- Positions are UTF-16 code units (the unit of textPatch.ts), `at_body_hash` is the
-- body they were measured on: a row whose hash differs from the note's body was
-- left behind by a write that did not move anchors, and is re-found from its quote.
-- An anchor id is never reused (lost rows stay); a note in the trash keeps its rows.
-- Additive: no existing row changes; nothing reads the table yet (shadow mode).

CREATE TABLE IF NOT EXISTS block_anchors (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  anchor_id text NOT NULL CHECK (anchor_id ~ '^[a-zA-Z0-9-]{1,64}$'),
  note_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'block' CHECK (kind IN ('block', 'range')),
  from_utf16 integer NOT NULL CHECK (from_utf16 >= 0),
  to_utf16 integer NOT NULL CHECK (to_utf16 >= from_utf16),
  at_body_hash text NOT NULL,
  quote text NOT NULL,
  quote_prefix text NOT NULL DEFAULT '',
  quote_suffix text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'maybe', 'lost')),
  -- maybe: where it may be; lost: the best guess (NULL when nothing resembles it).
  candidate_from_utf16 integer,
  candidate_to_utf16 integer,
  -- Over the per-save find budget: re-found by the next body write.
  recovery_pending boolean NOT NULL DEFAULT false,
  -- This id also names the block `alias_of` (two paragraphs joined into one).
  alias_of text,
  moved_how text NOT NULL DEFAULT 'created' CHECK (moved_how IN ('created', 'editor', 'diff', 'found', 'confirmed', 'unchanged')),
  moved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, anchor_id)
);
CREATE INDEX IF NOT EXISTS block_anchors_note_idx ON block_anchors (note_id);
