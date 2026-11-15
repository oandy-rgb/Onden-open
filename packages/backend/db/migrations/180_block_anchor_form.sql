-- 180: the progress column of moving block identity out of the text (段落錨點批 3).
--
-- A paragraph's identity was an `^id` written in its note's body; it now lives in `block_anchors` and the body carries
-- none (docs/architecture/proposals/block-anchors-2026-11-01.md §11). Moving the existing notes over is a job, not SQL:
-- SQL cannot read Markdown (code fences, quotes, nested lists), and a rewrite must go through the note's own save so
-- history, merge and derived state stay true (services/blockIdMigration.ts, run by the system job block-marker-repair).
-- This file only adds the column that job keeps its place with. It changes no note, no body and no `updated_at`.
--
--   anchor_form  0  may still carry `^id` marks — every note that existed when this ran
--                1  converted, or created since: its text is read without `^id` marks
--                2  looked at and left as it is: the marks cannot be shown to be removable without changing what the
--                   note means (a hashtag block that exists only through its `^id`, a body too long to read blocks in);
--                   listed in the job's report for a person to decide, never retried on a guess
--
-- Existing rows get 0 (the column's value when it was added); the default is then switched to 1, so a note created
-- from now on is never mistaken for one that still has marks (a `^abc` it holds is the author's own text).
-- Safe to run again.
--
-- The notes the job then rewrites lose their `^id` marks (nothing else of their text changes: stripLegacyIds
-- refuses a note it cannot show reads the same), so the restore drill, if it runs the job after this file, will
-- see changed note bodies — declared here, with the list left for the reviewer to read:
-- drill: allows note-bodies
ALTER TABLE content_nodes ADD COLUMN IF NOT EXISTS anchor_form smallint NOT NULL DEFAULT 0;
ALTER TABLE content_nodes ALTER COLUMN anchor_form SET DEFAULT 1;
CREATE INDEX IF NOT EXISTS content_nodes_anchor_form_idx ON content_nodes (workspace_id) WHERE anchor_form = 0;
