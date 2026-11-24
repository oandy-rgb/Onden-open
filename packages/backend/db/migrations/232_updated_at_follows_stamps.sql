-- 232: `updated_at` of the stamped tables other than notes is a function of the row's stamps, as a note's is (migrations 206, 209), on the node that writes and on a node
-- that takes the write in a change bundle (src/spine/stampedMerge/dbRows.ts). Adds six functions and two triggers per table; redefines one function (same behaviour).
-- No existing row is read for a purpose other than the preview below, changed or deleted.
--
-- WHY. node_attributes, node_positions, block_nodes, function_refs and actor_module_settings carry `updated_at`, and their rows travel. The writer set it to its database's now(); a node that took
-- the write back into a row it held kept the time IT wrote the row. Two nodes holding the same writes held different values (src/test/snapshotBrought.integration.test.ts
-- "updated_at of an attribute"; README of spine/stampedMerge 「接上傳輸前必須完成」).
--
-- THE RULE (the one a note follows): `updated_at` = the largest wall time (ms) among the stamps of the row's units that COUNT as an edit — the other heads too, the keys of
-- its JSON column too (function_refs.config) — when it has any; else what the row holds (its creation's value, which a snapshot or a bundle carries as a column). A unit write
-- does not count when it is housekeeping (`meta.quiet = true`). A note's writers say so with onden.stamp_quiet (spine/stamps.ts withQuietStamps). For these five tables
-- the writer says it by what it does to the column, decided per unit and per transaction: a unit counts when ANY statement of its transaction wrote it while moving
-- `updated_at` (changing it, or setting it to now(), the transaction's start), whatever the order of the statements; a unit only statements that left the column alone
-- wrote is quiet. A statement that moves the column without changing any unit (a derived attribute, a paragraph row's text worked out again, a card put
-- down where it was) leaves what it wrote, exactly as before this migration: no stamp says anything about such a write, and it is not carried (README of
-- spine/stampedMerge 「接上傳輸前必須完成」: a known gap of the rule, with the options).
-- TO CHANGE WHICH STAMPS DO NOT COUNT, change sync_updated_at_wall (below), the one place: the node that writes and the node that takes a bundle both read it.
--
-- WHAT THIS ADDS
--   sync_updated_at_wall(ws, table, key)      the function above (bigint ms, NULL when no counting stamp). Labels: the table, and its JSON column's label (content_nodes.tag_schema,
--                                              function_refs.config). Not counted: `*` (the creation), `sort` (a note's position among siblings;
--                                              no other table with `updated_at` has a unit of that name), a quiet stamp, a genesis stamp.
--   sync_touch_row_updated_at(ws, table, key, else)  writes it (or `else` when no stamp counts) into the row when it differs (the merge passes no `else`).
--   sync_updated_at_moved(old, new), sync_units_changed(table, old, new, fields, json)   what a statement did to a row: moved the column; which units it changed.
--   sync_updated_at_counted_before()          BEFORE UPDATE of each of the five tables: remembers, for the transaction (onden.updated_at_counted), the units a statement
--                                              that leaves the column alone rewrites after an earlier statement of the transaction counted them.
--   sync_updated_at_follows_stamps()          AFTER UPDATE of each of the five tables, named to run after the table's stamp triggers (AFTER triggers run in name order):
--                                              a statement that moved the column and changed a unit gets the function's value; one that did not move it marks this
--                                              transaction's stamps of the units it changed quiet, except the remembered ones. Both stand aside while a snapshot or a
--                                              merge is written (sync_import_active), like every stamp trigger.
--
-- WHAT THIS CHANGES IN BEHAVIOUR (one redefinition, and what a write leaves in the column)
--   sync_touch_updated_at(ws, key) (209)       now `sync_touch_row_updated_at(ws, 'content_nodes', key)`: the same statement, one definition for every table.
--   a write of the five tables that moves `updated_at` and changes a unit leaves the stamp's clock in it (ms) instead of the database's now() (µs), as 206 did for notes.
--   a write that moves it without changing any unit (a derived attribute, a paragraph row's text worked out again, services/blockNodes.ts; a card put down where
--   it was, services/boardStore.ts) leaves what it wrote, as on main: every local write that moves the column moves it as before (services/attributeWrites.ts reads
--   it to tell whether someone else changed a derived value; services/boardWrites.ts's 5-second window; migration 231's version baselines).
--
-- WHAT THIS DOES NOT DO, on purpose
--   * no existing `updated_at` or stamp is rewritten: a row's value changes at its next write. No node has exchanged yet (the transport is not on), so no two
--     nodes hold different values from before this migration; a node joined by snapshot holds its source's values.
--   * the wire does not change: `meta.quiet` already travels with a stamp (206), and a bundle carries a new row's `updated_at` as a column as before. (Declaring a
--     paragraph row's `updated_at` derived, out of the comparison, would take the column out of what a snapshot and a bundle carry: a change of shape.)
--   * a statement that leaves the column alone on a row this transaction made, or touched without changing a unit, sees the column at now() and counts as moving it.
--     Every node reads the same stamps, so every node still holds the same value.
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: for each of node_attributes, node_positions, block_nodes, function_refs and
-- actor_module_settings, DROP TRIGGER <table>_updated_at_counted and <table>_updated_at_follows ON <table>; re-run 209's sync_touch_updated_at; DROP FUNCTION
-- sync_updated_at_follows_stamps(), sync_updated_at_counted_before(), sync_units_changed(text, anyelement, anyelement, text, text), sync_updated_at_moved(anyelement, anyelement),
-- sync_touch_row_updated_at(uuid, text, text, timestamptz), sync_updated_at_wall(uuid, text, text).
-- drill: no allowance needed. This migration writes no row.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; counts only):
--
--   SELECT 'rows whose updated_at their next counting write sets from the stamps' AS part, sum(n)::bigint AS rows, 0::bigint AS est_bytes FROM (
--     SELECT count(*) AS n FROM node_attributes UNION ALL SELECT count(*) FROM node_positions UNION ALL SELECT count(*) FROM block_nodes UNION ALL SELECT count(*) FROM function_refs
--     UNION ALL SELECT count(*) FROM actor_module_settings) x
--   UNION ALL SELECT 'rows rewritten', 0, 0
--   ;

CREATE OR REPLACE FUNCTION sync_updated_at_wall(p_ws uuid, p_table text, p_key text) RETURNS bigint AS $$
  WITH l AS (SELECT CASE p_table WHEN 'content_nodes' THEN ARRAY['content_nodes', 'content_nodes.tag_schema'] WHEN 'function_refs' THEN ARRAY['function_refs', 'function_refs.config']
                                  ELSE ARRAY[p_table] END AS labels)
  SELECT max(w) FROM (
    SELECT hlc_wall AS w FROM sync_stamps, l WHERE workspace_id = p_ws AND table_name = ANY(l.labels) AND row_key = p_key AND origin <> 'genesis' AND field NOT IN ('*', 'sort')
       AND COALESCE(meta->>'quiet', '') <> 'true'
    UNION ALL SELECT hlc_wall FROM sync_stamp_heads, l WHERE workspace_id = p_ws AND table_name = ANY(l.labels) AND row_key = p_key AND origin <> 'genesis' AND field NOT IN ('*', 'sort')
       AND COALESCE(meta->>'quiet', '') <> 'true') x
$$ LANGUAGE sql STABLE;

-- A row's key as its stamps name it: the id, or "<node id>/<key or surface>" (src/spine/snapshotTables.json rowKey). The UPDATE matches it as the table's key columns.
-- `p_else`: the value when no stamp counts (a write that changed no unit keeps what the row held: the caller passes it), else nothing is written.
CREATE OR REPLACE FUNCTION sync_touch_row_updated_at(p_ws uuid, p_table text, p_key text, p_else timestamptz DEFAULT NULL) RETURNS void AS $$
DECLARE v_wall bigint := sync_updated_at_wall(p_ws, p_table, p_key); v_at timestamptz;
BEGIN
  v_at := CASE WHEN v_wall IS NOT NULL AND v_wall > 0 THEN to_timestamp(v_wall / 1000.0) ELSE p_else END;
  IF v_at IS NULL THEN RETURN; END IF;
  -- this write of the column is the rule's own: the two triggers below stand aside for it (else a row with no counting stamp would be put back and forth for ever)
  PERFORM set_config('onden.updated_at_touch', 'on', true);
  IF p_table IN ('content_nodes', 'function_refs', 'block_nodes') THEN
    EXECUTE format('UPDATE %I SET updated_at = $3 WHERE id = $2::uuid AND workspace_id = $1 AND updated_at IS DISTINCT FROM $3', p_table) USING p_ws, p_key, v_at;
  ELSIF p_table = 'node_attributes' THEN
    UPDATE node_attributes SET updated_at = v_at WHERE node_id = split_part(p_key, '/', 1)::uuid AND key = substr(p_key, 38) AND workspace_id = p_ws AND updated_at IS DISTINCT FROM v_at;
  ELSIF p_table = 'node_positions' THEN
    UPDATE node_positions SET updated_at = v_at WHERE node_id = split_part(p_key, '/', 1)::uuid AND surface = substr(p_key, 38) AND workspace_id = p_ws AND updated_at IS DISTINCT FROM v_at;
  ELSIF p_table = 'actor_module_settings' THEN -- "<actor id>/<tag id>"; the workspace is the tag's
    UPDATE actor_module_settings SET updated_at = v_at WHERE tag_id = right(p_key, 36)::uuid AND actor_id = left(p_key, length(p_key) - 37) AND updated_at IS DISTINCT FROM v_at;
  END IF;
  PERFORM set_config('onden.updated_at_touch', '', true);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_touch_updated_at(p_ws uuid, p_key text) RETURNS void AS $$
BEGIN
  PERFORM sync_touch_row_updated_at(p_ws, 'content_nodes', p_key);
END;
$$ LANGUAGE plpgsql;

-- What one statement does to a row of the tables below (the trigger arguments, the same for the BEFORE and the AFTER trigger): TG_ARGV[0] the row's key columns
-- (sync_key, as the table's stamp trigger names them); TG_ARGV[1] its units ("field=column[+column]", sync_stamp_trigger's spec); TG_ARGV[2] its JSON column
-- ("label=column=prefix") or ''; TG_ARGV[3] its workspace (sync_workspace: a column, or via:<note column>).
-- The statement MOVES `updated_at` when it changes it, or sets it to now() (the start of the transaction: a row this transaction made or touched holds that already).
CREATE OR REPLACE FUNCTION sync_updated_at_moved(o anyelement, n anyelement) RETURNS boolean AS $$
  SELECT (sync_column(o, 'updated_at'))::timestamptz IS DISTINCT FROM (sync_column(n, 'updated_at'))::timestamptz
      OR (sync_column(n, 'updated_at'))::timestamptz = transaction_timestamp()
$$ LANGUAGE sql STABLE;

-- The (label, field) of every unit the statement changes: the fields, and the keys of the JSON column whose values differ.
CREATE OR REPLACE FUNCTION sync_units_changed(p_table text, o anyelement, n anyelement, p_fields text, p_json text) RETURNS TABLE (label text, field text) AS $$
DECLARE spec text; v_col text; v_old jsonb; v_new jsonb;
BEGIN
  FOREACH spec IN ARRAY string_to_array(p_fields, ',') LOOP
    IF sync_column_changed(o, n, split_part(spec, '=', 1), split_part(spec, '=', 2)) THEN label := p_table; field := split_part(spec, '=', 1); RETURN NEXT; END IF;
  END LOOP;
  IF p_json <> '' THEN
    v_col := split_part(p_json, '=', 2);
    v_old := COALESCE((sync_column(o, v_col))::jsonb, '{}'::jsonb); v_new := COALESCE((sync_column(n, v_col))::jsonb, '{}'::jsonb);
    RETURN QUERY SELECT split_part(p_json, '=', 1), split_part(p_json, '=', 3) || k FROM (SELECT jsonb_object_keys(v_old) AS k UNION SELECT jsonb_object_keys(v_new)) x
                  WHERE v_old -> x.k IS DISTINCT FROM v_new -> x.k;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- BEFORE the statement's stamps are written: of the units it changes without moving `updated_at`, those an earlier statement of this transaction already wrote while
-- moving it (their stamp is this transaction's and is not quiet: a statement that does not move it marks its units quiet) are remembered for the transaction
-- (`onden.updated_at_counted`, local to it), so the AFTER trigger does not mark them quiet: a unit counts when ANY statement of its transaction wrote it while moving
-- `updated_at`, whatever the order. Empty in nearly every transaction: only a unit written twice in one transaction, once each way, is ever in it.
CREATE OR REPLACE FUNCTION sync_updated_at_counted_before() RETURNS trigger AS $$
DECLARE v_key text; s jsonb; v_ws uuid := sync_workspace(NEW, TG_ARGV[3]); v_add jsonb;
BEGIN
  IF v_ws IS NULL OR sync_import_active(v_ws) OR current_setting('onden.updated_at_touch', true) = 'on' OR sync_updated_at_moved(OLD, NEW) THEN RETURN NEW; END IF;
  s := NULLIF(current_setting(sync_stamp_setting(v_ws), true), '')::jsonb;
  IF s IS NULL THEN RETURN NEW; END IF; -- nothing of this transaction is stamped yet
  v_key := sync_key(NEW, TG_ARGV[0]);
  SELECT jsonb_object_agg(st.table_name || '/' || st.row_key || '/' || st.field, true) INTO v_add
    FROM sync_units_changed(TG_TABLE_NAME, OLD, NEW, TG_ARGV[1], TG_ARGV[2]) u
    JOIN sync_stamps st ON st.workspace_id = v_ws AND st.table_name = u.label AND st.row_key = v_key AND st.field = u.field
   WHERE st.origin = s->>'origin' AND st.seq = (s->>'seq')::bigint AND COALESCE(st.meta->>'quiet', '') <> 'true';
  IF v_add IS NOT NULL THEN
    PERFORM set_config('onden.updated_at_counted', (COALESCE(NULLIF(current_setting('onden.updated_at_counted', true), ''), '{}')::jsonb || v_add)::text, true);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AFTER the table's stamp triggers (AFTER triggers run in name order): a statement that moved `updated_at` and changed a unit leaves the function of the row's
-- counting stamps in it (one that changed no unit leaves what it wrote); one that did not move it marks this transaction's stamps of the units it changed quiet,
-- except those an earlier statement of the transaction counted (above).
CREATE OR REPLACE FUNCTION sync_updated_at_follows_stamps() RETURNS trigger AS $$
DECLARE v_key text; s jsonb; v_ws uuid := sync_workspace(NEW, TG_ARGV[3]); v_counted jsonb;
BEGIN
  IF v_ws IS NULL OR sync_import_active(v_ws) OR current_setting('onden.updated_at_touch', true) = 'on' THEN RETURN NULL; END IF;
  v_key := sync_key(NEW, TG_ARGV[0]);
  IF sync_updated_at_moved(OLD, NEW) THEN
    -- a statement that moves the column and changes no unit (a value no stamp covers: a derived attribute, a paragraph row's text, a card put down where it
    -- was) leaves what it wrote, as before this migration: no stamp says anything about it (README 「接上傳輸前必須完成」: such a write is not carried)
    IF NOT EXISTS (SELECT 1 FROM sync_units_changed(TG_TABLE_NAME, OLD, NEW, TG_ARGV[1], TG_ARGV[2])) THEN RETURN NULL; END IF;
    PERFORM sync_touch_row_updated_at(v_ws, TG_TABLE_NAME, v_key);
    RETURN NULL;
  END IF;
  s := NULLIF(current_setting(sync_stamp_setting(v_ws), true), '')::jsonb;
  IF s IS NULL THEN RETURN NULL; END IF; -- nothing was stamped in this transaction
  v_counted := COALESCE(NULLIF(current_setting('onden.updated_at_counted', true), ''), '{}')::jsonb;
  UPDATE sync_stamps st SET meta = COALESCE(st.meta, '{}'::jsonb) || '{"quiet": true}'::jsonb
    FROM sync_units_changed(TG_TABLE_NAME, OLD, NEW, TG_ARGV[1], TG_ARGV[2]) u
   WHERE st.workspace_id = v_ws AND st.table_name = u.label AND st.row_key = v_key AND st.field = u.field
     AND st.origin = s->>'origin' AND st.seq = (s->>'seq')::bigint AND COALESCE(st.meta->>'quiet', '') <> 'true'
     AND NOT v_counted ? (u.label || '/' || v_key || '/' || u.field);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER node_attributes_updated_at_counted BEFORE UPDATE ON node_attributes FOR EACH ROW
  EXECUTE FUNCTION sync_updated_at_counted_before('node_id,key', 'value=value,type=value_type,inheritable=is_inheritable', '', 'workspace_id');
CREATE OR REPLACE TRIGGER node_attributes_updated_at_follows AFTER UPDATE ON node_attributes FOR EACH ROW
  EXECUTE FUNCTION sync_updated_at_follows_stamps('node_id,key', 'value=value,type=value_type,inheritable=is_inheritable', '', 'workspace_id');
CREATE OR REPLACE TRIGGER node_positions_updated_at_counted BEFORE UPDATE ON node_positions FOR EACH ROW
  EXECUTE FUNCTION sync_updated_at_counted_before('node_id,surface', 'position=x+y,look=width+height+color+folded,sub_canvas=sub_canvas_id', '', 'workspace_id');
CREATE OR REPLACE TRIGGER node_positions_updated_at_follows AFTER UPDATE ON node_positions FOR EACH ROW
  EXECUTE FUNCTION sync_updated_at_follows_stamps('node_id,surface', 'position=x+y,look=width+height+color+folded,sub_canvas=sub_canvas_id', '', 'workspace_id');
CREATE OR REPLACE TRIGGER block_nodes_updated_at_counted BEFORE UPDATE ON block_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_updated_at_counted_before('id', 'note=note_id,anchor=anchor_id,ref=block_ref,task=task_id,detached=detached_note_id+detached_tags', '', 'workspace_id');
CREATE OR REPLACE TRIGGER block_nodes_updated_at_follows AFTER UPDATE ON block_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_updated_at_follows_stamps('id', 'note=note_id,anchor=anchor_id,ref=block_ref,task=task_id,detached=detached_note_id+detached_tags', '', 'workspace_id');
CREATE OR REPLACE TRIGGER function_refs_updated_at_counted BEFORE UPDATE ON function_refs FOR EACH ROW
  EXECUTE FUNCTION sync_updated_at_counted_before('id', 'function=function_id,instance=instance,holder=holder_node_id,space=holder_space_id', 'function_refs.config=config=key:', 'workspace_id');
CREATE OR REPLACE TRIGGER function_refs_updated_at_follows AFTER UPDATE ON function_refs FOR EACH ROW
  EXECUTE FUNCTION sync_updated_at_follows_stamps('id', 'function=function_id,instance=instance,holder=holder_node_id,space=holder_space_id', 'function_refs.config=config=key:', 'workspace_id');
CREATE OR REPLACE TRIGGER actor_module_settings_updated_at_counted BEFORE UPDATE ON actor_module_settings FOR EACH ROW
  EXECUTE FUNCTION sync_updated_at_counted_before('actor_id,tag_id', 'settings=settings', '', 'via:tag_id');
CREATE OR REPLACE TRIGGER actor_module_settings_updated_at_follows AFTER UPDATE ON actor_module_settings FOR EACH ROW
  EXECUTE FUNCTION sync_updated_at_follows_stamps('actor_id,tag_id', 'settings=settings', '', 'via:tag_id');
