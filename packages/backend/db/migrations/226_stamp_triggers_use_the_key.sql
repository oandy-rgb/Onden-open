-- 226: the two statement triggers of migration 215 find a row's stamps through the primary key of sync_stamps / sync_stamp_heads, not by reading the
-- whole table (review of PR #1946: anchorBulkCost.integration.test.ts timed out on real Postgres). Only replaces two functions: no table, index,
-- trigger or row is added, changed or deleted.
--
-- WHY. sync_rows_made_afresh() and sync_rows_go_with_note() compared the column `table_name` (text) with TG_TABLE_NAME, which is of type `name`.
-- `text = name` is not an operator of the btree family of the primary key (workspace_id, table_name, row_key, field), so the planner cannot use
-- the key for it: every statement on block_anchors, block_nodes or note_anchor_places (a save writes note_anchor_places once per note) read every
-- row of sync_stamps, and the cost of one save grew with how many stamps the database holds; a write over many notes grew with its square.
-- Measured on Postgres 16 (the PR): 63,187 stamps read to find none, 5.7 ms a statement; the same statement with a text value: an index scan.
-- The fix is the type of one value: `v_table text := TG_TABLE_NAME`, used in every SQL comparison with table_name. The plpgsql branches
-- `IF TG_TABLE_NAME = 'block_anchors'` are comparisons in memory, not scans, and stay as they were; so does what the functions do.
--
-- WHAT ELSE WAS LOOKED AT (every function of the schema that names TG_TABLE_NAME, TG_TABLE_SCHEMA, TG_NAME, TG_RELNAME, current_database(),
-- current_schema, relname, attname, nspname, proname, tgname or regclass, and every function with a name or regclass argument or result; none other
-- compares a text column with a name value in SQL):
--   assert_actor_ref                     TG_TABLE_NAME only in an error message
--   sync_rows_in_their_notes_workspace   TG_TABLE_NAME only in an error message
--   sync_genesis_pass                    catalog columns against literals (pg_proc.proname, pg_class.relname): name = name, the catalog's own indexes
--   sync_keep_emptied_id                 pg_attribute.attname = a text variable, with attrelid: the catalog index (name = text is in its family)
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: run migration 215's definitions of the two functions
-- again (the behaviour is the same; only the cost differs). (This header never spells the statement that defines a function: test/helpers/
-- rerunMigration.ts finds the functions of later migrations by that text, and a comment that holds it is read as one.)
-- drill: no allowance needed. This migration writes no row of any table.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on): only the two functions are replaced.
--
--   SELECT p.proname, p.prosrc ~ 'table_name = TG_TABLE_NAME' AS compares_text_with_name
--     FROM pg_proc p WHERE p.proname IN ('sync_rows_made_afresh', 'sync_rows_go_with_note') ORDER BY 1;
--   -- before: both true; after: both false. No other object changes.

CREATE OR REPLACE FUNCTION sync_rows_made_afresh() RETURNS trigger AS $$
DECLARE v_table text := TG_TABLE_NAME; v_keys text[]; v_ws uuid[];
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
            -- each key's own stamps and heads, looked up by the key (LATERAL): a join on (workspace_id, row_key) with the UNION ALL built first read every
            -- stamp of the label and hashed it (migration 226)
            SELECT x.w, x.k, t.origin, max(t.seq) AS m FROM unnest(v_ws, v_keys) AS x(w, k)
              CROSS JOIN LATERAL (SELECT origin, seq FROM sync_stamps WHERE workspace_id = x.w AND table_name = v_table AND row_key = x.k AND field <> '*' AND origin <> 'genesis'
                    UNION ALL SELECT origin, seq FROM sync_stamp_heads WHERE workspace_id = x.w AND table_name = v_table AND row_key = x.k AND field <> '*' AND origin <> 'genesis') t
             GROUP BY x.w, x.k, t.origin) u GROUP BY u.w, u.k) o
   WHERE s.workspace_id = o.w AND s.table_name = v_table AND s.row_key = o.k AND s.field = '*' AND NOT s.deleted;
  DELETE FROM sync_stamps s USING unnest(v_ws, v_keys) AS x(w, k) WHERE s.workspace_id = x.w AND s.table_name = v_table AND s.row_key = x.k AND s.field <> '*';
  DELETE FROM sync_stamp_heads s USING unnest(v_ws, v_keys) AS x(w, k) WHERE s.workspace_id = x.w AND s.table_name = v_table AND s.row_key = x.k AND s.field <> '*';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_rows_go_with_note() RETURNS trigger AS $$
DECLARE v_table text := TG_TABLE_NAME; r record; v_keys text[]; v_notes uuid[]; v_ws uuid[]; v_gone text[]; v_ws1 uuid; v_cols jsonb;
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
       AND NOT EXISTS (SELECT 1 FROM sync_stamps s WHERE s.workspace_id = v_ws1 AND s.table_name = v_table AND s.row_key = x.k AND s.field = 'note');
    IF v_gone IS NOT NULL THEN
      DELETE FROM sync_stamps s USING unnest(v_gone) AS g(k) WHERE s.workspace_id = v_ws1 AND s.table_name = v_table AND s.row_key = g.k;
      DELETE FROM sync_stamp_heads s USING unnest(v_gone) AS g(k) WHERE s.workspace_id = v_ws1 AND s.table_name = v_table AND s.row_key = g.k;
    END IF;
  END LOOP;
  -- those moved into it keep each stamp's value: the row was the one place that held the winners' (a transition table's row is an anonymous record: made the table's
  -- row type again for sync_logged_value)
  IF TG_TABLE_NAME = 'block_anchors' THEN
    UPDATE sync_stamps s SET kept_value = jsonb_build_object('text', sync_logged_value(jsonb_populate_record(NULL::block_anchors, to_jsonb(o)), s.field, v_cols ->> s.field))
      FROM old_rows o WHERE s.workspace_id = o.workspace_id AND s.table_name = v_table AND s.row_key = o.anchor_id AND s.field <> '*' AND v_cols ? s.field
       AND s.kept_value IS NULL AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.id = o.note_id);
  ELSIF TG_TABLE_NAME = 'block_nodes' THEN
    UPDATE sync_stamps s SET kept_value = jsonb_build_object('text', sync_logged_value(jsonb_populate_record(NULL::block_nodes, to_jsonb(o)), s.field, v_cols ->> s.field))
      FROM old_rows o WHERE s.workspace_id = o.workspace_id AND s.table_name = v_table AND s.row_key = o.id::text AND s.field <> '*' AND v_cols ? s.field
       AND s.kept_value IS NULL AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.id = o.note_id);
  END IF; -- an anchors unit is keyed by its note: it never moves into another, so nothing of it is kept
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
