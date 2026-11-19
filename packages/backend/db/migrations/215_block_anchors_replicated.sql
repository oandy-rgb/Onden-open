-- 215: a body write's anchors and paragraph rows are replicated: the node where the person wrote mints their ids once, they get write stamps and travel
-- with the write (docs/architecture/proposals/anchors-deterministic-2026-11-16.md §3.1 design A, §5.1 steps 2-3; the owner's answer of 2026-11-17).
-- Running it changes, moves or deletes no row of block_anchors or block_nodes: it adds triggers, functions and stamps. What it installs then rewrites a row of an
-- old shape when it first writes that note's anchors (note_anchor_places_write; see "WHAT THIS DOES NOT DO").
--
-- WHAT THIS ADDS
--   note_anchor_places (new table, label 'note_anchor_places', key note_id): ONE unit per note, `places`, the places of ALL its anchors (from_utf16, to_utf16,
--                   status, candidate_from_utf16, candidate_to_utf16, recovery_pending, quote, quote_prefix, quote_suffix) and the hash of the body they were measured
--                   on (review of PR #1853, round 2, point 2). Every body write of a note that holds anchors writes its unit (the hash at least changes), so the
--                   anchors' places carry the stamp of the same write as the body: the two win and lose together (PR #1759, note-cf's answer 2), and a save writes
--                   one row and one stamp whatever the number of anchors. A note without anchor rows has no unit, and its body writes write none. On the node that
--                   writes, the unit FOLLOWS the rows after each statement that writes them (a statement trigger, once per note it touched, note_anchor_places_follow); on a node that takes a
--                   bundle, the rows follow the unit: for EVERY note whose body, anchors unit or anchor rows the bundle changes (round 3, point 1), the merge core
--                   picks the head measured on the stored body and writes it into the rows, all the bundle's notes in one statement
--                   (spine/stampedMerge/dbUnits.ts expandAnchorUnits, note_anchor_places_expand_all). No head on the stored body: every anchor row is `lost`.
--   block_anchors stamp triggers (label 'block_anchors', key anchor_id): the row ('*', its identity, minted by the writer) and `note` (note_id: which note holds
--                   it; it changes when a paragraph moves into a child note and back). Its place is the expansion of its note's unit, not a unit of its own. An
--                   UPDATE that changes anchor_id (the old `^id` conversion, services/blockIdMigration.ts renameAnchor) is a removal of the old key and a
--                   creation of the new one. kind, alias_of and created_at are creation values (carried with the row); moved_how and moved_at are this node's
--                   own diagnostics (no reader).
--   note_anchor_places_is_rows and the check at the end of note_anchor_places_expand_all: the unit and the rows never disagree in silence. The writer's unit,
--                   expanded, makes every row exactly and names no anchor without a row; the receiver's rows give back the head it expanded. Raises
--                   `anchor_unit_not_rows` (OD215); a merge turns it into a refusal of the bundle (`bundle_malformed`).
--   block_nodes stamp triggers (label 'block_nodes', key id): the row ('*': the paragraph row's id, minted by the writer), `note` (note_id), `anchor`
--                   (anchor_id), `ref` (block_ref), `task` (task_id: which task note the line is), `detached` (detached_note_id + detached_tags: the paragraph
--                   stands alone as a child note). label, text_cache, kind, parent_block_id and hidden_at are worked out from the body and its anchors by every
--                   write (services/blockNodes.ts syncBlockNodes): carried with the row's creation, not units.
--   block_anchors_hash_is_body   a statement trigger: an anchor row whose at_body_hash is written (inserted, or at_body_hash / note_id changed by an update; a rename is neither) must carry the
--                   sha-256 of its note's body as it stands in that statement, the body of the write that placed it. A merge or a snapshot import (the stamp
--                   triggers stand aside) writes what the core decided and is not checked here. Raises `anchor_hash_not_body` (SQLSTATE OD215).
--   sync_stamps.kept_value, sync_stamp_heads.valueless (round 8): a stamp kept without its row (moved into a note that was then deleted for good) keeps the value
--                   it wrote, and a head that came without its value says so; a NULL column and a constant default, no row rewritten. Section 2c.
--   genesis stamps  sync_genesis_pass() (migration 202, redefined by 209) stamps every existing anchor and paragraph row '*' with the genesis stamp, as it did
--                   for every other stamped table: the same constants on every node, nothing taken from this node. No unit is made for a note that holds anchors
--                   today: its rows are the same on every node already (they came with the snapshot), and its next anchor write makes its unit with a real stamp.
--
-- WHAT THIS DOES NOT DO, on purpose
--   * running it rewrites no existing row, and note_anchor_places starts empty. Afterwards, the first write of a note's anchors puts a row of an old shape right
--     (valid with a candidate or waiting to be looked up, not valid and standing somewhere: note_anchor_places_write; the preview counts them). An anchor whose at_body_hash is not the hash of its note's body (left by a write before the anchors moved with every write,
--     or by a note whose body changed while its anchors were not read) stays as it is: the next body write of the note finds it by its quote (it is not trusted
--     by position, mapping.ts) and writes its place with a real stamp, which beats the genesis stamp. The preview counts them.
--   * block_link_bindings, review_states and focus_sessions stay without a trigger (spine/syncClasses.json); media first-come and the attributes a body
--     derives under its writer's authority are not here (proposal table 2.3, later batches).
--   * nothing re-derives what a merged body implies (links, search text, paragraph labels): batch 2b-2b.
--   * no event, no sync_clock change, no outbox job, no workspaces.membership_epoch change.
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward; an older backend refuses a database with a migration it does not know).
-- In place: DROP the triggers below, the table note_anchor_places and the functions this file defines; DELETE FROM sync_stamps WHERE table_name IN ('block_anchors', 'block_nodes', 'note_anchor_places')
-- removes the stamps (nothing else reads them); the structure log lines of the baseline cannot be deleted (append-only) and are harmless.
-- drill: no allowance needed. This migration writes only sync_stamps and structure_log (the baseline markers of the genesis pass); the two columns it adds to
-- sync_stamps and sync_stamp_heads rewrite no row.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; uses only tables that exist before this
-- migration; counts only, never a title, text, id or value):
--
--   SELECT 'block_anchors rows that get a genesis stamp (none is rewritten)' AS part, count(*)::bigint AS rows FROM block_anchors
--   UNION ALL SELECT 'of which the hash is not their note''s body (left as they are; the next write of the note finds them by quote)', count(*)
--     FROM block_anchors a JOIN content_nodes c ON c.id = a.note_id WHERE a.at_body_hash <> encode(sha256(convert_to(COALESCE(c.markdown, ''), 'UTF8')), 'hex')
--   UNION ALL SELECT 'block_nodes rows that get a genesis stamp (none is rewritten)', count(*) FROM block_nodes
--   UNION ALL SELECT 'block_nodes rows linked to a task note', count(*) FROM block_nodes WHERE task_id IS NOT NULL
--   UNION ALL SELECT 'notes still to be converted from `^id` (anchor_form = 0) that hold an anchor whose hash is not their body (renameAnchor runs on them; it writes no hash)', count(DISTINCT c.id)
--     FROM content_nodes c JOIN block_anchors a ON a.note_id = c.id WHERE c.anchor_form = 0 AND a.at_body_hash <> encode(sha256(convert_to(COALESCE(c.markdown, ''), 'UTF8')), 'hex')
--   UNION ALL SELECT 'notes that hold anchors and get their anchors unit at their next anchor write (none is made now)', count(DISTINCT note_id) FROM block_anchors
--   UNION ALL SELECT 'anchors measured on their note''s body, valid with a candidate or waiting to be looked up (the next write of the note''s anchors puts them right)', count(*)
--     FROM block_anchors a JOIN content_nodes c ON c.id = a.note_id WHERE a.at_body_hash = encode(sha256(convert_to(COALESCE(c.markdown, ''), 'UTF8')), 'hex')
--      AND a.status = 'valid' AND (a.candidate_from_utf16 IS NOT NULL OR a.candidate_to_utf16 IS NOT NULL OR a.recovery_pending)
--   UNION ALL SELECT 'anchors measured on their note''s body, not valid and standing somewhere (the next write of the note''s anchors puts them right)', count(*)
--     FROM block_anchors a JOIN content_nodes c ON c.id = a.note_id WHERE a.at_body_hash = encode(sha256(convert_to(COALESCE(c.markdown, ''), 'UTF8')), 'hex')
--      AND a.status <> 'valid' AND (a.from_utf16 <> 0 OR a.to_utf16 <> 0)
--   UNION ALL SELECT 'block_anchors rows in another workspace than their note (expected 0; see below)', count(*) FROM block_anchors a JOIN content_nodes c ON c.id = a.note_id WHERE a.workspace_id <> c.workspace_id
--   UNION ALL SELECT 'block_nodes rows in another workspace than their note (expected 0; see below)', count(*) FROM block_nodes b JOIN content_nodes c ON c.id = b.note_id WHERE b.workspace_id <> c.workspace_id
--   UNION ALL SELECT 'rows of any table rewritten by running this migration (the anchors counted above are put right later, at their note''s next anchor write)', 0
--   ;
-- The two "another workspace" lines: a row whose workspace is not its note's is refused at its next write from 215 on (sync_rows_in_their_notes_workspace, section 2c:
-- OD215, so every save of that note fails). No writer of this repository makes one (it takes the workspace from the note). If either count is not 0, deploy nothing:
-- the rows are a fault to look at first (which notes: replace count(*) by the note ids). Their fix is to take the note's workspace, one statement per table, e.g.
--   UPDATE block_anchors a SET workspace_id = c.workspace_id FROM content_nodes c WHERE c.id = a.note_id AND a.workspace_id <> c.workspace_id;
-- and the same for block_nodes; this migration does not run it on its own, as it rewrites no row.

-- 1. block_anchors: the row (its id) and `note` ------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER block_anchors_sync_stamp_insert AFTER INSERT ON block_anchors FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('block_anchors', 'anchor_id', 'via:note_id', 'note=note_id', '', '', '');
CREATE OR REPLACE TRIGGER block_anchors_sync_stamp_update AFTER UPDATE ON block_anchors FOR EACH ROW
  WHEN (OLD.anchor_id IS NOT DISTINCT FROM NEW.anchor_id AND OLD.note_id IS DISTINCT FROM NEW.note_id)
  EXECUTE FUNCTION sync_stamp_trigger('block_anchors', 'anchor_id', 'via:note_id', 'note=note_id', '', '', '');
CREATE OR REPLACE TRIGGER block_anchors_sync_stamp_rekey_gone AFTER UPDATE ON block_anchors FOR EACH ROW
  WHEN (OLD.anchor_id IS DISTINCT FROM NEW.anchor_id)
  EXECUTE FUNCTION sync_stamp_trigger('block_anchors', 'anchor_id', 'via:note_id', 'note=note_id', '', '', 'asdelete');
CREATE OR REPLACE TRIGGER block_anchors_sync_stamp_rekey_made AFTER UPDATE ON block_anchors FOR EACH ROW
  WHEN (OLD.anchor_id IS DISTINCT FROM NEW.anchor_id)
  EXECUTE FUNCTION sync_stamp_trigger('block_anchors', 'anchor_id', 'via:note_id', 'note=note_id', '', '', 'asinsert');
-- The three tables of this migration file a row's stamps under its note ('via:note_id', the rule of every table filed under a note, migration 194): anything the
-- foreign key's cascade does to a row on the way out with its note (a task link set to null) writes no stamp of its own (review of PR #1853, round 5, point 1). Whenever
-- the note is there this is the row's own workspace_id, the column every read uses. A row's delete is a statement trigger (section 2c: what goes with its note).

-- 1b. note_anchor_places: ONE unit per note, the places of all its anchors (review of PR #1853, round 2) ---------------------------------------------------
-- `places` = {"h": <sha-256 of the note's body>, "a": {<anchor id>: [from, to, status, candidate_from, candidate_to, recovery_pending, quote, prefix, suffix]}}; an anchor
-- whose own at_body_hash is not "h" (a row left stale before 215 and not looked at since) carries that hash as a tenth element, so the expansion gives back the row exactly.
-- The text is jsonb's own (keys by length then bytes, ", " and ": "): a received unit written any other way is refused (spine/stampedMerge/anchorUnit.ts parseAnchorUnit).
-- On the node that writes, the unit FOLLOWS the rows: after every statement that wrote anchors of a note, note_anchor_places_follow() writes the note's unit from
-- its rows (one row and one stamp per note per statement, whatever the number of anchors). On a node that takes a bundle, the rows follow the unit:
-- the merge core picks the head whose "h" is the stored body's (spine/stampedMerge/anchorUnit.ts chooseAnchorHead) and writes it into the rows (note_anchor_places_expand_all).
CREATE TABLE IF NOT EXISTS note_anchor_places (
  note_id uuid PRIMARY KEY REFERENCES content_nodes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  places jsonb NOT NULL
);
CREATE OR REPLACE TRIGGER note_anchor_places_sync_stamp_insert AFTER INSERT ON note_anchor_places FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('note_anchor_places', 'note_id', 'via:note_id', 'places=places', '', '', '');
CREATE OR REPLACE TRIGGER note_anchor_places_sync_stamp_update AFTER UPDATE ON note_anchor_places FOR EACH ROW
  WHEN (OLD.places IS DISTINCT FROM NEW.places)
  EXECUTE FUNCTION sync_stamp_trigger('note_anchor_places', 'note_id', 'via:note_id', 'places=places', '', '', '');

-- The one thing this file remembers within a transaction is the hash of the last body it worked out, `onden.anchor_body_last` = "<note id>|<ctid>|<sha-256>"
-- (block_anchor_body_hash): one entry, so its cost does not grow with the notes a transaction touches (review of PR #1853, round 4, point 2).
-- The one way from a row to its entry in a unit measured on the body `p_h` (an anchor whose own at_body_hash is not `p_h` carries it as a tenth element).
CREATE OR REPLACE FUNCTION note_anchor_entry(p_from int, p_to int, p_status text, p_cf int, p_ct int, p_pending boolean, p_quote text, p_prefix text, p_suffix text,
                                             p_hash text, p_h text) RETURNS jsonb AS $$
  SELECT jsonb_build_array(p_from, p_to, p_status, p_cf, p_ct, p_pending, p_quote, p_prefix, p_suffix) || CASE WHEN p_hash = p_h THEN '[]'::jsonb ELSE jsonb_build_array(p_hash) END;
$$ LANGUAGE sql IMMUTABLE;
-- The anchors of `p_note` as its unit names them ("a"), measured on `p_h`. NULL when the note has no anchor row.
CREATE OR REPLACE FUNCTION note_anchor_places_of(p_ws uuid, p_note uuid, p_h text) RETURNS jsonb AS $$
  SELECT jsonb_object_agg(a.anchor_id, note_anchor_entry(a.from_utf16, a.to_utf16, a.status, a.candidate_from_utf16, a.candidate_to_utf16, a.recovery_pending,
           a.quote, a.quote_prefix, a.quote_suffix, a.at_body_hash, p_h))
    FROM block_anchors a WHERE a.workspace_id = p_ws AND a.note_id = p_note;
$$ LANGUAGE sql STABLE;
-- The one way from a unit to a row: the place of an anchor row as `p_entry` (the chosen head's entry for it, or NULL) makes it, measured on `p_hash`.
--   named by the chosen head: its place as the head says;
--   not named (made by a write whose body lost, or no head on the stored body): it stands nowhere and is `lost`, measured on `p_hash`; its words are `p_words`
--   ([quote, prefix, suffix] from the newest head that names it, spine/stampedMerge/anchorUnit.ts chooseAnchorHead), or, when no head names it, none: what the row
--   held is history (the words an earlier expansion wrote, or a sender's row as it stood), not replicated state (review of PR #1853, round 4, point 6). It is then
--   an anchor that is never found again.
CREATE OR REPLACE FUNCTION note_anchor_place(p_entry jsonb, p_words jsonb, p_quote text, p_prefix text, p_suffix text, p_hash text,
    OUT from_utf16 int, OUT to_utf16 int, OUT status text, OUT candidate_from_utf16 int, OUT candidate_to_utf16 int, OUT recovery_pending boolean,
    OUT quote text, OUT quote_prefix text, OUT quote_suffix text, OUT at_body_hash text) AS $$
  SELECT COALESCE((p_entry->>0)::int, 0), COALESCE((p_entry->>1)::int, 0), COALESCE(p_entry->>2, 'lost'),
         CASE WHEN p_entry IS NULL THEN NULL ELSE (p_entry->>3)::int END, CASE WHEN p_entry IS NULL THEN NULL ELSE (p_entry->>4)::int END,
         COALESCE((p_entry->>5)::boolean, false),
         CASE WHEN p_entry IS NULL THEN COALESCE(p_words->>0, '') ELSE COALESCE(p_entry->>6, p_quote) END,
         CASE WHEN p_entry IS NULL THEN COALESCE(p_words->>1, '') ELSE COALESCE(p_entry->>7, p_prefix) END,
         CASE WHEN p_entry IS NULL THEN COALESCE(p_words->>2, '') ELSE COALESCE(p_entry->>8, p_suffix) END, COALESCE(p_entry->>9, p_hash);
$$ LANGUAGE sql IMMUTABLE;

-- The largest unit a node takes, in bytes of its text (UTF-8, the text jsonb writes): spine/stampedMerge/anchorUnit.ts ANCHOR_UNIT_BYTES_MAX is the same number (a test
-- compares the two). A writer never writes a larger one (note_anchor_places_write): a unit every receiver refuses would stop the writer's whole stream, not one note.
CREATE OR REPLACE FUNCTION anchor_unit_bytes_max() RETURNS bigint AS $$ SELECT 16000000::bigint $$ LANGUAGE sql IMMUTABLE;
-- The unit of `p_note` from its anchor rows, written when it differs (no rows: the unit is removed). When it would be larger than anchor_unit_bytes_max(), the words
-- (quote and context) of the note's anchors are dropped, the oldest lost ones first, then the oldest `maybe` ones, then the oldest valid ones, until it is not: a lost
-- anchor without its words is never found again (its paragraph row stays hidden and its task in the trash, its links say the paragraph is gone); a `maybe` one can no
-- longer be confirmed by its words; a valid one keeps its place, and takes new words the next time a save moves it. The rows are written too, so the unit is still
-- its rows (review of PR #1853, round 4, point 3).
CREATE OR REPLACE FUNCTION note_anchor_places_write(p_ws uuid, p_note uuid) RETURNS void AS $$
DECLARE v_h text; v jsonb; v_over bigint; v_lost bigint; v_maybe bigint; v_valid bigint;
BEGIN
  v_h := block_anchor_body_hash(p_note);
  IF v_h IS NULL THEN RETURN; END IF; -- the note is gone: its unit went with it
  -- a row measured on this body that code before 215 left in a shape no writer gives it now (valid with a candidate or waiting to be looked up; not valid and standing
  -- somewhere: services/blockAnchors/mapping.ts) would make a unit every receiver refuses: it is put right here, whatever wrote the note's anchors (a save puts it
  -- right too; a write of one anchor's place would not have). Rows measured on another body carry their own hash in the unit and are taken as they are.
  UPDATE block_anchors SET candidate_from_utf16 = CASE WHEN status = 'valid' THEN NULL ELSE candidate_from_utf16 END,
         candidate_to_utf16 = CASE WHEN status = 'valid' THEN NULL ELSE candidate_to_utf16 END, recovery_pending = CASE WHEN status = 'valid' THEN false ELSE recovery_pending END,
         from_utf16 = CASE WHEN status = 'valid' THEN from_utf16 ELSE 0 END, to_utf16 = CASE WHEN status = 'valid' THEN to_utf16 ELSE 0 END
   WHERE workspace_id = p_ws AND note_id = p_note AND at_body_hash = v_h
     AND CASE WHEN status = 'valid' THEN candidate_from_utf16 IS NOT NULL OR candidate_to_utf16 IS NOT NULL OR recovery_pending ELSE from_utf16 <> 0 OR to_utf16 <> 0 END;
  v := note_anchor_places_of(p_ws, p_note, v_h);
  IF v IS NULL THEN
    DELETE FROM note_anchor_places WHERE note_id = p_note;
    RETURN;
  END IF;
  v_over := octet_length(jsonb_build_object('h', v_h, 'a', v)::text) - anchor_unit_bytes_max();
  IF v_over > 0 THEN
    -- what each anchor's words take in the unit's text (each written as a JSON string; an empty one is two bytes), in the order they are given up
    WITH given AS (
      UPDATE block_anchors a SET quote = '', quote_prefix = '', quote_suffix = ''
        FROM (SELECT d.anchor_id, COALESCE(sum(d.words) OVER (ORDER BY d.rank, d.created_at, d.anchor_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
                FROM (SELECT b.anchor_id, b.created_at, CASE b.status WHEN 'lost' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END AS rank,
                             octet_length(to_jsonb(b.quote)::text) + octet_length(to_jsonb(b.quote_prefix)::text) + octet_length(to_jsonb(b.quote_suffix)::text) - 6 AS words
                        FROM block_anchors b WHERE b.workspace_id = p_ws AND b.note_id = p_note) d) g
       WHERE a.workspace_id = p_ws AND a.note_id = p_note AND a.anchor_id = g.anchor_id AND g.before < v_over
         AND (a.quote, a.quote_prefix, a.quote_suffix) IS DISTINCT FROM ('', '', '')
      RETURNING a.status)
    SELECT count(*) FILTER (WHERE status = 'lost'), count(*) FILTER (WHERE status = 'maybe'), count(*) FILTER (WHERE status NOT IN ('lost', 'maybe'))
      INTO v_lost, v_maybe, v_valid FROM given;
    -- words given up cannot be had back: one line in the database's log names the note and how many of each kind (review of PR #1853, round 5, point 3)
    RAISE WARNING 'anchors unit of note % was over its bound of % bytes: the words of % lost, % maybe and % valid anchors were given up', p_note, anchor_unit_bytes_max(), v_lost, v_maybe, v_valid
      USING HINT = 'anchor_words_given_up';
    v := note_anchor_places_of(p_ws, p_note, v_h);
  END IF;
  INSERT INTO note_anchor_places (note_id, workspace_id, places) VALUES (p_note, p_ws, jsonb_build_object('h', v_h, 'a', v))
    ON CONFLICT (note_id) DO UPDATE SET places = EXCLUDED.places WHERE note_anchor_places.places IS DISTINCT FROM EXCLUDED.places;
END;
$$ LANGUAGE plpgsql;
-- After every statement that wrote anchor rows, once for each note the statement touched (its transition tables), whatever order the rows came in: the note's unit
-- from its rows as they stand (review of PR #1853, round 4, point 2: a row trigger deferred to COMMIT wrote a note's unit again for every row whenever the rows of
-- several notes came interleaved, 20 times per note for a statement over 500 notes). A transaction whose statements write a note's anchors twice writes its unit twice;
-- the last write is the one that stays, and each is one row and one stamp. A merge or a snapshot import writes the rows from the unit instead and is skipped.
CREATE OR REPLACE FUNCTION note_anchor_places_follow() RETURNS trigger AS $$
DECLARE r record; v_notes uuid[]; v_ws uuid[];
BEGIN
  -- each branch names only the transition tables its event has (a query is planned when it runs)
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(n.note_id), array_agg(n.workspace_id) INTO v_notes, v_ws FROM (SELECT DISTINCT workspace_id, note_id FROM new_rows) n;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(n.note_id), array_agg(n.workspace_id) INTO v_notes, v_ws FROM (SELECT DISTINCT workspace_id, note_id FROM old_rows) n;
  ELSE
    SELECT array_agg(n.note_id), array_agg(n.workspace_id) INTO v_notes, v_ws
      FROM (SELECT DISTINCT workspace_id, note_id FROM new_rows UNION SELECT DISTINCT workspace_id, note_id FROM old_rows) n;
  END IF;
  FOR r IN SELECT DISTINCT x.w, x.n FROM unnest(v_ws, v_notes) AS x(w, n) WHERE NOT sync_import_active(x.w) LOOP
    PERFORM note_anchor_places_write(r.w, r.n);
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS block_anchors_unit_follows ON block_anchors; -- the deferred row trigger of an earlier draft of this migration
CREATE OR REPLACE TRIGGER block_anchors_unit_follows_insert AFTER INSERT ON block_anchors REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION note_anchor_places_follow();
CREATE OR REPLACE TRIGGER block_anchors_unit_follows_update AFTER UPDATE ON block_anchors REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION note_anchor_places_follow();
CREATE OR REPLACE TRIGGER block_anchors_unit_follows_delete AFTER DELETE ON block_anchors REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION note_anchor_places_follow();

-- The unit and the rows never disagree in silence. Two checks, one each way, so a fault in either of the two functions above is caught by the other:
--   on the node that writes (a deferred constraint trigger on note_anchor_places, skipped by a merge or an import): every entry of the unit as written makes its row exactly
--   (note_anchor_place), and every row of the note has an entry (rows -> unit -> rows; one pass over the note's rows, a FULL JOIN of the unit's entries with them);
--   on the node that takes a bundle (note_anchor_places_expand_all, after it wrote the rows): the rows give back the chosen head, for every anchor this node holds
--   (unit -> rows -> unit, note_anchor_entry).
-- Raises `anchor_unit_not_rows` (SQLSTATE OD215).
CREATE OR REPLACE FUNCTION note_anchor_places_is_rows() RETURNS trigger AS $$
DECLARE v_now jsonb;
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  -- a unit written twice in one transaction (two statements wrote the note's anchors) queues this check twice: the version a later write replaced, or a unit removed
  -- since, is not the one that stays, and the later write's own check looks at the one that does
  SELECT places INTO v_now FROM note_anchor_places WHERE note_id = NEW.note_id;
  IF v_now IS NULL OR v_now IS DISTINCT FROM NEW.places THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM (SELECT * FROM block_anchors b WHERE b.workspace_id = NEW.workspace_id AND b.note_id = NEW.note_id) a
               FULL JOIN jsonb_each(NEW.places->'a') e ON e.key = a.anchor_id
               LEFT JOIN LATERAL note_anchor_place(e.value, NULL, a.quote, a.quote_prefix, a.quote_suffix, NEW.places->>'h') x ON true
              WHERE e.key IS NULL OR a.anchor_id IS NULL
                 OR (a.from_utf16, a.to_utf16, a.status, a.candidate_from_utf16, a.candidate_to_utf16, a.recovery_pending, a.quote, a.quote_prefix, a.quote_suffix, a.at_body_hash)
                    IS DISTINCT FROM (x.from_utf16, x.to_utf16, x.status, x.candidate_from_utf16, x.candidate_to_utf16, x.recovery_pending, x.quote, x.quote_prefix, x.quote_suffix, x.at_body_hash)) THEN
    RAISE EXCEPTION 'the anchors unit of note % is not its anchor rows', NEW.note_id USING ERRCODE = 'OD215', HINT = 'anchor_unit_not_rows', DETAIL = NEW.note_id::text;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS note_anchor_places_is_rows ON note_anchor_places;
CREATE CONSTRAINT TRIGGER note_anchor_places_is_rows AFTER INSERT OR UPDATE ON note_anchor_places DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION note_anchor_places_is_rows();

-- The receiving side, once for a whole bundle: `p_items` = [{"n": note, "p": the chosen head or null, "h": the body the rows are measured on, "w": {anchor id: [quote,
-- prefix, suffix]} for the anchors the head does not name}] (spine/stampedMerge/dbUnits.ts expandAnchorUnits). Every anchor row of those notes is written as
-- note_anchor_place makes it (only rows that change), then checked to give each chosen head back.
CREATE OR REPLACE FUNCTION note_anchor_places_expand_all(p_ws uuid, p_items jsonb) RETURNS void AS $$
BEGIN
  UPDATE block_anchors a SET (from_utf16, to_utf16, status, candidate_from_utf16, candidate_to_utf16, recovery_pending, quote, quote_prefix, quote_suffix, at_body_hash) =
      (SELECT x.from_utf16, x.to_utf16, x.status, x.candidate_from_utf16, x.candidate_to_utf16, x.recovery_pending, x.quote, x.quote_prefix, x.quote_suffix, x.at_body_hash
         FROM note_anchor_place(i.p->'a'->a.anchor_id, i.w->a.anchor_id, a.quote, a.quote_prefix, a.quote_suffix, i.h) x)
    FROM jsonb_to_recordset(p_items) AS i(n uuid, p jsonb, h text, w jsonb)
   WHERE a.workspace_id = p_ws AND a.note_id = i.n
     AND ROW(a.from_utf16, a.to_utf16, a.status, a.candidate_from_utf16, a.candidate_to_utf16, a.recovery_pending, a.quote, a.quote_prefix, a.quote_suffix, a.at_body_hash)
         IS DISTINCT FROM (SELECT ROW(x.from_utf16, x.to_utf16, x.status, x.candidate_from_utf16, x.candidate_to_utf16, x.recovery_pending, x.quote, x.quote_prefix, x.quote_suffix, x.at_body_hash)
                             FROM note_anchor_place(i.p->'a'->a.anchor_id, i.w->a.anchor_id, a.quote, a.quote_prefix, a.quote_suffix, i.h) x);
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_items) AS i(n uuid, p jsonb, h text, w jsonb)
               CROSS JOIN LATERAL jsonb_each(i.p->'a') e
               JOIN block_anchors r ON r.workspace_id = p_ws AND r.anchor_id = e.key AND r.note_id = i.n
              WHERE i.p IS NOT NULL
                AND note_anchor_entry(r.from_utf16, r.to_utf16, r.status, r.candidate_from_utf16, r.candidate_to_utf16, r.recovery_pending, r.quote, r.quote_prefix,
                                      r.quote_suffix, r.at_body_hash, i.p->>'h') IS DISTINCT FROM e.value) THEN
    RAISE EXCEPTION 'the anchors unit of a note is not its anchor rows' USING ERRCODE = 'OD215', HINT = 'anchor_unit_not_rows';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- The hash an anchor is written with is the body of the write that placed it (proposal §3.1: "at_body_hash = the body's hash").
-- Checked once per statement (a save writes all of a note's anchors in one statement), for the rows that WRITE the hash: every inserted row; an updated row whose
-- at_body_hash or note_id changed (paired with its old row by anchor_id); a row whose anchor_id changed (renameAnchor, the `^id` conversion) only when its (note, hash) is
-- not one an updated row of the same statement had before: a rename writes no hash. The body's hash is worked out once per version of a note in a transaction: keyed by the
-- note row's ctid, which every update of the note changes, kept in one transaction-local setting, the last note's (onden.anchor_body_last).
CREATE OR REPLACE FUNCTION block_anchor_body_hash(p_note uuid) RETURNS text AS $$
DECLARE v_ctid text; v_cached text; v_hash text;
BEGIN
  SELECT ctid::text INTO v_ctid FROM content_nodes WHERE id = p_note;
  IF v_ctid IS NULL THEN RETURN NULL; END IF;
  v_cached := current_setting('onden.anchor_body_last', true);
  IF v_cached IS NOT NULL AND split_part(v_cached, '|', 1) = p_note::text AND split_part(v_cached, '|', 2) = v_ctid THEN RETURN split_part(v_cached, '|', 3); END IF;
  SELECT encode(sha256(convert_to(COALESCE(markdown, ''), 'UTF8')), 'hex') INTO v_hash FROM content_nodes WHERE id = p_note;
  PERFORM set_config('onden.anchor_body_last', p_note::text || '|' || v_ctid || '|' || v_hash, true);
  RETURN v_hash;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION block_anchors_hash_is_body() RETURNS trigger AS $$
DECLARE bad uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    WITH written AS (SELECT DISTINCT n.note_id, n.at_body_hash FROM new_rows n WHERE NOT sync_import_active(n.workspace_id))
    SELECT w.note_id INTO bad FROM written w WHERE w.at_body_hash IS DISTINCT FROM block_anchor_body_hash(w.note_id) LIMIT 1;
  ELSE
    WITH written AS (
      SELECT DISTINCT n.note_id, n.at_body_hash FROM new_rows n
       WHERE NOT sync_import_active(n.workspace_id)
         AND NOT EXISTS (SELECT 1 FROM old_rows o WHERE o.workspace_id = n.workspace_id AND o.anchor_id = n.anchor_id AND o.note_id = n.note_id AND o.at_body_hash = n.at_body_hash)
         AND (EXISTS (SELECT 1 FROM old_rows o WHERE o.workspace_id = n.workspace_id AND o.anchor_id = n.anchor_id)
              OR NOT EXISTS (SELECT 1 FROM old_rows o WHERE o.workspace_id = n.workspace_id AND o.note_id = n.note_id AND o.at_body_hash = n.at_body_hash)))
    SELECT w.note_id INTO bad FROM written w WHERE w.at_body_hash IS DISTINCT FROM block_anchor_body_hash(w.note_id) LIMIT 1;
  END IF;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'an anchor of note % was written with the hash of another body than the note''s', bad USING ERRCODE = 'OD215', HINT = 'anchor_hash_not_body', DETAIL = bad::text;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER block_anchors_hash_is_body_insert AFTER INSERT ON block_anchors REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION block_anchors_hash_is_body();
CREATE OR REPLACE TRIGGER block_anchors_hash_is_body_update AFTER UPDATE ON block_anchors REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION block_anchors_hash_is_body();

-- 2. block_nodes -------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER block_nodes_sync_stamp_insert AFTER INSERT ON block_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('block_nodes', 'id', 'via:note_id', 'note=note_id,anchor=anchor_id,ref=block_ref,task=task_id,detached=detached_note_id+detached_tags', '', '', '');
CREATE OR REPLACE TRIGGER block_nodes_sync_stamp_update AFTER UPDATE ON block_nodes FOR EACH ROW
  WHEN ((OLD.note_id, OLD.anchor_id, OLD.block_ref, OLD.task_id, OLD.detached_note_id, OLD.detached_tags)
        IS DISTINCT FROM (NEW.note_id, NEW.anchor_id, NEW.block_ref, NEW.task_id, NEW.detached_note_id, NEW.detached_tags))
  EXECUTE FUNCTION sync_stamp_trigger('block_nodes', 'id', 'via:note_id', 'note=note_id,anchor=anchor_id,ref=block_ref,task=task_id,detached=detached_note_id+detached_tags', '', '', '');

-- 2c. what goes with its note (review of PR #1853, round 6, points 2 and 3) -----------------------------------------------------------------------------------------------
-- ONE rule for the three tables (spine/stampedMerge/dbUnits.ts `goesWithNote`): a row whose note is not on this node goes with it.
--   * a row made in that note (its `note` never written since: no stamp of its own) goes with no trace: its stamps and their heads are removed. Every node that holds it
--     holds it in that note, so the note's tombstone says it went; a received cascade does the same on every node. An anchors unit (keyed by its note) is always this.
--   * a row moved into that note (its `note` has a stamp of its own) keeps its stamps: they are the one record that it went, for a node that still holds it where it was
--     (that node removes the row when the move reaches it: dbRows.ts, the same rule). They carry no text of the note (an anchor's or a paragraph row's ids).
--   * a row deleted while its note is here is a delete as any other: its tombstone (sync_stamp_row_deleted, what sync_stamp_trigger does for a deleted row).
-- One statement trigger per table (transition table), so a note's rows cost one statement, not one trigger call per row (a space purged at once is one DELETE).
-- A stamp kept without its row keeps the value it wrote (review of PR #1853, round 8): sync_stamps.kept_value, `{"text": …}` the unit's text as sync_logged_value
-- gives it (the trigger's argument names the columns, the same list as the stamp trigger's), NULL where the row's column holds it. A head keeps its value as it always
-- did; `valueless` marks a head (a copy of a write) that came without one, which a merge never writes into a column (spine/stampedMerge/unit.ts `valueless`). Adding
-- them rewrites no row (a NULL and a constant default).
ALTER TABLE sync_stamps ADD COLUMN IF NOT EXISTS kept_value jsonb;
ALTER TABLE sync_stamp_heads ADD COLUMN IF NOT EXISTS valueless boolean NOT NULL DEFAULT false;
-- A kept value is the stamp's while that stamp is the unit's: a write made here replaces the stamp (a new origin or number), and its value is the row's column again.
-- The merge writes kept values itself (the stamp triggers stand aside), so this clears only on the node that writes. Review of PR #1853, round 9, point 1: a
-- column a foreign key emptied keeps its id on the stamp, on a row that is here, so the next write of that unit must not leave the old id behind.
-- Where a stamp may keep a value at all (review of PR #1853, round 9, point 2): the tables whose rows go with their note (ids, and a paragraph's detached state)
-- and the units a foreign key empties (an id). Nowhere else: a row of another table that is not here, because its note or space was deleted for good, keeps no text.
-- The same lists as spine/stampedMerge/dbUnits.ts `goesWithNote` and `clearedOnDelete` (stampedBundleSources.integration.test.ts compares them).
CREATE OR REPLACE FUNCTION sync_stamp_may_keep_value(p_label text, p_field text) RETURNS boolean AS $$
  SELECT p_label IN ('block_anchors', 'block_nodes', 'note_anchor_places')
      OR (p_label, p_field) IN (('content_nodes', 'parent'), ('spaces', 'owner'), ('rss_subscriptions', 'auto_tag'), ('rss_subscriptions', 'default_parent'));
$$ LANGUAGE sql IMMUTABLE;
ALTER TABLE sync_stamps DROP CONSTRAINT IF EXISTS sync_stamps_kept_value_where;
ALTER TABLE sync_stamps ADD CONSTRAINT sync_stamps_kept_value_where
  CHECK (kept_value IS NULL OR NOT (kept_value ? 'text') OR sync_stamp_may_keep_value(table_name, field)) NOT VALID;
-- A unit a foreign key empties (spine/stampedMerge/dbUnits.ts `clearedOnDelete`): when the row it names is deleted and the database empties the column, and no
-- stamp is written for that (a merge's triggers stand aside; a paragraph row's stamps are filed under its note, which the same statement may have deleted first), the
-- id stays on the unit's stamp, as its write said it (review of PR #1853, round 9, point 1: one statement deletes a note and the task under it, and whether the row
-- still named its task when it went depended on the order; the receiver deletes one note at a time in key order). One rule on the node that writes and the node that
-- merges. A unit with its own stamp row keeps the id there; one that follows its row's creation gets the stamp row a kept value needs (a copy of the creation's
-- stamp, empty saw: what storeUnit writes). An emptying that IS stamped (a local write over a row whose note is here) is a write of its own and keeps nothing.
-- Arguments: label, key column, workspace column, the note column whose absence means no stamp ('' when stamps never depend on it),
-- 'field:column:spec:named table:named column,…' (the guard compares them with the foreign keys of the catalog and dbUnits.ts clearedOnDelete).
CREATE OR REPLACE FUNCTION sync_keep_emptied_id() RETURNS trigger AS $$
DECLARE e text; v_field text; v_col text; v_spec text; v_reft text; v_refc text; v_ref text; v_ws uuid; v_key text; v_gone boolean; v_old text; v_note uuid;
BEGIN
  v_ws := sync_column(OLD, TG_ARGV[2])::uuid;
  -- first what costs nothing: an emptying that IS stamped is a write of its own, so on the node that writes nothing is kept unless the row's stamps could not be
  -- written (its note is gone: one primary-key look-up). A person's「取消任務」 or a move to the top level returns here (review of PR #1853, round 10, point 1).
  IF NOT sync_import_active(v_ws) THEN
    IF TG_ARGV[3] = '' THEN RETURN NULL; END IF;
    -- the id taken first: sync_column is volatile, and a volatile call in the predicate is no index key (the scan stops at the first match, wherever it is)
    v_note := sync_column(OLD, TG_ARGV[3])::uuid;
    IF EXISTS (SELECT 1 FROM content_nodes c WHERE c.id = v_note) THEN RETURN NULL; END IF;
  END IF;
  v_key := sync_column(OLD, TG_ARGV[1]);
  FOREACH e IN ARRAY string_to_array(TG_ARGV[4], ',') LOOP
    v_field := split_part(e, ':', 1); v_col := split_part(e, ':', 2); v_spec := split_part(e, ':', 3); v_reft := split_part(e, ':', 4); v_refc := split_part(e, ':', 5);
    v_ref := sync_column(OLD, v_col);
    IF v_ref IS NULL OR sync_column(NEW, v_col) IS NOT NULL THEN CONTINUE; END IF;
    -- emptied by the foreign key (the row it names is gone), not written NULL by someone: one look-up on the named table's key, compared as its own type
    EXECUTE format('SELECT NOT EXISTS (SELECT 1 FROM %I WHERE %I = $1::%s)', v_reft, v_refc, (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = v_reft::regclass AND a.attname = v_refc))
      INTO STRICT v_gone USING v_ref;
    IF NOT v_gone THEN CONTINUE; END IF;
    v_old := sync_logged_value(OLD, v_field, v_spec);
    UPDATE sync_stamps SET kept_value = jsonb_build_object('text', v_old)
     WHERE workspace_id = v_ws AND table_name = TG_ARGV[0] AND row_key = v_key AND field = v_field AND NOT deleted AND kept_value IS NULL;
    IF NOT FOUND THEN
      INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta, kept_value)
      SELECT v_ws, TG_ARGV[0], v_key, v_field, c.origin, c.seq, c.hlc_wall, c.hlc_counter, c.author, c.device, false, '{}'::jsonb, NULL, jsonb_build_object('text', v_old)
        FROM sync_stamps c WHERE c.workspace_id = v_ws AND c.table_name = TG_ARGV[0] AND c.row_key = v_key AND c.field = '*' AND NOT c.deleted
      ON CONFLICT (workspace_id, table_name, row_key, field) DO NOTHING;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER block_nodes_keep_emptied_id AFTER UPDATE OF task_id, detached_note_id ON block_nodes FOR EACH ROW
  WHEN ((OLD.task_id IS NOT NULL AND NEW.task_id IS NULL) OR (OLD.detached_note_id IS NOT NULL AND NEW.detached_note_id IS NULL))
  EXECUTE FUNCTION sync_keep_emptied_id('block_nodes', 'id', 'workspace_id', 'note_id', 'task:task_id:task_id:content_nodes:id,detached:detached_note_id:detached_note_id+detached_tags:content_nodes:id');
CREATE OR REPLACE TRIGGER content_nodes_keep_emptied_id AFTER UPDATE OF parent_id ON content_nodes FOR EACH ROW
  WHEN (OLD.parent_id IS NOT NULL AND NEW.parent_id IS NULL)
  EXECUTE FUNCTION sync_keep_emptied_id('content_nodes', 'id', 'workspace_id', '', 'parent:parent_id:parent_id:content_nodes:id');
CREATE OR REPLACE TRIGGER spaces_keep_emptied_id AFTER UPDATE OF owner_actor_id ON spaces FOR EACH ROW
  WHEN (OLD.owner_actor_id IS NOT NULL AND NEW.owner_actor_id IS NULL)
  EXECUTE FUNCTION sync_keep_emptied_id('spaces', 'id', 'workspace_id', '', 'owner:owner_actor_id:owner_actor_id:actors:id');
CREATE OR REPLACE TRIGGER rss_subscriptions_keep_emptied_id AFTER UPDATE OF auto_tag_id, default_parent_id ON rss_subscriptions FOR EACH ROW
  WHEN ((OLD.auto_tag_id IS NOT NULL AND NEW.auto_tag_id IS NULL) OR (OLD.default_parent_id IS NOT NULL AND NEW.default_parent_id IS NULL))
  EXECUTE FUNCTION sync_keep_emptied_id('rss_subscriptions', 'id', 'workspace_id', '', 'auto_tag:auto_tag_id:auto_tag_id:content_nodes:id,default_parent:default_parent_id:default_parent_id:content_nodes:id');
CREATE OR REPLACE FUNCTION sync_stamps_kept_value_cleared() RETURNS trigger AS $$
BEGIN
  IF NOT sync_import_active(NEW.workspace_id) THEN NEW.kept_value := NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER sync_stamps_kept_value_cleared BEFORE UPDATE ON sync_stamps FOR EACH ROW
  WHEN (OLD.kept_value IS NOT NULL AND (OLD.origin, OLD.seq) IS DISTINCT FROM (NEW.origin, NEW.seq))
  EXECUTE FUNCTION sync_stamps_kept_value_cleared();
CREATE OR REPLACE FUNCTION sync_stamp_row_deleted(p_ws uuid, p_table text, p_key text) RETURNS void AS $$
DECLARE v_seen jsonb;
BEGIN
  -- sync_stamp_trigger's DELETE branch (migration 206), for a table whose delete is a statement trigger: the same steps in the same order, so a merge (which writes no
  -- stamp, sync_stamp_put_over) clears what it cleared before
  v_seen := sync_row_seen(p_ws, p_table, p_key);
  DELETE FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field <> '*';
  DELETE FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field <> '*';
  PERFORM sync_stamp_put_over(p_ws, p_table, p_key, '*', true, sync_stamp_current(p_ws), NULL, false, v_seen);
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION sync_rows_go_with_note() RETURNS trigger AS $$
DECLARE r record; v_keys text[]; v_notes uuid[]; v_ws uuid[]; v_gone text[]; v_ws1 uuid; v_cols jsonb;
BEGIN
  -- the units' columns, as the stamp trigger names them ('note=note_id,anchor=anchor_id,…')
  SELECT jsonb_object_agg(split_part(p, '=', 1), split_part(p, '=', 2)) INTO v_cols FROM unnest(string_to_array(TG_ARGV[0], ',')) AS p;
  IF TG_TABLE_NAME = 'block_anchors' THEN SELECT array_agg(o.anchor_id), array_agg(o.note_id), array_agg(o.workspace_id) INTO v_keys, v_notes, v_ws FROM old_rows o;
  ELSIF TG_TABLE_NAME = 'block_nodes' THEN SELECT array_agg(o.id::text), array_agg(o.note_id), array_agg(o.workspace_id) INTO v_keys, v_notes, v_ws FROM old_rows o;
  ELSE SELECT array_agg(o.note_id::text), array_agg(o.note_id), array_agg(o.workspace_id) INTO v_keys, v_notes, v_ws FROM old_rows o;
  END IF;
  IF v_keys IS NULL THEN RETURN NULL; END IF;
  -- deleted while the note is here: a tombstone each (a save retires a few anchors; a merge applies a received tombstone)
  FOR r IN SELECT n.workspace_id AS w, x.k FROM unnest(v_keys, v_notes) AS x(k, n) JOIN content_nodes n ON n.id = x.n LOOP
    PERFORM sync_stamp_row_deleted(r.w, TG_TABLE_NAME, r.k);
  END LOOP;
  -- gone with their note: those made in it leave nothing; those moved into it keep their stamps (above)
  FOR v_ws1 IN SELECT DISTINCT w FROM unnest(v_ws) AS w LOOP
    SELECT array_agg(x.k) INTO v_gone FROM unnest(v_keys, v_notes, v_ws) AS x(k, n, w)
     WHERE x.w = v_ws1 AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.id = x.n)
       AND NOT EXISTS (SELECT 1 FROM sync_stamps s WHERE s.workspace_id = v_ws1 AND s.table_name = TG_TABLE_NAME AND s.row_key = x.k AND s.field = 'note');
    IF v_gone IS NOT NULL THEN
      DELETE FROM sync_stamps s USING unnest(v_gone) AS g(k) WHERE s.workspace_id = v_ws1 AND s.table_name = TG_TABLE_NAME AND s.row_key = g.k;
      DELETE FROM sync_stamp_heads s USING unnest(v_gone) AS g(k) WHERE s.workspace_id = v_ws1 AND s.table_name = TG_TABLE_NAME AND s.row_key = g.k;
    END IF;
  END LOOP;
  -- those moved into it keep each stamp's value: the row was the one place that held the winners' (a transition table's row is an anonymous record: made the table's
  -- row type again for sync_logged_value)
  IF TG_TABLE_NAME = 'block_anchors' THEN
    UPDATE sync_stamps s SET kept_value = jsonb_build_object('text', sync_logged_value(jsonb_populate_record(NULL::block_anchors, to_jsonb(o)), s.field, v_cols ->> s.field))
      FROM old_rows o WHERE s.workspace_id = o.workspace_id AND s.table_name = TG_TABLE_NAME AND s.row_key = o.anchor_id AND s.field <> '*' AND v_cols ? s.field
       AND s.kept_value IS NULL AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.id = o.note_id);
  ELSIF TG_TABLE_NAME = 'block_nodes' THEN
    UPDATE sync_stamps s SET kept_value = jsonb_build_object('text', sync_logged_value(jsonb_populate_record(NULL::block_nodes, to_jsonb(o)), s.field, v_cols ->> s.field))
      FROM old_rows o WHERE s.workspace_id = o.workspace_id AND s.table_name = TG_TABLE_NAME AND s.row_key = o.id::text AND s.field <> '*' AND v_cols ? s.field
       AND s.kept_value IS NULL AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.id = o.note_id);
  END IF; -- an anchors unit is keyed by its note: it never moves into another, so nothing of it is kept
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- A key made again (an anchor id adopted into a note after its row went with another note, keeping its stamps): the fields follow the new creation, as for a key never
-- made before. On the node that writes; a merge writes the units it decided itself.
CREATE OR REPLACE FUNCTION sync_rows_made_afresh() RETURNS trigger AS $$
DECLARE v_keys text[]; v_ws uuid[];
BEGIN
  IF TG_TABLE_NAME = 'block_anchors' THEN SELECT array_agg(n.anchor_id), array_agg(n.workspace_id) INTO v_keys, v_ws FROM new_rows n WHERE NOT sync_import_active(n.workspace_id);
  ELSIF TG_TABLE_NAME = 'block_nodes' THEN SELECT array_agg(n.id::text), array_agg(n.workspace_id) INTO v_keys, v_ws FROM new_rows n WHERE NOT sync_import_active(n.workspace_id);
  ELSE SELECT array_agg(n.note_id::text), array_agg(n.workspace_id) INTO v_keys, v_ws FROM new_rows n WHERE NOT sync_import_active(n.workspace_id);
  END IF;
  IF v_keys IS NULL THEN RETURN NULL; END IF;
  -- the new creation says which of the key's old field writes it was made over (`meta.seen`, what a creation over a delete says: store.ts droppedBySeen), so every
  -- node drops the same ones, not only this one (review of PR #1853, round 9, point 5 c: the other node kept them as heads beside the new values)
  -- merged, origin by origin, with what the creation already said it was made over (a delete's `seen` it carries: migration 206), never in place of it
  UPDATE sync_stamps s SET meta = COALESCE(s.meta, '{}'::jsonb) || jsonb_build_object('seen', (
           SELECT jsonb_object_agg(z.origin, z.m) FROM (SELECT y.origin, max(y.seq) AS m FROM (
             SELECT e.key AS origin, e.value::bigint AS seq FROM jsonb_each_text(COALESCE(s.meta -> 'seen', '{}'::jsonb)) e
             UNION ALL SELECT e.key, e.value::bigint FROM jsonb_each_text(o.seen) e) y GROUP BY y.origin) z))
    FROM (SELECT u.w, u.k, jsonb_object_agg(u.origin, u.m) AS seen FROM (
            SELECT x.w, x.k, t.origin, max(t.seq) AS m FROM unnest(v_ws, v_keys) AS x(w, k)
              JOIN (SELECT workspace_id, row_key, origin, seq FROM sync_stamps WHERE table_name = TG_TABLE_NAME AND field <> '*' AND origin <> 'genesis'
                    UNION ALL SELECT workspace_id, row_key, origin, seq FROM sync_stamp_heads WHERE table_name = TG_TABLE_NAME AND field <> '*' AND origin <> 'genesis') t
                ON t.workspace_id = x.w AND t.row_key = x.k
             GROUP BY x.w, x.k, t.origin) u GROUP BY u.w, u.k) o
   WHERE s.workspace_id = o.w AND s.table_name = TG_TABLE_NAME AND s.row_key = o.k AND s.field = '*' AND NOT s.deleted;
  DELETE FROM sync_stamps s USING unnest(v_ws, v_keys) AS x(w, k) WHERE s.workspace_id = x.w AND s.table_name = TG_TABLE_NAME AND s.row_key = x.k AND s.field <> '*';
  DELETE FROM sync_stamp_heads s USING unnest(v_ws, v_keys) AS x(w, k) WHERE s.workspace_id = x.w AND s.table_name = TG_TABLE_NAME AND s.row_key = x.k AND s.field <> '*';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- A row's workspace is its note's (review of PR #1853, round 6, point 5): the stamp triggers file a row under its note's workspace and every read takes the row's own
-- column, so the two must not differ. Nothing in the schema binds them (content_nodes has no unique (workspace_id, id) to point a foreign key at), so the writes do:
-- every row made or changed, on any node and from a merge too (OD215, which a merge refuses as bundle_malformed).
CREATE OR REPLACE FUNCTION sync_rows_in_their_notes_workspace() RETURNS trigger AS $$
DECLARE bad text;
BEGIN
  SELECT x.note_id::text INTO bad FROM (SELECT DISTINCT n.note_id, n.workspace_id FROM new_rows n) x JOIN content_nodes c ON c.id = x.note_id WHERE c.workspace_id <> x.workspace_id LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'a row of % is in another workspace than its note %', TG_TABLE_NAME, bad USING ERRCODE = 'OD215', HINT = 'row_not_in_its_notes_workspace', DETAIL = bad;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- ...and a note never changes workspace (review of PR #1853, round 7, point 7): no writer of this repository does it; this is the guard, so the rows' check above cannot
-- be undone from the note's side.
CREATE OR REPLACE FUNCTION content_nodes_workspace_is_fixed() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a note does not move to another workspace (note %)', OLD.id USING ERRCODE = 'OD215', HINT = 'note_workspace_is_fixed', DETAIL = OLD.id::text;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER content_nodes_workspace_is_fixed BEFORE UPDATE OF workspace_id ON content_nodes FOR EACH ROW
  WHEN (OLD.workspace_id IS DISTINCT FROM NEW.workspace_id) EXECUTE FUNCTION content_nodes_workspace_is_fixed();
CREATE OR REPLACE TRIGGER block_anchors_in_notes_workspace_insert AFTER INSERT ON block_anchors REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_in_their_notes_workspace();
CREATE OR REPLACE TRIGGER block_nodes_in_notes_workspace_insert AFTER INSERT ON block_nodes REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_in_their_notes_workspace();
CREATE OR REPLACE TRIGGER note_anchor_places_in_notes_workspace_insert AFTER INSERT ON note_anchor_places REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_in_their_notes_workspace();
-- an UPDATE trigger with a transition table cannot name columns (UPDATE OF): the check looks each note of the statement up once (a save: one note)
CREATE OR REPLACE TRIGGER block_anchors_in_notes_workspace_update AFTER UPDATE ON block_anchors REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_in_their_notes_workspace();
CREATE OR REPLACE TRIGGER block_nodes_in_notes_workspace_update AFTER UPDATE ON block_nodes REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_in_their_notes_workspace();
CREATE OR REPLACE TRIGGER note_anchor_places_in_notes_workspace_update AFTER UPDATE ON note_anchor_places REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_in_their_notes_workspace();
DROP TRIGGER IF EXISTS block_anchors_sync_stamp_delete ON block_anchors; -- the row triggers of an earlier draft of this migration (round 5)
DROP TRIGGER IF EXISTS block_nodes_sync_stamp_delete ON block_nodes;
DROP TRIGGER IF EXISTS note_anchor_places_sync_stamp_delete ON note_anchor_places;
CREATE OR REPLACE TRIGGER block_anchors_go_with_note AFTER DELETE ON block_anchors REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_go_with_note('note=note_id');
CREATE OR REPLACE TRIGGER block_nodes_go_with_note AFTER DELETE ON block_nodes REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_go_with_note('note=note_id,anchor=anchor_id,ref=block_ref,task=task_id,detached=detached_note_id+detached_tags');
CREATE OR REPLACE TRIGGER note_anchor_places_go_with_note AFTER DELETE ON note_anchor_places REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_go_with_note('places=places');
CREATE OR REPLACE TRIGGER block_anchors_made_afresh AFTER INSERT ON block_anchors REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_made_afresh();
CREATE OR REPLACE TRIGGER block_nodes_made_afresh AFTER INSERT ON block_nodes REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_made_afresh();
CREATE OR REPLACE TRIGGER note_anchor_places_made_afresh AFTER INSERT ON note_anchor_places REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sync_rows_made_afresh();

-- 2b. a restored server's renewal (migration 213) holds its old id up to its last number for every label a change bundle carries. The list is its own function now,
-- sync_carried_labels(): a migration that adds a label redefines only that one (review of PR #1853, round 2), and the renewal reads it. sync_renew_node_id() is 213's
-- word for word but for that one read; it still takes the new id only through sync_take_node_id() (guards/restoreRenewsNodeId.guard.test.ts).
CREATE OR REPLACE FUNCTION sync_carried_labels() RETURNS text[] AS $$
  SELECT ARRAY['workspaces', 'spaces', 'space_members', 'content_nodes', 'node_attributes', 'node_tags', 'node_edges', 'note_pointers', 'node_positions', 'note_anchor_places', 'block_anchors', 'block_nodes', 'block_node_tags', 'function_refs', 'rss_subscriptions', 'rss_mutes', 'external_calendars', 'actor_module_settings', 'content_nodes.tag_schema', 'spaces.capabilities', 'function_refs.config', 'workspaces.modules_off', 'workspaces.modules_confirmed']::text[];
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION sync_renew_node_id() RETURNS TABLE (old_node_id text, new_node_id text, workspaces bigint, origins_added bigint) AS $$
DECLARE v_ws uuid; v_old text; v_new text; v_clocks bigint; v_origins bigint;
BEGIN
  -- every writer takes a workspace's event-append lock, then its clock row (spine/stamps.ts); a renewal takes all of them, in one order
  FOR v_ws IN SELECT c.workspace_id FROM sync_clock c ORDER BY c.workspace_id LOOP
    PERFORM 1 FROM sync_lock_clock(v_ws);
  END LOOP;
  SELECT t.before_id, t.after_id INTO v_old, v_new FROM sync_take_node_id() t;
  -- the old id's own writes, as an origin held up to the last number it gave (before the clock is renumbered below)
  IF v_old IS NOT NULL THEN
    -- held up to that number for every label a change bundle carries: the same shape as spine/stampedBundle.ts haveOfAll, from the one list
    -- spine/stampedMerge/dbUnits.ts CARRIED_LABELS, as sync_carried_labels() names them (restoreRenewsNodeId.guard.test.ts keeps the two equal)
    INSERT INTO sync_origins (workspace_id, origin, vouched_by, have)
    SELECT c.workspace_id, v_old, 'self-restore', (SELECT jsonb_object_agg(l, c.next_seq - 1) FROM unnest(sync_carried_labels()) AS l)
      FROM sync_clock c WHERE c.next_seq > 1;
    GET DIAGNOSTICS v_origins = ROW_COUNT;
  ELSE
    v_origins := 0;
  END IF;
  WITH top AS (
    SELECT s.workspace_id, s.hlc_wall, s.hlc_counter FROM sync_stamps s
    UNION ALL SELECT h.workspace_id, h.hlc_wall, h.hlc_counter FROM sync_stamp_heads h
  ), best AS (
    SELECT DISTINCT ON (workspace_id) workspace_id, hlc_wall, hlc_counter FROM top ORDER BY workspace_id, hlc_wall DESC, hlc_counter DESC
  )
  UPDATE sync_clock c SET next_seq = 1,
         hlc_wall = CASE WHEN b.hlc_wall IS NOT NULL AND (b.hlc_wall, b.hlc_counter) > (c.hlc_wall, c.hlc_counter) THEN b.hlc_wall ELSE c.hlc_wall END,
         hlc_counter = CASE WHEN b.hlc_wall IS NOT NULL AND (b.hlc_wall, b.hlc_counter) > (c.hlc_wall, c.hlc_counter) THEN b.hlc_counter ELSE c.hlc_counter END
    FROM sync_clock c2 LEFT JOIN best b ON b.workspace_id = c2.workspace_id
   WHERE c2.workspace_id = c.workspace_id;
  GET DIAGNOSTICS v_clocks = ROW_COUNT;
  RETURN QUERY SELECT v_old, v_new, v_clocks, v_origins;
END;
$$ LANGUAGE plpgsql;

-- 3. the rows that exist today: genesis stamps, as for every other stamped table (202's pass finds the new INSERT triggers in the catalog)
SELECT * FROM sync_genesis_pass();
