-- 164: which paragraph a `[[筆記/段落開頭]]` link means — kept beside the text, never in it.
--
-- A part link reads `[[Note/first words]]`. The words are for people (and are how a link typed by hand is
-- found); what the link MEANS is the anchor id stored here: (the note the link is written in, the link as
-- written) -> block_anchors.anchor_id. So the paragraph is found by identity after its first words change,
-- and the note's name or the words after the `/` may be out of date without the link breaking. The words
-- are refreshed only when the person edits the note the link is written in (never by the target's edit).
-- link_text is the link target as written (before `|`), NFC and single-spaced (markdown bindingKey()).
-- Rows go with the source note; the anchor they name is never reused, so a row can outlive its anchor's
-- paragraph (the anchor says lost) but never name another paragraph.
-- Additive: no existing row changes.

CREATE TABLE IF NOT EXISTS block_link_bindings (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  link_text text NOT NULL CHECK (char_length(link_text) BETWEEN 1 AND 400),
  anchor_id text NOT NULL CHECK (anchor_id ~ '^[a-zA-Z0-9-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, note_id, link_text)
);
-- "who links to this paragraph" (the count before a delete, the citations list).
CREATE INDEX IF NOT EXISTS block_link_bindings_anchor_idx ON block_link_bindings (workspace_id, anchor_id);
