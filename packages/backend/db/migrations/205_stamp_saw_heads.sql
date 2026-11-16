-- 205: a write stamp also says what its writer had seen of the unit ("saw"), a unit can hold more than one head, and the
-- tree of a note gets the index its deferred space check was missing (stamped-sync batch 2a; docs/architecture/proposals/
-- causal-stamps-2026-11-12.md §3, src/spine/stampedMerge/README.md). Adds only: two columns, one table, one index, one column of the
-- join record and functions. No existing row is read for a purpose other than the preview below, changed or deleted.
--
-- WHAT THIS ADDS
--   sync_stamps.saw    jsonb NOT NULL DEFAULT '{}': for each origin, the highest sequence number of that origin's writes TO THIS UNIT that the writer
--                      had seen when it wrote (its own earlier ones included), or, for a write made on top of a genesis value, the name of that value
--                      ('genesis:' + sha-256 of the value, src/spine/stampedMerge/unit.ts genesisName). Never across units.
--   sync_stamps.meta   jsonb, NULL: what the writer knew and the receiver cannot work out. Today: the parent a note was moved away from
--                      ({"from": <old parent id or null>}), written by the trigger itself.
--   sync_stamp_heads   the OTHER heads of a unit: writes nobody who wrote later had seen, that lose to the one sync_stamps shows (smaller stamp).
--                      One row per head: its stamp, saw, meta, deleted flag and its VALUE (the table's column holds only the winner's).
--                      Empty on every database until a merge from another node stores one (nothing here does yet).
--   sync_clock.merge_batches  how many merge write-backs (the second reason the stamp triggers stand aside) a workspace has had: the countable exception, like writes_without_mutate.
--   content_nodes_parent_idx  content_nodes (parent_id) WHERE parent_id IS NOT NULL: the deferred check content_nodes_check_space (093) looks for the
--                      children of every row it checks (WHERE c.parent_id = ...); no index led with parent_id, so each check scanned the table.
--   sync_stamp_put_over / _row, sync_saw_merge, sync_genesis_name, sync_content_text, sync_unit_at_genesis   the functions that work saw out.
--
-- WHAT THIS CHANGES IN BEHAVIOUR (redefinitions; the same stamps are written, the new columns are filled in as well)
--   sync_stamp_put (the old six-argument entry) now calls sync_stamp_put_over, and the stamp triggers (sync_stamp_trigger, sync_stamp_attribute_trigger,
--   sync_stamp_json_diff) call sync_stamp_put_row / sync_stamp_put_over with the old value, so that a first write over a genesis value can name it.
--   Everything else in the three trigger functions is the text of migrations 194 / 199, word for word (src/test/guards/syncStampPut.guard.test.ts).
--   sync_import_active (204) accepts a second setting value, 'merge', honoured for a workspace that has a clock (it has been stamped) and is not joining; 'on' stays as it was.
--
-- HOW saw IS WORKED OUT (sync_stamp_put_over): the heads of the unit before this write = the stamp the unit shows now, or, when it has none of its own,
-- the stamp of its row's creation ('*') it followed, plus every row of sync_stamp_heads. A write by this node has seen all of them: saw = the largest sequence
-- number per origin over those heads (each head's own saw and its own stamp), a genesis head counted as its name; the other heads are removed. The same
-- transaction writing a unit twice keeps the saw of its first write (a write never claims to have seen itself).
--
-- WHAT THIS DOES NOT DO, on purpose
--   * the premise of leaving them as they are: a real (non-genesis) stamp that exists before this migration has saw = {}, which does not cover the genesis value it replaced, so it is safe only if that
--     genesis value is held by no node. On production there are a hundred-odd real stamps with ONE origin, and the only way a database joins is an empty shell plus a snapshot, which carries exactly
--     these stamps, so no node holds an older value. It would not hold for an old copy WITH data merged in directly (such a join is refused today by `shellIsEmpty`).
--   * no existing stamp is rewritten: a stamp that was there before this migration (S5's genesis stamps included) keeps saw = {} (nothing was ever exchanged,
--     every unit has one head and this node wrote it, so {} — "I saw only the genesis value" — is safe) and meta NULL. Adding a column with a constant default does not rewrite the table.
--   * nothing reads saw, meta or the heads table to decide anything yet except src/spine/stampedMerge/dbUnits.ts (the unit-level reader and writer) and the snapshot.
--   * the new index is built the ordinary way (a ShareLock on content_nodes while it builds: 18 ms for 20,000 notes in PGlite, not measured on a production server): run migrations before the new backend serves, as always.
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward; an older backend refuses a database with a migration it does not know).
-- In place: DROP INDEX content_nodes_parent_idx; re-run the sync_stamp_put, sync_import_active and trigger-function definitions of 204 / 199 / 194; the columns and
-- the table can stay (nothing of the older code reads them).
-- drill: no allowance needed. This migration writes no row of any table the drill compares (it adds columns with defaults, an empty table, an index and functions).
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; uses only tables that exist before this
-- migration; counts only, never a title, text, id or value). `rows` = how many rows the part touches, `est_bytes` = what it adds on disk (index: 33 bytes per
-- row with a parent, the size measured when every parent is a different note (20,000 notes: 32.4 bytes; with four children per parent 15.9), see the PR; columns and table: 0 until a head is stored):
--
--   SELECT 'index content_nodes (parent_id)' AS part, count(*)::bigint AS rows, (count(*) * 33)::bigint AS est_bytes FROM content_nodes WHERE parent_id IS NOT NULL
--   UNION ALL SELECT 'sync_stamps rows that get saw = {} (none is rewritten)', count(*), 0 FROM sync_stamps
--   UNION ALL SELECT 'sync_stamp_heads rows (a new table)', 0, 0
--   ;

ALTER TABLE sync_stamps ADD COLUMN IF NOT EXISTS saw jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sync_stamps ADD COLUMN IF NOT EXISTS meta jsonb;

CREATE TABLE IF NOT EXISTS sync_stamp_heads (
  workspace_id uuid NOT NULL,
  table_name text NOT NULL,
  row_key text NOT NULL,
  field text NOT NULL,
  origin text NOT NULL,
  seq bigint NOT NULL,
  -- a genesis head is named by its content (every node's genesis stamp is the same), so two different genesis values of one unit are two heads:
  content_hash text NOT NULL DEFAULT '',
  hlc_wall bigint NOT NULL,
  hlc_counter integer NOT NULL,
  author text,
  device uuid,
  deleted boolean NOT NULL DEFAULT false,
  saw jsonb NOT NULL DEFAULT '{}'::jsonb,
  meta jsonb,
  value text,
  PRIMARY KEY (workspace_id, table_name, row_key, field, origin, seq, content_hash)
);

ALTER TABLE sync_clock ADD COLUMN IF NOT EXISTS merge_batches bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS content_nodes_parent_idx ON content_nodes (parent_id) WHERE parent_id IS NOT NULL;

-- 204's switch with a second value: 'on' = a snapshot is being imported (the workspace is joining), 'merge' = changes from another node are being written back
-- into a workspace that has joined (spine/stampedMerge/dbUnits.ts). One function decides both, so there is one place that says when the triggers stand aside.
CREATE OR REPLACE FUNCTION sync_import_active(p_ws uuid) RETURNS boolean AS $$
DECLARE mode text := COALESCE(current_setting('onden.stamp_import_' || replace(p_ws::text, '-', '_'), true), '');
BEGIN
  IF mode = 'on' THEN RETURN EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = p_ws AND j.state = 'joining'); END IF;
  IF mode = 'merge' THEN
    RETURN EXISTS (SELECT 1 FROM sync_clock c WHERE c.workspace_id = p_ws)
       AND NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = p_ws AND j.state = 'joining');
  END IF;
  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

-- What a genesis value is called in a saw: the text of its content, hashed (the same text src/spine/stampedMerge/unit.ts genesisContent makes).
CREATE OR REPLACE FUNCTION sync_content_text(p_value text) RETURNS text AS $$
  SELECT CASE WHEN p_value IS NULL THEN 'j:null' ELSE 's:' || p_value END;
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION sync_genesis_hash(p_content text) RETURNS text AS $$
  SELECT encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- Largest number per origin of two saws.
CREATE OR REPLACE FUNCTION sync_saw_merge(a jsonb, b jsonb) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
    SELECT k, max(v) AS v FROM (
      SELECT key AS k, value::text::bigint AS v FROM jsonb_each(a)
      UNION ALL SELECT key, value::text::bigint FROM jsonb_each(b)) x GROUP BY k) y;
$$ LANGUAGE sql IMMUTABLE;

-- Does the unit stand on a genesis value now (its own stamp, or the creation stamp it follows, is genesis)?
CREATE OR REPLACE FUNCTION sync_unit_at_genesis(p_ws uuid, p_table text, p_key text, p_field text) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT s.origin = 'genesis' FROM sync_stamps s WHERE s.workspace_id = p_ws AND s.table_name = p_table AND s.row_key = p_key AND s.field = p_field),
    CASE WHEN p_field <> '*' THEN (SELECT s.origin = 'genesis' FROM sync_stamps s WHERE s.workspace_id = p_ws AND s.table_name = p_table AND s.row_key = p_key AND s.field = '*') END,
    false);
$$ LANGUAGE sql STABLE;

-- What a node has seen of a row when it deletes it for good: the writes behind every unit of the row, so a late edit by someone who had not seen them can be told
-- from one that had (rules/trash.ts `Deletion.seen`). {"seen": origin -> highest sequence number over all the row's units, "heads": field -> [[origin, seq], ...]}.
-- `seen` is only for deciding who is told (never for what is kept; the tombstone's own `saw` speaks about the creation unit only, so it cannot cover a field's write it
-- never saw); `heads` keeps each field's own heads, so the merged number can be worked out again. Genesis stamps are not writes of anyone and are left out. Must run BEFORE
-- the row's field stamps are removed.
CREATE OR REPLACE FUNCTION sync_row_seen(p_ws uuid, p_table text, p_key text) RETURNS jsonb AS $$
  WITH u AS (
    SELECT field, origin, seq FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND origin <> 'genesis'
    UNION SELECT field, origin, seq FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND origin <> 'genesis')
  SELECT jsonb_build_object(
    'seen', COALESCE((SELECT jsonb_object_agg(origin, m) FROM (SELECT origin, max(seq) AS m FROM u GROUP BY origin) x), '{}'::jsonb),
    'heads', COALESCE((SELECT jsonb_object_agg(field, hs) FROM (SELECT field, jsonb_agg(jsonb_build_array(origin, seq) ORDER BY origin, seq) AS hs FROM u GROUP BY field) y), '{}'::jsonb));
$$ LANGUAGE sql STABLE;

-- Write the stamp of a unit (what sync_stamp_put did) together with its saw and meta. p_old = the unit's value before this write, as text, p_old_known = it is given.
CREATE OR REPLACE FUNCTION sync_stamp_put_over(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb, p_old text, p_old_known boolean, p_meta jsonb DEFAULT NULL) RETURNS void AS $$
DECLARE
  v_origin text := s->>'origin';
  v_seq bigint := (s->>'seq')::bigint;
  d record;
  h record;
  v_saw jsonb := '{}'::jsonb;
  v_meta jsonb;
  v_again boolean := false;
BEGIN
  IF sync_import_active(p_ws) THEN RETURN; END IF;
  SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field;
  IF FOUND THEN
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
    -- They are the creation's heads, not this field's: they stay.
    FOR h IN SELECT * FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = '*' AND origin <> 'genesis' LOOP
      IF NOT (h.origin = v_origin AND h.seq = v_seq) THEN v_saw := sync_saw_merge(v_saw, jsonb_build_object(h.origin, h.seq)); END IF;
    END LOOP;
  END IF;
  -- a write by this node has seen every head the unit had: they are replaced
  FOR h IN DELETE FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field RETURNING * LOOP
    IF h.origin = 'genesis' THEN v_saw := sync_saw_merge(v_saw, jsonb_build_object('genesis:' || h.content_hash, 0));
    ELSIF NOT (h.origin = v_origin AND h.seq = v_seq) THEN v_saw := sync_saw_merge(v_saw, sync_saw_merge(h.saw, jsonb_build_object(h.origin, h.seq)));
    END IF;
  END LOOP;
  IF p_meta IS NOT NULL THEN v_meta := p_meta;
  ELSIF NOT v_again AND p_table = 'content_nodes' AND p_field = 'parent' AND p_old_known THEN v_meta := jsonb_build_object('from', p_old); END IF;
  INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta)
  VALUES (p_ws, p_table, p_key, p_field, v_origin, v_seq, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid, p_deleted, v_saw, v_meta)
  ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
    origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
    author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted, saw = EXCLUDED.saw, meta = EXCLUDED.meta;
END;
$$ LANGUAGE plpgsql;

-- The same for a field that is a column of the row being changed: the old value is read from OLD only when it is needed (the unit stands on a genesis
-- value, or it is a note's parent, whose old value goes to meta), so an edit of a note's body does not copy the old body every time.
CREATE OR REPLACE FUNCTION sync_stamp_put_row(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb, p_old_row anyelement, p_column text) RETURNS void AS $$
DECLARE
  v_old text;
  v_known boolean := false;
BEGIN
  IF (p_table = 'content_nodes' AND p_field = 'parent') OR sync_unit_at_genesis(p_ws, p_table, p_key, p_field) THEN
    v_old := sync_logged_value(p_old_row, p_field, p_column); v_known := true;
  END IF;
  PERFORM sync_stamp_put_over(p_ws, p_table, p_key, p_field, p_deleted, s, v_old, v_known);
END;
$$ LANGUAGE plpgsql;

-- The old entry stays, for a caller that does not have the old value: it records saw, without naming a genesis value it cannot see.
CREATE OR REPLACE FUNCTION sync_stamp_put(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb) RETURNS void AS $$
BEGIN
  PERFORM sync_stamp_put_over(p_ws, p_table, p_key, p_field, p_deleted, s, NULL, false);
END;
$$ LANGUAGE plpgsql;

-- the stamp trigger of migration 194 (rows with tracked fields), calling sync_stamp_put_over / sync_stamp_put_row and clearing the other heads of a purged row
CREATE OR REPLACE FUNCTION sync_stamp_trigger() RETURNS trigger AS $$
DECLARE
  tbl text := TG_ARGV[0];
  op text := TG_OP;
  mode text := COALESCE(TG_ARGV[6], '');
  ws uuid;
  key text;
  skey text;
  s jsonb;
  spec text;
  fld text;
  col text;
  kind text;
  ov text;
  nv text;
  cut int;
  filt text := COALESCE(TG_ARGV[7], '');
  keep boolean := true;
  v_seen jsonb;
BEGIN
  IF mode = 'asdelete' THEN op := 'DELETE'; ELSIF mode = 'asinsert' THEN op := 'INSERT'; END IF;
  IF op = 'DELETE' THEN
    ws := sync_workspace(OLD, TG_ARGV[2]); key := sync_key(OLD, TG_ARGV[1]);
    skey := sync_key(OLD, COALESCE(NULLIF(TG_ARGV[5], ''), TG_ARGV[1]));
  ELSE
    ws := sync_workspace(NEW, TG_ARGV[2]); key := sync_key(NEW, TG_ARGV[1]);
    skey := sync_key(NEW, COALESCE(NULLIF(TG_ARGV[5], ''), TG_ARGV[1]));
  END IF;
  IF ws IS NULL THEN RETURN NULL; END IF; -- the notes this row belongs to are already gone: their own tombstone says so
  s := sync_stamp_current(ws);
  IF filt <> '' THEN
    IF op = 'DELETE' THEN keep := sync_column(OLD, split_part(filt, '=', 1)) IS NOT DISTINCT FROM split_part(filt, '=', 2);
    ELSE keep := sync_column(NEW, split_part(filt, '=', 1)) IS NOT DISTINCT FROM split_part(filt, '=', 2); END IF;
  END IF;

  IF op = 'INSERT' THEN
    PERFORM sync_stamp_put_over(ws, tbl, key, '*', false, s, NULL, false);
  ELSIF op = 'DELETE' THEN
    v_seen := sync_row_seen(ws, tbl, key); -- before the fields' stamps go
    DELETE FROM sync_stamps WHERE workspace_id = ws AND table_name = tbl AND row_key = key AND field <> '*';
    DELETE FROM sync_stamp_heads WHERE workspace_id = ws AND table_name = tbl AND row_key = key AND field <> '*';
    PERFORM sync_stamp_put_over(ws, tbl, key, '*', true, s, NULL, false, v_seen);
  ELSE
    FOREACH spec IN ARRAY string_to_array(TG_ARGV[3], ',') LOOP
      fld := split_part(spec, '=', 1);
      col := split_part(spec, '=', 2);
      IF sync_column_changed(OLD, NEW, fld, col) THEN
        PERFORM sync_stamp_put_row(ws, tbl, key, fld, false, s, OLD, col);
      END IF;
    END LOOP;
  END IF;

  IF TG_ARGV[4] <> '' AND keep THEN
    FOREACH spec IN ARRAY string_to_array(TG_ARGV[4], ',') LOOP
      cut := least(NULLIF(position('=' IN spec), 0), NULLIF(position('~' IN spec), 0), NULLIF(position('@' IN spec), 0), NULLIF(position('^' IN spec), 0));
      fld := left(spec, cut - 1); kind := substr(spec, cut, 1); col := substr(spec, cut + 1);
      IF kind = '=' THEN
        -- A created row logs every field; a purged row logs only that it is gone (new value NULL).
        IF op = 'DELETE' THEN
          IF fld <> 'deleted' THEN CONTINUE; END IF;
          ov := sync_logged_value(OLD, fld, col); nv := NULL;
        ELSIF op = 'INSERT' THEN
          ov := NULL; nv := sync_logged_value(NEW, fld, col);
        ELSE
          IF NOT sync_column_changed(OLD, NEW, fld, col) THEN CONTINUE; END IF;
          ov := sync_logged_value(OLD, fld, col); nv := sync_logged_value(NEW, fld, col);
        END IF;
        PERFORM sync_structure_put(ws, tbl, skey, fld, ov, nv, s, false);
      ELSIF kind = '~' THEN
        IF op = 'UPDATE' THEN CONTINUE; END IF;
        IF op = 'DELETE' THEN ov := sync_column(OLD, col); nv := NULL; ELSE ov := NULL; nv := sync_column(NEW, col); END IF;
        PERFORM sync_structure_put(ws, tbl, skey, fld, ov, nv, s, false);
      ELSIF kind = '^' THEN
        IF op = 'DELETE' THEN ov := sync_column(OLD, col); nv := NULL;
        ELSIF op = 'INSERT' THEN ov := NULL; nv := sync_column(NEW, col);
        ELSE
          IF NOT sync_column_changed(OLD, NEW, fld, col) THEN CONTINUE; END IF;
          ov := sync_column(OLD, col); nv := sync_column(NEW, col);
        END IF;
        PERFORM sync_structure_put(ws, tbl, skey, fld, ov, nv, s, false);
      ELSE -- '@'
        IF op = 'DELETE' THEN ov := sync_composite(OLD, col); nv := NULL;
        ELSIF op = 'INSERT' THEN ov := NULL; nv := sync_composite(NEW, col);
        ELSE
          IF NOT sync_column_changed(OLD, NEW, fld, col) THEN CONTINUE; END IF;
          ov := sync_composite(OLD, col); nv := sync_composite(NEW, col);
        END IF;
        PERFORM sync_structure_put(ws, tbl, skey, fld, ov, nv, s, op = 'UPDATE');
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- the attribute trigger of migration 199
CREATE OR REPLACE FUNCTION sync_stamp_attribute_trigger() RETURNS trigger AS $$
DECLARE
  old_kept boolean := false;
  new_kept boolean := false;
  op text;
  ws uuid;
  rkey text;
  attr text;
  s jsonb;
  value_changed boolean := false;
  v_seen jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_kept := OLD.source IN ('ui', 'explicit', 'dispatcher'); END IF;
  IF TG_OP <> 'DELETE' THEN new_kept := NEW.source IN ('ui', 'explicit', 'dispatcher'); END IF;
  IF NOT old_kept AND NOT new_kept THEN RETURN NULL; END IF;
  -- what this change is to the stamps: a source flip counts as made / removed
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND old_kept AND NOT new_kept) THEN op := 'DELETE';
  ELSIF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NOT old_kept AND new_kept) THEN op := 'INSERT';
  ELSE op := 'UPDATE'; END IF;
  IF op = 'DELETE' THEN
    ws := OLD.workspace_id; rkey := OLD.node_id::text || '/' || OLD.key; attr := OLD.key;
  ELSE
    ws := NEW.workspace_id; rkey := NEW.node_id::text || '/' || NEW.key; attr := NEW.key;
  END IF;
  IF op = 'UPDATE' THEN
    value_changed := OLD.value IS DISTINCT FROM NEW.value;
    IF NOT (value_changed OR OLD.value_type IS DISTINCT FROM NEW.value_type OR OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable) THEN
      RETURN NULL;
    END IF;
  END IF;
  s := sync_stamp_current(ws);
  IF op = 'INSERT' THEN
    PERFORM sync_stamp_put_over(ws, 'node_attributes', rkey, '*', false, s, NULL, false);
    IF attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', NULL, NEW.value, s, false);
      PERFORM sync_stamp_json_diff(ws, 'node_attributes._canvas_sections', NEW.node_id::text, 'array', 'section:', '', '', NULL, sync_text_jsonb(NEW.value));
    END IF;
  ELSIF op = 'DELETE' THEN
    v_seen := sync_row_seen(ws, 'node_attributes', rkey); -- before the fields' stamps go
    DELETE FROM sync_stamps WHERE workspace_id = ws AND table_name = 'node_attributes' AND row_key = rkey AND field <> '*';
    DELETE FROM sync_stamp_heads WHERE workspace_id = ws AND table_name = 'node_attributes' AND row_key = rkey AND field <> '*';
    PERFORM sync_stamp_put_over(ws, 'node_attributes', rkey, '*', true, s, NULL, false, v_seen);
    IF attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NULL, s, false);
      PERFORM sync_stamp_json_diff(ws, 'node_attributes._canvas_sections', OLD.node_id::text, 'array', 'section:', '', '', sync_text_jsonb(OLD.value), NULL);
    END IF;
  ELSE
    IF value_changed THEN PERFORM sync_stamp_put_row(ws, 'node_attributes', rkey, 'value', false, s, OLD, 'value'); END IF;
    IF OLD.value_type IS DISTINCT FROM NEW.value_type THEN PERFORM sync_stamp_put_row(ws, 'node_attributes', rkey, 'type', false, s, OLD, 'value_type'); END IF;
    IF OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable THEN PERFORM sync_stamp_put_row(ws, 'node_attributes', rkey, 'inheritable', false, s, OLD, 'is_inheritable'); END IF;
    IF value_changed AND attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NEW.value, s, false);
      PERFORM sync_stamp_json_diff(ws, 'node_attributes._canvas_sections', NEW.node_id::text, 'array', 'section:', '', '', sync_text_jsonb(OLD.value), sync_text_jsonb(NEW.value));
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- the JSON-unit diff of migration 199: the old value of a unit goes to sync_stamp_put_over
CREATE OR REPLACE FUNCTION sync_stamp_json_diff(p_ws uuid, p_label text, p_row text, p_shape text, p_prefix text,
                                                p_log_table text, p_log_prefix text, p_old jsonb, p_new jsonb) RETURNS void AS $$
DECLARE
  u record;
  s jsonb;
BEGIN
  FOR u IN
    SELECT coalesce(o.k, n.k) AS k, o.v AS old_v, n.v AS new_v
      FROM sync_json_units(p_old, p_shape) o FULL JOIN sync_json_units(p_new, p_shape) n ON o.k = n.k
     WHERE o.v IS DISTINCT FROM n.v
  LOOP
    IF s IS NULL THEN s := sync_stamp_current(p_ws); END IF;
    PERFORM sync_stamp_put_over(p_ws, p_label, p_row, p_prefix || u.k, u.new_v IS NULL, s, u.old_v::text, u.old_v IS NOT NULL);
    IF p_log_table <> '' THEN
      PERFORM sync_structure_put(p_ws, p_log_table, p_row, p_log_prefix || u.k, u.old_v::text, u.new_v::text, s, false);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
