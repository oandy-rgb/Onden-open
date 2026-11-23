-- 229: a snapshot carries a note's versions and their content (docs/architecture/proposals/history-replication-2026-11-22.md §3.1, §3.4, §4.3; batch 3),
-- and the database that joins from it remembers how far that part has arrived (src/spine/stampedImport.ts applyStampedPage / markHistoryDone /
-- giveUpHistory, src/spine/historyLayer.ts). Adds: seven columns, two functions and one trigger. No existing row is read or deleted; the one UPDATE is below.
--
-- WHAT THIS ADDS
--   sync_join.history_hashes    { page number: sha256 of the page } of the history part (its `blobs` pages, then its `history` pages, one numbering), as
--                               page_hashes is for the rows: a page again with the same content is a no-op, with other content refused.
--   sync_join.history_through   the highest page number up to which every page of the history part is in (pages are taken in order).
--   sync_join.history_state     arriving        the notes are in (the workspace is in use), the history part is not all in: this node is no snapshot source
--                                               (services/stampedSnapshot.ts snapshotSourceNode: snapshot_source_history_incomplete);
--                               done            every page is in and what this node received equals what the source said it sent;
--                               given_up        the person stopped waiting for it (giveUpHistory): what had arrived of it was removed;
--                               missing         the join was finished before this migration: its source sent no versions (none could before data shape 9).
--                               given_up and missing are both "this device has no earlier versions": no snapshot source (snapshot_source_history_missing), and a
--                               file of the same source brings in only its history part (beginHistoryRefill), the notes untouched.
--   sync_join.history_from      null, or { cut, former, brought } of the file the history part is taken from when it is not the join's own (a refill: a newer file
--                               of the same source; its pages carry that header).
--   sync_join.history_scope     all, or body: the browser version keeps only the text history when the drawings' history is over the threshold (§10 question 4).
--   sync_join.history_left_out  how many versions the source holds without their content and so did not send (it says so in the manifest); shown, not hidden.
--   sync_join.history_skipped   [{ k, nu, h, c, unit, restoredFrom }]: the digests of versions this node did not store because it deleted their note for good while
--                               the history part was arriving, so its own delete does not keep the history part from completing (review of PR #1988 point 4b).
--   note_version_keep_skipped   a trigger: a received version removed while the history part is arriving keeps its digest in history_skipped.
--   note_version_digest(...)    one version's own digest (every identity field of §2.5 and its positions; a baseline's time is this node's record): the one
--                               definition both sides of a snapshot use (spine/historyLayer.ts).
--
-- WHAT THIS DOES TO EXISTING ROWS, on purpose
--   * a join that was finished before this migration ('done') gets history_state = 'missing' (the owner's decision of 2026-11-23 on PR #1988: such a device
--     never received any history, so it is not marked complete): from this upgrade on it CANNOT MAKE A FILE for another device until its earlier versions are
--     brought in from a file of its source (the screen says so in words). A join still running ('joining') gets 'arriving': it finishes, or is cancelled, under the
--     new rules.
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: ALTER TABLE sync_join DROP COLUMN history_hashes, history_through,
-- history_state, history_scope, history_left_out, history_skipped, history_from; DROP TRIGGER note_versions_keep_skipped ON note_versions;
-- DROP FUNCTION note_version_keep_skipped, note_version_digest (nothing of the older code reads them).
-- drill: no allowance needed. This migration writes no row of any table the drill compares.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; counts only):
--
--   SELECT 'finished joins marked missing: no file can be made from that device until its history is brought in' AS part, count(*)::bigint AS rows FROM sync_join WHERE state = 'done'
--   UNION ALL SELECT 'running joins marked arriving', count(*) FROM sync_join WHERE state = 'joining';

ALTER TABLE sync_join ADD COLUMN IF NOT EXISTS history_hashes jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sync_join ADD COLUMN IF NOT EXISTS history_through integer NOT NULL DEFAULT 0;
ALTER TABLE sync_join ADD COLUMN IF NOT EXISTS history_scope text NOT NULL DEFAULT 'all' CHECK (history_scope IN ('all', 'body'));
ALTER TABLE sync_join ADD COLUMN IF NOT EXISTS history_left_out integer NOT NULL DEFAULT 0;
ALTER TABLE sync_join ADD COLUMN IF NOT EXISTS history_skipped jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE sync_join ADD COLUMN IF NOT EXISTS history_from jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'sync_join' AND column_name = 'history_state') THEN
    ALTER TABLE sync_join ADD COLUMN history_state text NOT NULL DEFAULT 'arriving' CHECK (history_state IN ('arriving', 'done', 'given_up', 'missing'));
    UPDATE sync_join SET history_state = 'missing' WHERE state = 'done';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION note_version_digest(p_note uuid, p_unit text, p_key text, p_kind text, p_title text, p_hash text, p_at text, p_wall bigint, p_counter int,
                                               p_ordinal int, p_author_kind text, p_author uuid, p_restored text, p_source text, p_positions jsonb) RETURNS text AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(p_note, p_unit, p_key, p_kind, p_title, p_hash, CASE WHEN p_key LIKE 'b:%' THEN NULL ELSE p_at END, p_wall, p_counter,
                                                    p_ordinal, p_author_kind, p_author, p_restored, p_source, COALESCE(p_positions, '[]'::jsonb))::text, 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- A version this node received is removed while the history part is arriving (its note deleted for good here meanwhile, by the cascade): its digest is kept in
-- history_skipped, so the history part still completes (review of PR #1988 point 4b). Before the row goes, so its positions are still there.
CREATE OR REPLACE FUNCTION note_version_keep_skipped() RETURNS trigger AS $$
DECLARE v_local text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = OLD.workspace_id AND j.state = 'done' AND j.history_state = 'arriving') THEN RETURN OLD; END IF;
  SELECT node_id INTO v_local FROM sync_node WHERE singleton;
  IF NOT EXISTS (SELECT 1 FROM note_version_positions p WHERE p.note_id = OLD.note_id AND p.unit = OLD.unit AND p.version_key = OLD.version_key AND p.origin IS DISTINCT FROM v_local) THEN RETURN OLD; END IF;
  UPDATE sync_join SET history_skipped = history_skipped || jsonb_build_array(jsonb_build_object(
      'k', OLD.note_id::text || '/' || OLD.unit || '/' || OLD.version_key, 'nu', OLD.note_id::text || '/' || OLD.unit, 'unit', OLD.unit, 'restoredFrom', OLD.restored_from,
      'h', note_version_digest(OLD.note_id, OLD.unit, OLD.version_key, OLD.kind, OLD.title, OLD.content_hash, OLD.at, OLD.clock_wall, OLD.clock_counter, OLD.ordinal, OLD.author_kind,
             OLD.author_id, OLD.restored_from, OLD.source_name,
             (SELECT jsonb_agg(jsonb_build_array(p.origin, p.seq) ORDER BY p.origin COLLATE "C", p.seq) FROM note_version_positions p
               WHERE p.note_id = OLD.note_id AND p.unit = OLD.unit AND p.version_key = OLD.version_key AND p.origin IS DISTINCT FROM v_local)),
      'c', CASE WHEN OLD.content_hash IS NULL THEN NULL WHEN OLD.unit = 'body' THEN 'body:' || OLD.content_hash ELSE 'ink:' || OLD.note_id || ':' || OLD.content_hash END))
   WHERE workspace_id = OLD.workspace_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS note_versions_keep_skipped ON note_versions;
CREATE TRIGGER note_versions_keep_skipped BEFORE DELETE ON note_versions FOR EACH ROW EXECUTE FUNCTION note_version_keep_skipped();
