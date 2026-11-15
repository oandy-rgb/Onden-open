-- 194: write stamps for attributes, tag applications, hand-made edges, pointers and board cards (causal-stamps proposal §8 S2,
-- §8.5). Records only: nothing reads a stamp or the structure log to decide anything, so what a user sees does not change.
--
--   1. sync_stamp_trigger() grows to what these tables need (S1's content_nodes arguments mean the same as before):
--        - the row key can be several columns, joined with '/', and the workspace can be found through the notes
--          the row names ('via:node_id,tag_id': node_tags has no workspace column);
--        - structure_log fields come in four kinds: 'f=col' a column that changes (S1), 'f~col' a value that exists while
--          the row does (a tag applied: NULL -> tag, removed: tag -> NULL), 'f@a+b+c' several columns kept together as one
--          JSON text (a board card: NULL -> {...} -> {...}, taken off the board: {...} -> NULL), 'f^col' a column whose row
--          may go away (the value -> NULL when it does); a structure filter ('column=value') limits the log to some rows;
--        - a stamped field can be several columns ('position=x+y');
--        - an UPDATE can be treated as a create or a delete (the mode argument): an attribute whose source flips between
--          "a person wrote it" and "the note's text produced it" appears to the stamps as made / removed.
--      The writes that move a board card often (a drag) are merged: a card moved again by the same author and device within
--      5 seconds updates the card's last structure_log row instead of adding one, so only the first old value and the last
--      new value of a run of moves stay. structure_log stays append-only for everything else (the guard below).
--   2. The stamps are attached to node_attributes (through its own function, sync_stamp_attribute_trigger(), because a
--      drawing is a multi-MB value saved every second; only what a person or automation wrote: source ui / explicit /
--      dispatcher; text-derived and computed values are worked out again by every node), node_tags and block_node_tags,
--      node_edges (only origin 'manual'), note_pointers and node_positions. Deletes leave a tombstone.
--      structure_log gets node_tags (row = the note, field 'tag', the tag id), node_positions (row = note/board, field 'card')
--      and the board's section frames (node_attributes key '_canvas_sections', field 'sections'; the board events carry only
--      counts, never the frames, so the log is the only place their old and new values are kept).
--   3. note_pointers.id becomes a value worked out from (parent, target) by derive_row_id(): two nodes that each make
--      the same pointer get the same id. The existing rows get their new id here (content unchanged; nothing references a
--      pointer id from another table). A top-level (no parent) pointer pair on the same target that already exists twice
--      cannot share one derived id: the oldest takes it, the extra keeps its old id (counted in the NOTICE).
--      Running this again changes nothing. function_refs ids are NOT touched here (another change is rewriting that table).
--
-- Read-only preview for the production database, counts only (the same rule as derive_row_id and the move below):
--   WITH d AS (SELECT id, parent_id, target_id, created_at,
--                     encode(sha256(convert_to('note_pointer' || E'\x1f' || COALESCE(parent_id::text, '') || E'\x1f' || target_id::text, 'UTF8')), 'hex') AS h
--                FROM note_pointers),
--        e AS (SELECT *, substr(h,1,8)||'-'||substr(h,9,4)||'-5'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12) AS derived FROM d),
--        r AS (SELECT *, row_number() OVER (PARTITION BY parent_id, target_id ORDER BY (id::text = derived) DESC, created_at, id) AS rn FROM e)
--   SELECT count(*) AS pointers,
--          count(*) FILTER (WHERE rn = 1 AND id::text <> derived) AS ids_replaced,
--          count(*) FILTER (WHERE rn > 1) AS extra_top_level_duplicates_left_alone
--     FROM r;
--
-- Assumptions this migration makes:
--   * Order with 191 (#1556, which deletes many node_tags / block_node_tags rows): either order works, neither fails.
--     191 first: its deleted rows leave nothing here. 194 first: 191's deletes run these triggers inside that migration, so
--     each deleted node_tags row writes a tombstone with no author and one "tag removed" line in structure_log, and
--     sync_clock.writes_without_mutate goes up by the one transaction nobody caused; the migration is also slower by the
--     per-row cost measured in the PR (about 0.25 ms a row on PGlite).
--   * The merge window of a board card slides: each merge sets the row's time to now, so drags less than 5 seconds apart can
--     merge without end, and writes without an author (the table's own writes outside mutate) merge with each other. Section 8.5
--     of the proposal accepts this: the log keeps the first old value and the last new value of a run of moves.
--   * Deleting a whole workspace (not a product operation today) cascades through these tables, and the triggers then write
--     tombstones and sync_clock rows for the workspace that is going away. S1 has the same orphans for content_nodes; they are
--     harmless (nothing reads them without the workspace) and not cleaned up here.
--
-- Rolling back to an older backend: it refuses to start on a database with a migration it does not know (db.ts); after
-- restoring the pre-upgrade backup none of this exists. The new triggers never read anything the older code could have
-- changed, and a pointer written by older code gets its id from the trigger here, so no write fails on them.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. one id function for rows whose identity is a few fields (pointers now; other tables later)

-- The id of a row worked out from what makes it that row: the same kind and parts give the same id on every node.
-- (A sha-256 of the parts, laid out as a version-5 uuid.) Parts are text; write a missing part as ''.
CREATE OR REPLACE FUNCTION derive_row_id(p_kind text, VARIADIC p_parts text[]) RETURNS uuid AS $$
  SELECT (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-5' || substr(h, 14, 3) || '-a' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
    FROM (SELECT encode(sha256(convert_to(p_kind || E'\x1f' || array_to_string(p_parts, E'\x1f'), 'UTF8')), 'hex') AS h) x;
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION note_pointer_derive_id() RETURNS trigger AS $$
BEGIN
  NEW.id := derive_row_id('note_pointer', COALESCE(NEW.parent_id::text, ''), NEW.target_id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Before the stamp triggers exist, so the move below leaves no stamps behind.
DO $$
DECLARE moved bigint; extra bigint;
BEGIN
  -- A row that already holds the derived id ranks first, so running this again picks the same row as the first run did,
  -- whatever created_at the rows tie on (otherwise the second run could try to give the derived id to a different row).
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY parent_id, target_id
             ORDER BY (id = derive_row_id('note_pointer', COALESCE(parent_id::text, ''), target_id::text)) DESC, created_at, id) AS rn
      FROM note_pointers),
  moving AS (
    UPDATE note_pointers p SET id = derive_row_id('note_pointer', COALESCE(p.parent_id::text, ''), p.target_id::text)
      FROM ranked r WHERE r.id = p.id AND r.rn = 1
       AND p.id <> derive_row_id('note_pointer', COALESCE(p.parent_id::text, ''), p.target_id::text)
    RETURNING 1)
  SELECT count(*) INTO moved FROM moving;
  SELECT count(*) INTO extra FROM note_pointers p
   WHERE p.id <> derive_row_id('note_pointer', COALESCE(p.parent_id::text, ''), p.target_id::text);
  RAISE NOTICE '194: % pointer id(s) replaced by a derived id; % extra top-level duplicate(s) keep their old id', moved, extra;
END $$;

CREATE OR REPLACE TRIGGER note_pointers_derive_id BEFORE INSERT ON note_pointers FOR EACH ROW EXECUTE FUNCTION note_pointer_derive_id();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. the generic trigger, grown

-- structure_log is append-only, except that the generic trigger may rewrite the newest row of a board card it is merging into.
CREATE OR REPLACE FUNCTION structure_log_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('onden.structure_merge', true) = 'on'
     AND NEW.id = OLD.id AND NEW.workspace_id = OLD.workspace_id AND NEW.table_name = OLD.table_name
     AND NEW.row_key = OLD.row_key AND NEW.field = OLD.field AND NEW.old_value IS NOT DISTINCT FROM OLD.old_value THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'structure_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- The row's workspace: a column, or 'via:a,b' = the workspace of the first note named by those columns that still exists
-- (a node_tags row has no workspace column; while a note or tag is being purged the other one is still there).
CREATE OR REPLACE FUNCTION sync_workspace(r anyelement, p_arg text) RETURNS uuid AS $$
DECLARE c text; w uuid;
BEGIN
  IF left(p_arg, 4) <> 'via:' THEN RETURN sync_column(r, p_arg)::uuid; END IF;
  FOREACH c IN ARRAY string_to_array(substr(p_arg, 5), ',') LOOP
    EXECUTE format('SELECT n.workspace_id FROM content_nodes n WHERE n.id = ($1).%I', c) INTO w USING r;
    IF w IS NOT NULL THEN RETURN w; END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Several columns of the row as one key text: 'a,b' -> a || '/' || b.
CREATE OR REPLACE FUNCTION sync_key(r anyelement, p_columns text) RETURNS text AS $$
DECLARE c text; k text := NULL;
BEGIN
  FOREACH c IN ARRAY string_to_array(p_columns, ',') LOOP
    k := CASE WHEN k IS NULL THEN sync_column(r, c) ELSE k || '/' || sync_column(r, c) END;
  END LOOP;
  RETURN k;
END;
$$ LANGUAGE plpgsql;

-- Columns 'a+b+c' of the row as one JSON text.
CREATE OR REPLACE FUNCTION sync_composite(r anyelement, p_columns text) RETURNS text AS $$
DECLARE c text; args text := ''; v text;
BEGIN
  FOREACH c IN ARRAY string_to_array(p_columns, '+') LOOP
    args := args || CASE WHEN args = '' THEN '' ELSE ', ' END || format('%L, ($1).%I', c, c);
  END LOOP;
  EXECUTE 'SELECT jsonb_build_object(' || args || ')::text' INTO v USING r;
  RETURN v;
END;
$$ LANGUAGE plpgsql;

-- Did the column (or any of 'a+b') change? The field named 'deleted' counts only whether the column is set.
CREATE OR REPLACE FUNCTION sync_column_changed(o anyelement, n anyelement, p_field text, p_column text) RETURNS boolean AS $$
DECLARE changed boolean; c text;
BEGIN
  IF p_field = 'deleted' THEN
    EXECUTE format('SELECT (($1).%1$I IS NULL) IS DISTINCT FROM (($2).%1$I IS NULL)', p_column) INTO changed USING o, n;
    RETURN changed;
  END IF;
  FOREACH c IN ARRAY string_to_array(p_column, '+') LOOP
    EXECUTE format('SELECT ($1).%1$I IS DISTINCT FROM ($2).%1$I', c) INTO changed USING o, n;
    IF changed THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_logged_value(r anyelement, p_field text, p_column text) RETURNS text AS $$
  SELECT CASE WHEN p_field = 'deleted' THEN (sync_column(r, p_column) IS NOT NULL)::text
              WHEN position('+' IN p_column) > 0 THEN sync_composite(r, p_column)
              ELSE sync_column(r, p_column) END;
$$ LANGUAGE sql;

-- One structure_log row. `merge` (a board card moved again soon after by the same author and device) rewrites the card's
-- newest row, when that row still ends where this change starts, instead of adding one.
CREATE OR REPLACE FUNCTION sync_structure_put(p_ws uuid, p_table text, p_key text, p_field text, p_old text, p_new text, s jsonb, p_merge boolean) RETURNS void AS $$
DECLARE prev record;
BEGIN
  IF p_merge THEN
    SELECT id, old_value, new_value, author, device, at INTO prev FROM structure_log
     WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field ORDER BY id DESC LIMIT 1;
    IF FOUND AND prev.new_value IS NOT DISTINCT FROM p_old AND prev.new_value IS NOT NULL
       AND prev.author IS NOT DISTINCT FROM (s->>'author') AND prev.device IS NOT DISTINCT FROM NULLIF(s->>'device', '')::uuid
       AND prev.at > clock_timestamp() - interval '5 seconds' THEN
      PERFORM set_config('onden.structure_merge', 'on', true);
      UPDATE structure_log SET new_value = p_new, origin = s->>'origin', seq = (s->>'seq')::bigint,
             hlc_wall = (s->>'wall')::bigint, hlc_counter = (s->>'counter')::int, at = clock_timestamp()
       WHERE id = prev.id;
      PERFORM set_config('onden.structure_merge', '', true);
      RETURN;
    END IF;
  END IF;
  INSERT INTO structure_log (workspace_id, table_name, row_key, field, old_value, new_value,
                             origin, seq, hlc_wall, hlc_counter, author, device)
  VALUES (p_ws, p_table, p_key, p_field, p_old, p_new,
          s->>'origin', (s->>'seq')::bigint, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid);
END;
$$ LANGUAGE plpgsql;

-- Arguments: 0 table label; 1 key columns 'a,b'; 2 workspace column or 'via:a,b'; 3 tracked fields 'field=col[+col],...'
-- (each gets its own stamp when it changes); 4 structure fields (see the header: '=', '~', '@') or ''; 5 the structure log's
-- row key columns ('' = the same as 1); 6 mode: '' | 'asinsert' | 'asdelete' (treat this UPDATE as a create / a delete);
-- 7 structure filter 'column=value' ('' = every row): only rows whose column has that value reach structure_log.
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
    PERFORM sync_stamp_put(ws, tbl, key, '*', false, s);
  ELSIF op = 'DELETE' THEN
    DELETE FROM sync_stamps WHERE workspace_id = ws AND table_name = tbl AND row_key = key AND field <> '*';
    PERFORM sync_stamp_put(ws, tbl, key, '*', true, s);
  ELSE
    FOREACH spec IN ARRAY string_to_array(TG_ARGV[3], ',') LOOP
      fld := split_part(spec, '=', 1);
      col := split_part(spec, '=', 2);
      IF sync_column_changed(OLD, NEW, fld, col) THEN
        PERFORM sync_stamp_put(ws, tbl, key, fld, false, s);
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

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. the tables

-- node_attributes: what a person or automation wrote (source ui, explicit, dispatcher). A value the note's text produced
-- (markdown, frontmatter) or Onden computed (derived) is worked out again by each node, so it is not stamped; an attribute
-- that changes between the two kinds counts as made / removed.
-- This table has its own trigger function instead of the generic one: a hand-written drawing (note_ink, ink_data, board_ink)
-- is an attribute value of hundreds of KB to a few MB saved about every second, and the generic function passes the whole
-- row (value included) to a dozen helpers. This one reads the columns it needs by name, compares the value once, and never
-- hands it to anything but the one structure_log line a board's section frames get.
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
    PERFORM sync_stamp_put(ws, 'node_attributes', rkey, '*', false, s);
    IF attr = '_canvas_sections' THEN PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', NULL, NEW.value, s, false); END IF;
  ELSIF op = 'DELETE' THEN
    DELETE FROM sync_stamps WHERE workspace_id = ws AND table_name = 'node_attributes' AND row_key = rkey AND field <> '*';
    PERFORM sync_stamp_put(ws, 'node_attributes', rkey, '*', true, s);
    IF attr = '_canvas_sections' THEN PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NULL, s, false); END IF;
  ELSE
    IF value_changed THEN PERFORM sync_stamp_put(ws, 'node_attributes', rkey, 'value', false, s); END IF;
    IF OLD.value_type IS DISTINCT FROM NEW.value_type THEN PERFORM sync_stamp_put(ws, 'node_attributes', rkey, 'type', false, s); END IF;
    IF OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable THEN PERFORM sync_stamp_put(ws, 'node_attributes', rkey, 'inheritable', false, s); END IF;
    IF value_changed AND attr = '_canvas_sections' THEN PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NEW.value, s, false); END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER node_attributes_sync_stamp_insert AFTER INSERT ON node_attributes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_attribute_trigger();
CREATE OR REPLACE TRIGGER node_attributes_sync_stamp_update AFTER UPDATE ON node_attributes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_attribute_trigger();
CREATE OR REPLACE TRIGGER node_attributes_sync_stamp_delete AFTER DELETE ON node_attributes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_attribute_trigger();

-- node_tags: one stamp per (note, tag) and the apply / remove in structure_log (row = the note, field 'tag', value = the tag id).
-- A tag the note's own text gives it (#tag) is a node_tags row too; it is stamped like the others and the text is what
-- really decides it, which the reader of these stamps will know from the note's body stamp.
CREATE OR REPLACE TRIGGER node_tags_sync_stamp_insert AFTER INSERT ON node_tags FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('node_tags', 'node_id,tag_id', 'via:node_id,tag_id', '', 'tag~tag_id', 'node_id', '');
CREATE OR REPLACE TRIGGER node_tags_sync_stamp_delete AFTER DELETE ON node_tags FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('node_tags', 'node_id,tag_id', 'via:node_id,tag_id', '', 'tag~tag_id', 'node_id', '');

CREATE OR REPLACE TRIGGER block_node_tags_sync_stamp_insert AFTER INSERT ON block_node_tags FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('block_node_tags', 'block_node_id,tag_id', 'workspace_id', '', '', '', '');
CREATE OR REPLACE TRIGGER block_node_tags_sync_stamp_delete AFTER DELETE ON block_node_tags FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('block_node_tags', 'block_node_id,tag_id', 'workspace_id', '', '', '', '');

-- node_edges: only the hand-made ones; the automatic ones (wikilink, citation, semantic...) every node works out itself.
-- The row is named by what the edge connects, not by its random id.
CREATE OR REPLACE TRIGGER node_edges_sync_stamp_insert AFTER INSERT ON node_edges FOR EACH ROW WHEN (NEW.origin = 'manual')
  EXECUTE FUNCTION sync_stamp_trigger('node_edges', 'source_node_id,target_node_id,edge_type', 'workspace_id', 'status=status', '', '', '');
CREATE OR REPLACE TRIGGER node_edges_sync_stamp_update AFTER UPDATE ON node_edges FOR EACH ROW
  WHEN (OLD.origin = 'manual' AND NEW.origin = 'manual' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION sync_stamp_trigger('node_edges', 'source_node_id,target_node_id,edge_type', 'workspace_id', 'status=status', '', '', '');
CREATE OR REPLACE TRIGGER node_edges_sync_stamp_delete AFTER DELETE ON node_edges FOR EACH ROW WHEN (OLD.origin = 'manual')
  EXECUTE FUNCTION sync_stamp_trigger('node_edges', 'source_node_id,target_node_id,edge_type', 'workspace_id', 'status=status', '', '', '');

-- note_pointers: keyed by its derived id; the position among its siblings and the label each on their own.
CREATE OR REPLACE TRIGGER note_pointers_sync_stamp_insert AFTER INSERT ON note_pointers FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('note_pointers', 'id', 'workspace_id', 'sort=sort_order,prefix=display_prefix', '', '', '');
CREATE OR REPLACE TRIGGER note_pointers_sync_stamp_update AFTER UPDATE ON note_pointers FOR EACH ROW
  WHEN (OLD.sort_order IS DISTINCT FROM NEW.sort_order OR OLD.display_prefix IS DISTINCT FROM NEW.display_prefix)
  EXECUTE FUNCTION sync_stamp_trigger('note_pointers', 'id', 'workspace_id', 'sort=sort_order,prefix=display_prefix', '', '', '');
CREATE OR REPLACE TRIGGER note_pointers_sync_stamp_delete AFTER DELETE ON note_pointers FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('note_pointers', 'id', 'workspace_id', 'sort=sort_order,prefix=display_prefix', '', '', '');

-- node_positions (a card on a board or on the graph): where it is, how it looks (size, colour, folded) and which board it opens
-- each on their own; structure_log keeps the whole card as one JSON text, NULL when it is not on the board.
CREATE OR REPLACE TRIGGER node_positions_sync_stamp_insert AFTER INSERT ON node_positions FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('node_positions', 'node_id,surface', 'workspace_id',
    'position=x+y,look=width+height+color+folded,sub_canvas=sub_canvas_id', 'card@x+y+width+height+color+folded+sub_canvas_id', '', '');
CREATE OR REPLACE TRIGGER node_positions_sync_stamp_update AFTER UPDATE ON node_positions FOR EACH ROW
  WHEN (OLD.x IS DISTINCT FROM NEW.x OR OLD.y IS DISTINCT FROM NEW.y OR OLD.width IS DISTINCT FROM NEW.width
     OR OLD.height IS DISTINCT FROM NEW.height OR OLD.color IS DISTINCT FROM NEW.color OR OLD.folded IS DISTINCT FROM NEW.folded
     OR OLD.sub_canvas_id IS DISTINCT FROM NEW.sub_canvas_id)
  EXECUTE FUNCTION sync_stamp_trigger('node_positions', 'node_id,surface', 'workspace_id',
    'position=x+y,look=width+height+color+folded,sub_canvas=sub_canvas_id', 'card@x+y+width+height+color+folded+sub_canvas_id', '', '');
CREATE OR REPLACE TRIGGER node_positions_sync_stamp_delete AFTER DELETE ON node_positions FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('node_positions', 'node_id,surface', 'workspace_id',
    'position=x+y,look=width+height+color+folded,sub_canvas=sub_canvas_id', 'card@x+y+width+height+color+folded+sub_canvas_id', '', '');
