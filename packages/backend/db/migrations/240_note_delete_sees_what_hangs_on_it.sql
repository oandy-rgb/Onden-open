-- 240: a note made again under its id (issue #2019; review of PR #2024, round 1, points 2, 3 and 5; round 2, point 1; round 3, point 1). Only replaces functions and adds one
-- (sync_progress_seen): no table, index, trigger or row is added, changed or deleted.
--
-- 1. WHAT A NOTE'S PERMANENT DELETE HAD SEEN covers every row the delete takes with the note. The tombstone's `meta.seen` (sync_row_seen, migration 205) was the
--    highest sequence number of each origin over the NOTE's own units. A row that hangs on the note (a card, a tag, a module setting, a paragraph row, an anchor,
--    the anchors unit, a review card on a paragraph) is written in transactions of its own (the anchor recovery is a system job of its own, a module setting
--    is set without touching its tag note), so its writes were not in that number: a node that held the note alive, and took its new creation (which carries
--    the tombstone's `seen`), judged rows the deleter HAD seen as rows it had not, kept them, and sent them back to life on every node. Now, for a note, `seen`
--    is also this node's PROGRESS of each origin when it deletes: its own writes before this transaction, and of every other origin the least over every carried
--    label of what it holds without a gap (sync_origins.have: a write at or below it was taken here, as test/helpers/stampedBundleWorld.ts `leastAt` reads it). A
--    write the deleter had taken is a write it had seen, whichever unit it was of; a write above that is judged as before (by the note's own units). `heads` is
--    unchanged (the note's own units). Every other table's delete is unchanged. The labels are migration 215's `sync_carried_labels()`, the list of
--    src/spine/stampedMerge/dbUnits.ts CARRIED_LABELS (guards/restoreRenewsNodeId.guard.test.ts compares the two; a label added there redefines it).
--    Where it is read (one rule, README of spine/stampedMerge 「筆記以同一個 id 重建時」): store.ts droppedBySeen (the note's own field writes the deleter had seen are
--    not heads beside the new creation: unchanged in kind, it now also knows the writes of the note it took in transactions of their own), dbRows.ts
--    goneWithTheDelete (a row hanging on the note all of whose writes the deleter had seen goes with the delete on the node that held the note alive, on every
--    table), rules/trash.ts (who is told of a late edit: never what is kept).
-- 2. A SYSTEM WRITE IS REFUSED ONLY BESIDE A HEAD WHOSE CONTENT DIFFERS (point 5). Migration 206 refused a system or AI write to a unit that had ANY other head; the
--    merge core counts only the heads whose content differs from the winner (spine/stampedMerge/unit.ts conflictsOf, writeUnit(..., "system")): two heads of a
--    row's `*` that both say "the row is here" (a holder's re-send beside the creation, two nodes that made the same derived id) are no conflict, and refusing
--    there kept the AI and the system jobs from creating or removing every row of a note made again. Now a head counts when it is a tombstone against a winner
--    that is not, or the other way round, or, for a field whose old value the write knows, when it holds another value. A head without its value (`valueless`)
--    is never one (conflictsOf too), and neither is a holder's re-send (`meta.resent`, unit.ts isResent; round 2, point 1): it is a copy of a creation that says
--    nothing of its own, so beside a later delete of the row it is no other value either (else every system write to that row was refused until a person wrote
--    it). Where the write does not know the field's old value, every other head counts, as before: sync_stamp_put_row now reads the old value for a system
--    write to a unit that has other heads (one look-up, only then), so a column of a row always knows it.
-- 3. NOTHING FOLLOWS A RE-SEND (round 3, point 1). A field without a stamp of its own follows its row's creation, and a person's write to it has seen every head
--    of that creation: sync_stamp_put_over (206) and sync_stamp_put_beside (218, a note's place written beside its other heads) put each `*` head into the
--    write's `saw`, a holder's re-send too. The merge core does not follow a re-send (dbUnits.ts readUnit, rows.ts fieldsOf: unit.ts isResent), so its `saw` for
--    the same write had one sequence number less. Both now skip a `*` head with `meta.resent`: one rule on both sides (stampSaw.integration.test.ts compares the
--    database's `saw` with the core's).
--
-- Single server: (1) changes only the `meta` of a note's tombstone, which nothing local reads (droppedBySeen and the late-edit notices run only on a merge, and a
-- single server makes the same id again over its own tombstone, whose `seen` covers its own writes anyway). (2) and (3) change nothing until a merge has written a
-- head.
-- Data shape 9 (spine/syncDataShape.ts): `meta.seen` of a note's delete means more than it did.
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: run migration 205's sync_row_seen, 206's sync_stamp_put_over, 205's
-- sync_stamp_put_row and 218's sync_stamp_put_beside again and drop sync_progress_seen(uuid, jsonb), the one function this adds (keep sync_carried_labels(): it is migration 215's, and
-- sync_renew_node_id() reads it); tombstones written meanwhile keep their wider `seen` (true of what they had seen). (This header never spells the statement
-- that defines a function: test/helpers/rerunMigration.ts finds the functions by that text.)
-- drill: no allowance needed. This migration writes no row of any table.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on): only functions change; no stamp or head is
-- rewritten. How many units hold other heads today (the system writes (2) lets through are among them):
--
--   SELECT count(*) AS units_with_other_heads FROM (SELECT DISTINCT workspace_id, table_name, row_key, field FROM sync_stamp_heads) x;
--   -- production: 0 (no merge has run there)

-- What this node had seen of every origin when it writes `s` (1): its own writes before this transaction, and of each other origin the least over every carried
-- label of what it holds without a gap (a label it holds nothing of counts 0). Origin -> number, only the origins it has seen something of.
CREATE OR REPLACE FUNCTION sync_progress_seen(p_ws uuid, s jsonb) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_object_agg(origin, n), '{}'::jsonb) FROM (
    SELECT s->>'origin' AS origin, (s->>'seq')::bigint - 1 AS n WHERE s IS NOT NULL AND (s->>'seq')::bigint > 1
    UNION ALL
    SELECT o.origin, (SELECT min(COALESCE((o.have ->> l)::bigint, 0)) FROM unnest(sync_carried_labels()) l)
      FROM sync_origins o WHERE o.workspace_id = p_ws AND o.origin IS DISTINCT FROM s->>'origin' AND o.origin <> 'genesis') x
   WHERE n > 0;
$$ LANGUAGE sql STABLE;

-- Migration 205's sync_row_seen, with (1): for a note, `seen` is widened by this node's progress (the stamp of this transaction is the one the stamp trigger
-- took a moment before: sync_stamp_current set it).
CREATE OR REPLACE FUNCTION sync_row_seen(p_ws uuid, p_table text, p_key text) RETURNS jsonb AS $$
  WITH u AS (
    SELECT field, origin, seq FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND origin <> 'genesis'
    UNION SELECT field, origin, seq FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND origin <> 'genesis'),
  progress AS (
    SELECT key AS origin, value::text::bigint AS seq FROM jsonb_each(CASE WHEN p_table = 'content_nodes'
      THEN sync_progress_seen(p_ws, NULLIF(current_setting(sync_stamp_setting(p_ws), true), '')::jsonb) ELSE '{}'::jsonb END)),
  seen AS (SELECT origin, seq FROM u UNION ALL SELECT origin, seq FROM progress)
  SELECT jsonb_build_object(
    'seen', COALESCE((SELECT jsonb_object_agg(origin, m) FROM (SELECT origin, max(seq) AS m FROM seen GROUP BY origin) x), '{}'::jsonb),
    'heads', COALESCE((SELECT jsonb_object_agg(field, hs) FROM (SELECT field, jsonb_agg(jsonb_build_array(origin, seq) ORDER BY origin, seq) AS hs FROM u GROUP BY field) y), '{}'::jsonb));
$$ LANGUAGE sql STABLE;

-- Migration 205's sync_stamp_put_row, with (2): a system write to a unit that has other heads reads the old value, so the refusal can tell a head that says the
-- same from one that does not.
CREATE OR REPLACE FUNCTION sync_stamp_put_row(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb, p_old_row anyelement, p_column text) RETURNS void AS $$
DECLARE
  v_old text;
  v_known boolean := false;
BEGIN
  IF (p_table = 'content_nodes' AND p_field = 'parent') OR sync_unit_at_genesis(p_ws, p_table, p_key, p_field)
     OR (COALESCE(s->>'system', '') = 'true'
         AND EXISTS (SELECT 1 FROM sync_stamp_heads x WHERE x.workspace_id = p_ws AND x.table_name = p_table AND x.row_key = p_key AND x.field = p_field)) THEN
    v_old := sync_logged_value(p_old_row, p_field, p_column); v_known := true;
  END IF;
  PERFORM sync_stamp_put_over(p_ws, p_table, p_key, p_field, p_deleted, s, v_old, v_known);
END;
$$ LANGUAGE plpgsql;

-- Migration 206's sync_stamp_put_over, with (2) in the refusal of a system write and (3) in the heads of the creation a field follows; everything else as it was.
CREATE OR REPLACE FUNCTION sync_stamp_put_over(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb, p_old text, p_old_known boolean, p_meta jsonb DEFAULT NULL) RETURNS void AS $$
DECLARE
  v_origin text := s->>'origin';
  v_seq bigint := (s->>'seq')::bigint;
  d record;
  h record;
  v_saw jsonb := '{}'::jsonb;
  v_meta jsonb;
  v_again boolean := false;
  v_prev_seen jsonb;
  v_win_deleted boolean := false;
  v_quiet boolean := p_field <> '*' AND COALESCE(current_setting('onden.stamp_quiet', true), '') = 'on'; -- this write is housekeeping: it does not count for `updated_at`
BEGIN
  IF sync_import_active(p_ws) THEN RETURN; END IF;
  SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field;
  IF FOUND THEN
    v_win_deleted := d.deleted;
    v_prev_seen := d.meta -> 'seen'; -- what a delete of this row had seen, carried by a creation that covers it
    IF d.origin = v_origin AND d.seq = v_seq THEN
      v_again := true; v_saw := d.saw; v_meta := d.meta; -- this transaction wrote the unit already: it has not seen itself
    ELSIF d.origin = 'genesis' THEN
      IF p_field = '*' THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash('j:{}'), 0);
      ELSIF p_old_known THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0); END IF;
    ELSE
      v_saw := sync_saw_merge(d.saw, jsonb_build_object(d.origin, d.seq));
    END IF;
  ELSIF p_field <> '*' THEN
    -- no stamp of its own: the field was written together with its row and follows its creation
    SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = '*';
    IF FOUND AND NOT (d.origin = v_origin AND d.seq = v_seq) THEN
      IF d.origin = 'genesis' THEN
        IF p_old_known THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0); END IF;
      ELSE
        -- what the creation gives a field has no saw of its own (the creation's saw speaks about the creation unit, README "跟著 `*` 的欄位"), only its stamp:
        -- the same state sawOf of the core is given (src/test/stampSaw.integration.test.ts compares the two)
        v_saw := jsonb_build_object(d.origin, d.seq);
      END IF;
    END IF;
    -- the row's creation can have other heads (two nodes made the same derived id): the field follows each of them, so a person's write has seen all of them.
    -- They are the creation's heads, not this field's: they stay. A holder's re-send (meta.resent) is no creation: nothing follows it, so it is not seen here
    -- (dbUnits.ts readUnit and rows.ts fieldsOf skip isResent the same way; stampSaw.integration.test.ts compares the two).
    FOR h IN SELECT * FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = '*' AND origin <> 'genesis'
                AND COALESCE(meta->>'resent', '') <> 'true' LOOP
      IF NOT (h.origin = v_origin AND h.seq = v_seq) THEN v_saw := sync_saw_merge(v_saw, jsonb_build_object(h.origin, h.seq)); END IF;
    END LOOP;
  END IF;
  -- a system job does not resolve a conflict nobody has looked at: its write has seen only the head the unit shows, and a `saw` cannot say that. A conflict is a
  -- head whose content differs from the winner's (unit.ts conflictsOf): a tombstone against a value, or another value; a head without its value is none. Where the
  -- write does not know the field's old value, every head with a value counts. A holder's re-send (meta.resent) is a copy of a creation that says nothing of its own:
  -- never one (unit.ts conflictsOf skips isResent the same way).
  IF COALESCE(s->>'system', '') = 'true' AND NOT v_again
     AND EXISTS (SELECT 1 FROM sync_stamp_heads x WHERE x.workspace_id = p_ws AND x.table_name = p_table AND x.row_key = p_key AND x.field = p_field AND NOT x.valueless
                   AND COALESCE(x.meta->>'resent', '') <> 'true'
                   AND (x.deleted IS DISTINCT FROM v_win_deleted
                        OR (p_field <> '*' AND NOT x.deleted AND (NOT p_old_known OR x.value IS DISTINCT FROM p_old)))) THEN
    RAISE EXCEPTION 'sync_unit_in_conflict' USING ERRCODE = 'ON001';
  END IF;
  -- a write by this node has seen every head the unit had: they are replaced
  FOR h IN DELETE FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field RETURNING * LOOP
    IF h.origin = 'genesis' THEN v_saw := sync_saw_merge(v_saw, jsonb_build_object('genesis:' || h.content_hash, 0));
    ELSIF NOT (h.origin = v_origin AND h.seq = v_seq) THEN v_saw := sync_saw_merge(v_saw, sync_saw_merge(h.saw, jsonb_build_object(h.origin, h.seq)));
    END IF;
  END LOOP;
  IF p_meta IS NOT NULL THEN v_meta := p_meta;
  ELSIF NOT v_again AND p_table = 'content_nodes' AND p_field = 'parent' AND p_old_known THEN v_meta := jsonb_build_object('from', p_old);
  ELSIF NOT v_again AND p_field = '*' AND NOT p_deleted AND v_prev_seen IS NOT NULL THEN v_meta := jsonb_build_object('seen', v_prev_seen); END IF;
  IF v_quiet THEN v_meta := COALESCE(v_meta, '{}'::jsonb) || '{"quiet": true}'::jsonb;
  ELSIF v_meta ? 'quiet' THEN v_meta := NULLIF(v_meta - 'quiet', '{}'::jsonb); END IF;
  INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta)
  VALUES (p_ws, p_table, p_key, p_field, v_origin, v_seq, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid, p_deleted, v_saw, v_meta)
  ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
    origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
    author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted, saw = EXCLUDED.saw, meta = EXCLUDED.meta;
  IF p_table = 'content_nodes' AND NOT p_deleted AND NOT v_quiet AND p_field NOT IN ('*', 'sort') THEN PERFORM sync_touch_updated_at(p_ws, p_key); END IF;
END;
$$ LANGUAGE plpgsql;

-- Migration 218's sync_stamp_put_beside, with (3): a unit that follows its row's creation has seen every head of
-- that creation except a holder's re-send (meta.resent): nothing follows a re-send (as sync_stamp_put_over above, dbUnits.ts readUnit, rows.ts fieldsOf).
-- Everything else as it was.
CREATE OR REPLACE FUNCTION sync_stamp_put_beside(p_ws uuid, p_key text, p_field text, s jsonb, p_old text) RETURNS void AS $$
DECLARE d record; h record; v_saw jsonb := '{}'::jsonb; v_meta jsonb;
BEGIN
  IF sync_import_active(p_ws) THEN RETURN; END IF;
  SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = 'content_nodes' AND row_key = p_key AND field = p_field;
  IF FOUND THEN
    IF d.origin = s->>'origin' AND d.seq = (s->>'seq')::bigint THEN RETURN; END IF; -- this transaction wrote the unit already
    IF d.origin = 'genesis' THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0);
    ELSE v_saw := sync_saw_merge(d.saw, jsonb_build_object(d.origin, d.seq)); END IF;
  ELSE
    -- the field follows its row's creation (README "跟著 `*` 的欄位"), as sync_stamp_put_over reads it, with every head of that creation but a re-send
    SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = 'content_nodes' AND row_key = p_key AND field = '*';
    IF FOUND AND d.origin = 'genesis' THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0);
    ELSIF FOUND AND NOT (d.origin = s->>'origin' AND d.seq = (s->>'seq')::bigint) THEN v_saw := jsonb_build_object(d.origin, d.seq); END IF;
    FOR h IN SELECT * FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = 'content_nodes' AND row_key = p_key AND field = '*' AND origin <> 'genesis'
                AND COALESCE(meta->>'resent', '') <> 'true' LOOP
      IF NOT (h.origin = s->>'origin' AND h.seq = (s->>'seq')::bigint) THEN v_saw := sync_saw_merge(v_saw, jsonb_build_object(h.origin, h.seq)); END IF;
    END LOOP;
  END IF;
  -- the heads this `saw` covers are gone on every node that takes the stamp (covers: a genesis head by its name, any other by seq <= saw[origin]): gone here too
  DELETE FROM sync_stamp_heads x WHERE x.workspace_id = p_ws AND x.table_name = 'content_nodes' AND x.row_key = p_key AND x.field = p_field
     AND CASE WHEN x.origin = 'genesis' THEN v_saw ? ('genesis:' || x.content_hash) ELSE x.seq <= COALESCE((v_saw->>x.origin)::bigint, -1) END;
  IF p_field = 'parent' THEN v_meta := jsonb_build_object('from', p_old); END IF;
  INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta)
  VALUES (p_ws, 'content_nodes', p_key, p_field, s->>'origin', (s->>'seq')::bigint, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid, false, v_saw, v_meta)
  ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
    origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
    author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted, saw = EXCLUDED.saw, meta = EXCLUDED.meta;
END;
$$ LANGUAGE plpgsql;
