-- 223: the values a note's text gives it are stamped and travel (batch 4a of docs/architecture/proposals/own-node-transport-2026-11-22.md, §2.12.1 option (b)).
--
-- WHY. After a body is saved, the dispatcher writes the values the text names (`key:: value`, source 'markdown'; YAML frontmatter, source 'frontmatter';
-- services/nodes.ts syncAttributesAndDispatch / syncFrontmatterAttributes) in their own root transaction. The stamp trigger stamped only 'ui', 'explicit' and
-- 'dispatcher' rows, and a change bundle carried only those (src/spine/stampedMerge/dbUnits.ts `where`), so a node that took the body never had the values:
-- a view filtered by `due` differed, and `[[X]]` never reached a note whose frontmatter says `aliases: [X]` (services/wikilinkEdges.ts reads aliases).
-- Deriving them again on the receiving node cannot work: the derivation only adds (services/nodes.ts: "Markdown represents additions"), so what a node holds
-- depends on which bodies it saw, not on the replicated state. From now on these two sources are units like any other attribute write: the write that the
-- dispatcher made on the node where the text was saved travels, and a receiver never derives them (src/services/receivedDerivation.ts).
--
-- WHAT THIS ADDS
--   sync_attribute_source_stamped(text)   THE ONE SQL definition of which `node_attributes.source` values are units (src/spine/attributeSource.ts
--                                         STAMPED_ATTRIBUTE_SOURCES is the TypeScript side; test/stampedAttributeSources.integration.test.ts compares the two,
--                                         and spine/snapshotTables.json's `where` of node_attributes, with the function in the database).
-- WHAT THIS CHANGES IN BEHAVIOUR (two redefinitions, otherwise the text of 209)
--   sync_stamp_attribute_trigger (209)    stamps rows whose source is 'markdown' or 'frontmatter' too. A source flip between two stamped sources is an UPDATE of the row
--                                         (as ui <-> dispatcher was); a flip to or from 'derived' still counts as made / removed.
--   sync_genesis_pass (209)               gives the existing 'markdown' and 'frontmatter' rows their genesis stamp, as it does for every stamped row; it is run once below.
--   sync_revive_text_attribute_rows()     NEW, run once below before the genesis pass: a 'markdown' / 'frontmatter' row whose `*` stamp is a tombstone (a flip from
--                                         'dispatcher' before this migration counted as a removal) gets a live `*` with this transaction's stamp (see the function).
--
-- WHAT THIS DOES NOT DO, on purpose
--   * no row is changed: the pass only adds genesis stamps (sync_stamps rows with origin 'genesis'), which never leave this node (spine/stampedBundle.ts); the rows left
--     with a tombstone get a real stamp of this node (it travels: it is what makes the row live again where the tombstone went).
--   * 'derived' rows (a field's default, `_block_autotag`, the import's `_import_*`) stay unstamped: what of them a receiver needs is worked out again or is batch 4b.
--   * `source` itself is not a unit (a flip ui -> markdown with the same value writes no stamp): listed for batch 5 (§2.12.4, every column with a writer).
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: re-run 209's sync_stamp_attribute_trigger and sync_genesis_pass, DELETE the genesis
-- stamps of node_attributes rows whose source is 'markdown' or 'frontmatter', DROP FUNCTION sync_attribute_source_stamped(text) and sync_revive_text_attribute_rows().
-- drill: no allowance needed. This migration changes no row of user data; it adds genesis stamps, and a stamp of this node for each row a tombstone named.
--
-- Read-only preview for the production database (SELECT only; counts only):
--
--   SELECT source, count(*) AS rows_that_get_a_genesis_stamp FROM node_attributes WHERE source IN ('markdown', 'frontmatter') GROUP BY source;
--   SELECT count(*) AS live_rows_with_a_tombstone FROM node_attributes a JOIN sync_stamps s ON s.table_name = 'node_attributes' AND s.row_key = a.node_id || '/' || a.key
--     AND s.field = '*' AND s.deleted WHERE a.source IN ('markdown', 'frontmatter');

CREATE OR REPLACE FUNCTION sync_attribute_source_stamped(p_source text) RETURNS boolean AS $$
  SELECT p_source IN ('ui', 'explicit', 'dispatcher', 'markdown', 'frontmatter');
$$ LANGUAGE sql IMMUTABLE;

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
  IF TG_OP <> 'INSERT' THEN old_kept := sync_attribute_source_stamped(OLD.source); END IF;
  IF TG_OP <> 'DELETE' THEN new_kept := sync_attribute_source_stamped(NEW.source); END IF;
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
             'SELECT t.workspace_id AS ws, ''node_attributes'' AS tn, t.node_id::text || ''/'' || t.key AS rk, ''*'' AS fld, NULL::text AS nv FROM node_attributes t WHERE sync_attribute_source_stamped(t.source)'
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
             'SELECT t.workspace_id AS ws, ''node_attributes'' AS tn, t.node_id::text || ''/'' || t.key AS rk, ''sections'' AS fld, t.value AS nv FROM node_attributes t WHERE t.key = ''_canvas_sections'' AND sync_attribute_source_stamped(t.source)'
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

-- A row that is live while its `*` stamp says it is gone (review of PR #1941, round 1, point 2). Before this migration a flip of `source` from a stamped source
-- ('dispatcher') to 'markdown' or 'frontmatter' counted as the row removed (209's trigger: the old source was stamped, the new one not): the row's `*` became a tombstone
-- and its field stamps went. Now that both sources are stamped such a row is a unit whose creation says it was deleted: a bundle would carry it as a row with a deleted
-- `*`. Each such row is made again here, as the trigger stamps a row made now: a live `*` with this transaction's stamp, which covers the tombstone (a creation after a
-- delete), so every node that took the tombstone takes the row back. Returns how many rows it gave a live `*`. Writes stamps only (no row, no note's updated_at:
-- sync_touch_updated_at reads the stamps of content_nodes only).
CREATE OR REPLACE FUNCTION sync_revive_text_attribute_rows() RETURNS bigint AS $$
DECLARE r record; n bigint := 0;
BEGIN
  FOR r IN
    SELECT a.workspace_id AS ws, a.node_id::text || '/' || a.key AS rk
      FROM node_attributes a
      JOIN sync_stamps s ON s.workspace_id = a.workspace_id AND s.table_name = 'node_attributes' AND s.row_key = a.node_id::text || '/' || a.key AND s.field = '*' AND s.deleted
     WHERE sync_attribute_source_stamped(a.source)
     ORDER BY 1, 2
  LOOP
    PERFORM sync_stamp_put_over(r.ws, 'node_attributes', r.rk, '*', false, sync_stamp_current(r.ws), NULL, false);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- the rows that exist today: a live creation for the rows a flip from 'dispatcher' left with a tombstone, then genesis stamps for the two sources that are units from now on
SELECT sync_revive_text_attribute_rows();
SELECT * FROM sync_genesis_pass();
