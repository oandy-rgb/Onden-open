-- 209: a note's place is one write, and a key of a tag's schema counts for `updated_at` (stamped-sync batch 2b-2a; src/spine/stampedMerge/rules/place.ts,
-- src/spine/stampedMerge/dbUnits.ts JSON_SOURCES), and a board's section frames are one unit. Adds four functions and four triggers, and redefines three functions
-- (sync_touch_updated_at of 206, sync_stamp_attribute_trigger of 205, sync_genesis_pass of 202).
-- No existing row is read for a purpose other than the preview below, changed or deleted.
--
-- WHY. A note's place among its siblings is its parent AND its order key: a key only means something under the parent it was chosen under. They are two units
-- (`parent`, `sort`), merged one by one. A move that kept the order key as it was (services/spaces.ts and services/tagMerge.ts move a note without choosing a key; a key
-- chosen by appendOrderKey can equal the old one) stamped `parent` and not `sort`, so after a merge nothing tied the key to the parent it was meant for.
-- From now on every write that changes a note's parent also stamps its order key with the same stamp (the same value: only the stamp is new), so the write that set the
-- winning parent is always among the writes to `sort`, and the merge core shows the key of that write or of a later one that had seen it (rules/place.ts placedSort).
--
-- WHAT THIS ADDS
--   sync_stamp_place_with_parent()       AFTER UPDATE OF parent_id, when the parent changed and the order key did not: stamps `sort` (sync_stamp_put_row, migration 205) with
--                                         the transaction's stamp. A move that also changes the key is stamped by the table's own stamp trigger (190) as before.
--   order_stamp_follow_parent()           BEFORE UPDATE OF parent_id, same condition: order_stamp (the tie rule among equal keys, migration 200) becomes the stamp of that write,
--                                         the stamp `sort` now carries. order_stamp_set (200 / 204) is untouched: it still runs when the key changes.
--   Both stand aside while a snapshot or a merge is written (sync_import_active), like every stamp trigger.
--   sync_set_sorted(jsonb), workspaces_sets_sorted()   BEFORE INSERT OR UPDATE OF modules_off, modules_confirmed: the two module sets are stored sorted and without repeats.
--                                         Their elements now travel one by one (src/spine/stampedMerge/dbUnits.ts JSON_SOURCES, shape "set"), and a merge writes the set back sorted;
--                                         a local write sorted the same way makes the same elements the same bytes on every node. Only rows written from now on: an existing
--                                         unsorted array stays as it is (every node that holds it got it from the same snapshot, in the same order).
--   sync_touch_after_json()               AFTER UPDATE OF tag_schema: a note's `updated_at` is again the function of its stamps (sync_touch_updated_at) once the json trigger has stamped the keys.
--
-- WHAT THIS CHANGES IN BEHAVIOUR (one redefinition)
--   sync_touch_updated_at (206)           also counts the stamps of the keys of a note's tag schema (label content_nodes.tag_schema): they travel in a change bundle now (batch 2b-2a), and the
--                                         write path already moves `updated_at` when it changes the schema (services/functionRefs.ts addFunction writes tag_schema.extends). Before, the node
--                                         that wrote kept its own `updated_at` and a node that took the bundle kept an older one: a value that was not a function of what replicates.
--                                         Everything else of the function is 206's text. collection_views is not counted: it does not travel yet (NOT_CARRIED_YET).
--   sync_stamp_attribute_trigger (205)    no longer stamps each section of a board's section frames (label node_attributes._canvas_sections, migration 199). The frames
--                                         are the text of the attribute `value`, which is a unit of its own and travels; the per-section stamps were a second unit over the
--                                         same data that no reader uses (no query, history or view reads them: `git grep` in PR #1778) and no bundle carries, so two nodes
--                                         with the same boards had different stamps. The structure log lines of the frames are kept. Everything else is 205's text.
--   sync_genesis_pass (202)               the same: its per-section step is gone (a browser node runs the pass at its first start). Everything else is 202's text.
--
-- WHAT THIS DOES NOT DO, on purpose
--   * no existing stamp or order_stamp is rewritten. A note moved before this migration without a new key keeps a `sort` stamp older than its `parent` stamp: the merge core
--     reads such a pair as before (rules/place.ts: when the winning parent write is not among the writes to `sort`, the best head of `sort` is shown). No exchange happened before.
--   * the per-section stamps already written are neither deleted nor rewritten. They are left as they are, and nothing copies or compares them: the digest, the snapshot
--     and the change bundle read only the labels they list, and src/spine/snapshotTables.ts RETIRED_STAMP_LABELS names this one (left before 2026-11, no longer made).
--   * no existing `updated_at` is rewritten: the new sync_touch_updated_at runs at a note's next write. The preview counts the notes for which it would then give another
--     value than 206's (tags whose schema keys were written after their last counted unit).
--   * note_pointers need nothing: a pointer's parent is part of its id (migration 194 note_pointer_derive_id), so a pointer under another parent is another row.
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: re-run 205's sync_stamp_attribute_trigger and 202's sync_genesis_pass; DROP TRIGGER content_nodes_sync_stamp_place, content_nodes_order_stamp_parent,
-- content_nodes_tag_schema_touch ON content_nodes; DROP TRIGGER workspaces_sets_sorted ON workspaces; DROP FUNCTION sync_stamp_place_with_parent(), order_stamp_follow_parent(),
-- sync_touch_after_json(), workspaces_sets_sorted(), sync_set_sorted(jsonb); re-run 206's sync_touch_updated_at.
-- drill: no allowance needed. This migration writes no row.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; counts only):
--
--   SELECT 'notes whose parent stamp is newer than their order-key stamp (read as before, not rewritten)' AS part, count(*)::bigint AS rows, 0::bigint AS est_bytes
--     FROM sync_stamps p JOIN sync_stamps s ON s.workspace_id = p.workspace_id AND s.table_name = p.table_name AND s.row_key = p.row_key AND s.field = 'sort'
--    WHERE p.table_name = 'content_nodes' AND p.field = 'parent' AND (p.hlc_wall, p.hlc_counter) > (s.hlc_wall, s.hlc_counter)
--   UNION ALL
--   SELECT 'notes whose updated_at the new definition gives differently at their next write', count(*)::bigint, 0::bigint FROM (
--     SELECT n.id,
--            (SELECT max(w) FROM (SELECT hlc_wall AS w FROM sync_stamps s WHERE s.workspace_id = n.workspace_id AND s.table_name = 'content_nodes' AND s.row_key = n.id::text AND s.origin <> 'genesis' AND s.field NOT IN ('*', 'sort') AND COALESCE(s.meta->>'quiet', '') <> 'true'
--                                 UNION ALL SELECT hlc_wall FROM sync_stamp_heads h WHERE h.workspace_id = n.workspace_id AND h.table_name = 'content_nodes' AND h.row_key = n.id::text AND h.origin <> 'genesis' AND h.field NOT IN ('*', 'sort') AND COALESCE(h.meta->>'quiet', '') <> 'true') x) AS old_wall,
--            (SELECT max(w) FROM (SELECT hlc_wall AS w FROM sync_stamps s WHERE s.workspace_id = n.workspace_id AND s.table_name IN ('content_nodes', 'content_nodes.tag_schema') AND s.row_key = n.id::text AND s.origin <> 'genesis' AND s.field NOT IN ('*', 'sort') AND COALESCE(s.meta->>'quiet', '') <> 'true'
--                                 UNION ALL SELECT hlc_wall FROM sync_stamp_heads h WHERE h.workspace_id = n.workspace_id AND h.table_name IN ('content_nodes', 'content_nodes.tag_schema') AND h.row_key = n.id::text AND h.origin <> 'genesis' AND h.field NOT IN ('*', 'sort') AND COALESCE(h.meta->>'quiet', '') <> 'true') x) AS new_wall
--       FROM content_nodes n) d
--    WHERE d.new_wall > 0 AND d.old_wall IS DISTINCT FROM d.new_wall
--   UNION ALL
--   SELECT 'per-section stamps of board frames left as they are (no longer made, not copied)', (SELECT count(*) FROM sync_stamps WHERE table_name = 'node_attributes._canvas_sections')
--          + (SELECT count(*) FROM sync_stamp_heads WHERE table_name = 'node_attributes._canvas_sections'), 0
--   UNION ALL SELECT 'sync_stamps rows rewritten', 0, 0
--   ;

CREATE OR REPLACE FUNCTION sync_stamp_place_with_parent() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  PERFORM sync_stamp_put_row(NEW.workspace_id, 'content_nodes', NEW.id::text, 'sort', false, sync_stamp_current(NEW.workspace_id), OLD, 'order_key');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_place AFTER UPDATE OF parent_id ON content_nodes FOR EACH ROW
  WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id AND OLD.order_key IS NOT DISTINCT FROM NEW.order_key)
  EXECUTE FUNCTION sync_stamp_place_with_parent();

CREATE OR REPLACE FUNCTION order_stamp_follow_parent() RETURNS trigger AS $$
DECLARE s jsonb;
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NEW; END IF;
  s := sync_stamp_current(NEW.workspace_id);
  NEW.order_stamp := lpad(s->>'wall', 15, '0') || lpad(s->>'counter', 6, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER content_nodes_order_stamp_parent BEFORE UPDATE OF parent_id ON content_nodes FOR EACH ROW
  WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id AND OLD.order_key IS NOT DISTINCT FROM NEW.order_key)
  EXECUTE FUNCTION order_stamp_follow_parent();

-- A note's `updated_at` is a function of the stamps that replicate (206): the largest wall time (ms) among the stamps of the row's units that COUNT as an edit, now also the keys of its tag schema.
CREATE OR REPLACE FUNCTION sync_touch_updated_at(p_ws uuid, p_key text) RETURNS void AS $$
DECLARE v_wall bigint;
BEGIN
  SELECT max(w) INTO v_wall FROM (
    SELECT hlc_wall AS w FROM sync_stamps WHERE workspace_id = p_ws AND table_name IN ('content_nodes', 'content_nodes.tag_schema') AND row_key = p_key AND origin <> 'genesis' AND field NOT IN ('*', 'sort') AND COALESCE(meta->>'quiet', '') <> 'true'
    UNION ALL SELECT hlc_wall FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name IN ('content_nodes', 'content_nodes.tag_schema') AND row_key = p_key AND origin <> 'genesis' AND field NOT IN ('*', 'sort') AND COALESCE(meta->>'quiet', '') <> 'true') x;
  IF v_wall IS NOT NULL AND v_wall > 0 THEN
    UPDATE content_nodes SET updated_at = to_timestamp(v_wall / 1000.0) WHERE id = p_key::uuid AND workspace_id = p_ws AND updated_at IS DISTINCT FROM to_timestamp(v_wall / 1000.0);
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_touch_after_json() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  PERFORM sync_touch_updated_at(NEW.workspace_id, NEW.id::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- named to run after content_nodes_tag_schema_stamp_update (AFTER triggers run in name order): the keys are stamped first
CREATE OR REPLACE TRIGGER content_nodes_tag_schema_touch AFTER UPDATE OF tag_schema ON content_nodes FOR EACH ROW
  WHEN (OLD.tag_schema IS DISTINCT FROM NEW.tag_schema)
  EXECUTE FUNCTION sync_touch_after_json();

-- A set of module ids (an array of strings) as it is stored: sorted by byte, each id once. Anything that is not an array is left as it is.
CREATE OR REPLACE FUNCTION sync_set_sorted(p jsonb) RETURNS jsonb AS $$
  SELECT CASE WHEN jsonb_typeof(p) = 'array'
    THEN COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e COLLATE "C") FROM (SELECT DISTINCT e FROM jsonb_array_elements_text(p) e) x), '[]'::jsonb)
    ELSE p END;
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION workspaces_sets_sorted() RETURNS trigger AS $$
BEGIN
  NEW.modules_off := sync_set_sorted(NEW.modules_off);
  NEW.modules_confirmed := sync_set_sorted(NEW.modules_confirmed);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER workspaces_sets_sorted BEFORE INSERT OR UPDATE OF modules_off, modules_confirmed ON workspaces FOR EACH ROW
  EXECUTE FUNCTION workspaces_sets_sorted();

-- A board's section frames are one unit, the attribute's `value` (it travels in a change bundle like any attribute). From now on the attribute trigger stamps only that
-- unit; until now it also stamped each section (label node_attributes._canvas_sections, migration 199), a second kind of unit over the same data that nothing reads and
-- nothing copies (src/spine/snapshotTables.ts RETIRED_STAMP_LABELS). The text below is 205's, without the three per-section calls; the structure log lines stay.
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
    END IF;
  ELSIF op = 'DELETE' THEN
    v_seen := sync_row_seen(ws, 'node_attributes', rkey); -- before the fields' stamps go
    DELETE FROM sync_stamps WHERE workspace_id = ws AND table_name = 'node_attributes' AND row_key = rkey AND field <> '*';
    DELETE FROM sync_stamp_heads WHERE workspace_id = ws AND table_name = 'node_attributes' AND row_key = rkey AND field <> '*';
    PERFORM sync_stamp_put_over(ws, 'node_attributes', rkey, '*', true, s, NULL, false, v_seen);
    IF attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NULL, s, false);
    END IF;
  ELSE
    IF value_changed THEN PERFORM sync_stamp_put_row(ws, 'node_attributes', rkey, 'value', false, s, OLD, 'value'); END IF;
    IF OLD.value_type IS DISTINCT FROM NEW.value_type THEN PERFORM sync_stamp_put_row(ws, 'node_attributes', rkey, 'type', false, s, OLD, 'value_type'); END IF;
    IF OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable THEN PERFORM sync_stamp_put_row(ws, 'node_attributes', rkey, 'inheritable', false, s, OLD, 'is_inheritable'); END IF;
    IF value_changed AND attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NEW.value, s, false);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The genesis pass (202) is 202's text without the per-section step: a database that runs it from now on (a browser node at its first start, src/browser/nodeIdentity.ts)
-- gives no section its own stamp either.
CREATE OR REPLACE FUNCTION sync_genesis_pass() RETURNS TABLE (stamps_added bigint, baseline_lines_added bigint, markers_added bigint, rows_skipped bigint) AS $fn$
DECLARE
  v_step record;
  v_added bigint;
  v_skipped bigint;
  v_stamps bigint := 0;
  v_lines bigint := 0;
  v_skips bigint := 0;
  v_marks jsonb := '[]'::jsonb;
  v_n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
              WHERE NOT t.tgisinternal AND p.proname LIKE 'sync\_%trigger'
                AND p.proname NOT IN ('sync_stamp_trigger', 'sync_stamp_json_trigger', 'sync_stamp_attribute_trigger')) THEN
    RAISE EXCEPTION '202 (sync_genesis_pass): a stamp trigger function this migration does not know is installed; extend the plan before running it';
  END IF;

  FOR v_step IN
    WITH trg AS (
      SELECT c.relname::text AS tbl, p.proname::text AS fn,
             string_to_array(encode(t.tgargs, 'escape'), '\000') AS a,
             (regexp_match(pg_get_triggerdef(t.oid), ' WHEN \((.*)\) EXECUTE FUNCTION '))[1] AS wh
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND pg_table_is_visible(c.oid)
         AND (t.tgtype & 5) = 5 AND (t.tgtype & 2) = 0
         AND p.proname IN ('sync_stamp_trigger', 'sync_stamp_json_trigger', 'sync_stamp_attribute_trigger')
    ),
    g AS (
      SELECT trg.*,
             CASE WHEN a[3] LIKE 'via:%'
                    THEN 'COALESCE(' || (SELECT string_agg(format('(SELECT n.workspace_id FROM content_nodes n WHERE n.id = t.%I)', c), ', ' ORDER BY o)
                                           FROM unnest(string_to_array(substr(a[3], 5), ',')) WITH ORDINALITY AS u(c, o)) || ')'
                  WHEN a[3] LIKE 'space:%' THEN format('(SELECT s.workspace_id FROM spaces s WHERE s.id = t.%I)', substr(a[3], 7))
                  ELSE format('t.%I', a[3]) END AS ws_sql,
             (SELECT string_agg(format('t.%I::text', c), ' || ''/'' || ' ORDER BY o)
                FROM unnest(string_to_array(a[2], ',')) WITH ORDINALITY AS u(c, o)) AS key_sql,
             (SELECT string_agg(format('t.%I::text', c), ' || ''/'' || ' ORDER BY o)
                FROM unnest(string_to_array(COALESCE(NULLIF(a[6], ''), a[2]), ',')) WITH ORDINALITY AS u(c, o)) AS log_key_sql,
             COALESCE(regexp_replace(wh, '\mnew\.', 't.', 'gi'), 'true') AS when_sql,
             CASE WHEN COALESCE(a[8], '') = '' THEN 'true'
                  ELSE format('t.%I::text IS NOT DISTINCT FROM %L', split_part(a[8], '=', 1), split_part(a[8], '=', 2)) END AS filter_sql
        FROM trg WHERE fn <> 'sync_stamp_attribute_trigger'
    ),
    fields AS (
      SELECT g.*, left(x.spec, x.cut - 1) AS fld, substr(x.spec, x.cut, 1) AS kind, substr(x.spec, x.cut + 1) AS col
        FROM g
       CROSS JOIN LATERAL (SELECT s.spec, least(NULLIF(position('=' IN s.spec), 0), NULLIF(position('~' IN s.spec), 0),
                                                NULLIF(position('@' IN s.spec), 0), NULLIF(position('^' IN s.spec), 0)) AS cut
                             FROM unnest(string_to_array(g.a[5], ',')) AS s(spec)) x
       WHERE g.fn = 'sync_stamp_trigger' AND COALESCE(g.a[5], '') <> ''
    ),
    plan AS (
      SELECT 'stamps' AS part, a[1] AS table_name, 'row' AS unit,
             format('SELECT %s AS ws, %L AS tn, %s AS rk, %L AS fld, NULL::text AS nv FROM %I t WHERE %s',
                    ws_sql, a[1], key_sql, '*', tbl, when_sql) AS src_sql
        FROM g WHERE fn = 'sync_stamp_trigger'
      UNION ALL
      SELECT 'stamps', a[1], a[6] || '*',
             format('SELECT %s AS ws, %L AS tn, %s AS rk, %L || u.k AS fld, NULL::text AS nv FROM %I t CROSS JOIN LATERAL sync_json_units(t.%I::jsonb, %L) u WHERE %s',
                    ws_sql, a[1], key_sql, a[6], tbl, a[4], a[5], when_sql)
        FROM g WHERE fn = 'sync_stamp_json_trigger'
      UNION ALL
      SELECT 'stamps', 'node_attributes', 'row (a person or automation wrote it)',
             'SELECT t.workspace_id AS ws, ''node_attributes'' AS tn, t.node_id::text || ''/'' || t.key AS rk, ''*'' AS fld, NULL::text AS nv FROM node_attributes t WHERE t.source IN (''ui'', ''explicit'', ''dispatcher'')'
        FROM trg WHERE fn = 'sync_stamp_attribute_trigger' AND tbl = 'node_attributes'
      UNION ALL
      SELECT 'structure baseline', a[1], fld,
             format('SELECT %s AS ws, %L AS tn, %s AS rk, %L AS fld, %s AS nv FROM %I t WHERE %s AND %s',
                    ws_sql, a[1], log_key_sql, fld,
                    CASE WHEN kind = '=' AND fld = 'deleted' THEN format('(t.%I IS NOT NULL)::text', col)
                         WHEN kind = '@' OR (kind = '=' AND position('+' IN col) > 0)
                           THEN 'jsonb_build_object(' || (SELECT string_agg(format('%L, t.%I', c, c), ', ' ORDER BY o)
                                                            FROM unnest(string_to_array(col, '+')) WITH ORDINALITY AS u(c, o)) || ')::text'
                         ELSE format('t.%I::text', col) END,
                    tbl, when_sql, filter_sql)
        FROM fields
      UNION ALL
      SELECT 'structure baseline', a[7], a[8] || '*',
             format('SELECT %s AS ws, %L AS tn, %s AS rk, %L || u.k AS fld, u.v::text AS nv FROM %I t CROSS JOIN LATERAL sync_json_units(t.%I::jsonb, %L) u WHERE %s',
                    ws_sql, a[7], key_sql, a[8], tbl, a[4], a[5], when_sql)
        FROM g WHERE fn = 'sync_stamp_json_trigger' AND COALESCE(a[7], '') <> ''
      UNION ALL
      SELECT 'structure baseline', 'node_attributes', 'sections',
             'SELECT t.workspace_id AS ws, ''node_attributes'' AS tn, t.node_id::text || ''/'' || t.key AS rk, ''sections'' AS fld, t.value AS nv FROM node_attributes t WHERE t.key = ''_canvas_sections'' AND t.source IN (''ui'', ''explicit'', ''dispatcher'')'
        FROM trg WHERE fn = 'sync_stamp_attribute_trigger' AND tbl = 'node_attributes'
    )
    SELECT DISTINCT part, table_name, unit, src_sql FROM plan ORDER BY part, table_name, unit
  LOOP
    IF v_step.part = 'stamps' THEN
      EXECUTE format('WITH u AS MATERIALIZED (%s),
                           ins AS (INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted)
                                   SELECT u.ws, u.tn, u.rk, u.fld, ''genesis'', 0, 0, 0, NULL, NULL, false FROM u
                                    WHERE u.ws IS NOT NULL AND u.rk IS NOT NULL
                                   ON CONFLICT (workspace_id, table_name, row_key, field) DO NOTHING RETURNING 1)
                      SELECT (SELECT count(*) FROM ins), (SELECT count(*) FROM u WHERE u.ws IS NULL OR u.rk IS NULL)', v_step.src_sql)
        INTO v_added, v_skipped;
      v_stamps := v_stamps + v_added;
    ELSE
      v_marks := v_marks || jsonb_build_array(jsonb_build_array(v_step.table_name, v_step.unit));
      EXECUTE format('WITH u AS MATERIALIZED (%1$s),
                           ins AS (INSERT INTO structure_log (workspace_id, table_name, row_key, field, old_value, new_value, origin, seq, hlc_wall, hlc_counter, author, device)
                                   SELECT u.ws, u.tn, u.rk, u.fld, NULL, u.nv, ''genesis'', 0, 0, 0, NULL, NULL FROM u
                                    WHERE u.ws IS NOT NULL AND u.rk IS NOT NULL
                                      AND NOT EXISTS (SELECT 1 FROM structure_log m WHERE m.workspace_id = u.ws AND m.table_name = ''baseline''
                                                         AND m.row_key = %2$L AND m.field = %3$L) RETURNING 1)
                      SELECT (SELECT count(*) FROM ins), (SELECT count(*) FROM u WHERE u.ws IS NULL OR u.rk IS NULL)', v_step.src_sql, v_step.table_name, v_step.unit)
        INTO v_added, v_skipped;
      v_lines := v_lines + v_added;
    END IF;
    IF v_skipped > 0 THEN
      v_skips := v_skips + v_skipped;
      RAISE NOTICE 'sync_genesis_pass: % row(s) of % (%) have no workspace or a NULL key and were skipped', v_skipped, v_step.table_name, v_step.unit;
    END IF;
  END LOOP;

  -- The markers that say a workspace's baseline of a unit kind is taken (and, on the next call, that it is not taken again).
  INSERT INTO structure_log (workspace_id, table_name, row_key, field, old_value, new_value, origin, seq, hlc_wall, hlc_counter, author, device)
  SELECT w.id, 'baseline', s.t, s.u, NULL, NULL, 'genesis', 0, 0, 0, NULL, NULL
    FROM workspaces w
   CROSS JOIN (SELECT DISTINCT e->>0 AS t, e->>1 AS u FROM jsonb_array_elements(v_marks) e) s
   WHERE NOT EXISTS (SELECT 1 FROM structure_log m WHERE m.workspace_id = w.id AND m.table_name = 'baseline' AND m.row_key = s.t AND m.field = s.u);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN QUERY SELECT v_stamps, v_lines, v_n, v_skips;
END
$fn$ LANGUAGE plpgsql;
