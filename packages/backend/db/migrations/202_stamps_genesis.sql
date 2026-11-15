-- 202: every row that exists today gets a genesis write stamp, and the structure change log gets a baseline
-- (causal-stamps proposal §6 and §8 S5, §8.5 "baseline"). Records only: nothing reads a stamp or the log to decide anything, so
-- what a user sees does not change.
--
-- WHAT THIS ADDS (rows in two side tables; no other table is written):
--   sync_stamps     one stamp for every unit the stamp triggers (190, 194, 198, 199, 201, and any later one) would stamp when the
--                   unit is made, and that has no stamp yet. The stamp is the genesis stamp: origin 'genesis', seq 0, clock 0/0,
--                   no author, no device, not a tombstone. The same constants as the earlier sync engine's genesis ops
--                   (distributedSync/types.ts GENESIS_ORIGIN, GENESIS_HLC), nothing taken from this node (no now(), no random value,
--                   no node id, no sequence number), so two nodes that each run this on the same data write the same rows.
--                   Every real stamp has a wall clock > 0, so any later write beats a genesis stamp under the clock rule.
--   structure_log   the structure the notes, tags, cards, members and switches have today, one line per unit with the old value NULL
--                   and the new value what the INSERT trigger would have logged (parent, space and deleted state of a note; the
--                   order key too once migration 200 is applied; tag applications; board cards and section frames; space members
--                   and capability switches), stamped genesis, plus one marker line per workspace and unit kind (table 'baseline',
--                   row_key the table, field the unit kind) that says that baseline of that workspace was taken. A day before the marker's `at` cannot be
--                   rebuilt from this log (proposal §8.5); every day after it can.
--
-- WHICH UNITS ARE STAMPED (the stamp shape of each is the shape its trigger writes on INSERT; a unit is stamped only if it has no stamp):
--   content_nodes, node_tags, block_node_tags, note_pointers, node_positions, node_edges (origin 'manual' only), spaces, space_members,
--   workspaces, function_refs, rss_mutes, rss_subscriptions, external_calendars, actor_module_settings     the row ('*')
--   node_attributes                        the row, only a value a person or automation wrote (source ui / explicit / dispatcher)
--   content_nodes.tag_schema / .collection_views, spaces.capabilities, function_refs.config, workspaces.modules_off / .modules_confirmed
--                                          each key, view, switch or module (field 'key:<k>', 'view:<id>', 'switch:<k>', 'off:<m>', 'confirmed:<m>')
--   node_attributes._canvas_sections       each section frame of a board (field 'section:<id>')
-- Nothing in this list is written down: the units are found in the database catalog. The migration reads every INSERT trigger that
-- runs sync_stamp_trigger / sync_stamp_json_trigger / sync_stamp_attribute_trigger (its arguments say the table, key, workspace,
-- JSON column and structure fields; its WHEN says which rows) and stamps what that trigger would stamp. A table or field a later
-- migration wires up, or a column a trigger starts to watch (order_key), is covered without editing this file; a trigger function
-- of this family it does not know makes it stop with an error instead of skipping the table (the preview lists it).
--
-- WHAT THIS DOES NOT DO, on purpose:
--   * a stamp that exists is not touched (ON CONFLICT DO NOTHING), whatever it says, tombstones included. A unit whose row exists but
--     whose only stamp is a field stamp (a row made before 190 and edited since) gets the '*' stamp; the field stamp keeps its own.
--   * no tombstone for a row that was deleted before its table was wired: the database does not know it existed (see the PR).
--   * node_attributes whose source is markdown / frontmatter (the note's text produces them) or derived (computed) get no genesis
--     stamp: every node works them out again. The ones a new note inherits when it is made are stamped by the application at that moment, so they have a stamp already.
--   * rows the stamp triggers do not cover (block_anchors, block_link_bindings, focus_sessions, review_states, actor_prefs, rss_seen are
--     classified 'stamped' in src/spine/syncClasses.json but have no trigger yet): nothing to read, nothing added.
--   * no event, no sync_clock change (the local logical clock is not advanced), no workspaces.membership_epoch change, no outbox job.
--     The stamps are new rows in a table nothing reads yet, so no device has anything to re-read.
--   * content_nodes.order_stamp (migration 200) and sort_order stay as they are.
--   * the triggers are not switched off: nothing here writes a table that has a stamp trigger.
--
-- HOW: one function (sync_genesis_pass(), also callable by a later migration) run by one DO block, one transaction (migrate() gives each migration its own); it builds one INSERT ... SELECT per unit kind from the
-- plan query below (the same text as the preview's) and runs them. A failure rolls all of it back. Running it again changes nothing:
-- stamps are ON CONFLICT DO NOTHING and a unit kind with a baseline marker in a workspace is not baselined again, one without it (a table or column wired up later) is. Locks: the statements read the big tables
-- with plain reads (they do not block a writer) and insert only into sync_stamps and structure_log (RowExclusive, which blocks
-- no read and no write to other rows). Run it as migrations run, before the new backend serves; a writer that stamps the same
-- unit while it runs would only wait for this transaction to end.
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward; an older backend refuses a database with a migration it
-- does not know). If this had to be undone in place: DELETE FROM sync_stamps WHERE origin = 'genesis' removes the stamps (nothing
-- reads them); the baseline lines cannot be deleted (structure_log is append-only by trigger) and are harmless.
--
-- drill: no allowance needed. This migration writes only sync_stamps and structure_log, so every count, hash and structure scripts/
-- drillInvariants.ts compares (notes, tags, canvases, cards, ink, edges, tag applications, attributes, spaces, actors, events,
-- note bodies and titles) must be equal across it; it declares nothing in `allows`, and the drill also checks that the two side tables
-- only grew.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; uses only functions and
-- tables that exist before this migration; counts and byte estimates only, never a title, text, id or value).
-- One row per table and unit kind: how many units exist now (rows_now), how many already have a stamp / baseline (already_there),
-- how many this adds (will_add) and an estimate of the bytes that adds (est_bytes: heap row plus index entries, estimated as a fixed
-- overhead per row plus twice the length of the key columns that the index repeats; the two overheads, 196 and 235 bytes, were fitted to the
-- size pg_total_relation_size reported after the migration on a 20,000-note database, see the PR). `totals` rows give sync_stamps and structure_log as they are
-- today and what is added. A row of `part` = 'trigger this migration does not know' means: do not run it, the plan does not cover that
-- trigger. src/test/genesisStampsMigration.integration.test.ts runs this exact text and compares it, unit by unit, with what the
-- migration writes. `part` = stamps | structure baseline | totals | skipped (rows that cannot be placed: no workspace found or a NULL in the key; the migration reports them with a NOTICE and does not stamp them; any number above 0 should be understood before running) | left without a stamp on purpose (attribute rows whose source is text-produced or computed and that have no stamp: counted, not stamped).
--
--   WITH trg AS (
--     SELECT c.relname::text AS tbl, p.proname::text AS fn,
--            string_to_array(encode(t.tgargs, 'escape'), '\000') AS a,
--            (regexp_match(pg_get_triggerdef(t.oid), ' WHEN \((.*)\) EXECUTE FUNCTION '))[1] AS wh
--       FROM pg_trigger t
--       JOIN pg_class c ON c.oid = t.tgrelid
--       JOIN pg_proc p ON p.oid = t.tgfoid
--      WHERE NOT t.tgisinternal AND pg_table_is_visible(c.oid)
--        AND (t.tgtype & 5) = 5 AND (t.tgtype & 2) = 0
--        AND p.proname IN ('sync_stamp_trigger', 'sync_stamp_json_trigger', 'sync_stamp_attribute_trigger')
--   ),
--   g AS (
--     SELECT trg.*,
--            CASE WHEN a[3] LIKE 'via:%'
--                   THEN 'COALESCE(' || (SELECT string_agg(format('(SELECT n.workspace_id FROM content_nodes n WHERE n.id = t.%I)', c), ', ' ORDER BY o)
--                                          FROM unnest(string_to_array(substr(a[3], 5), ',')) WITH ORDINALITY AS u(c, o)) || ')'
--                 WHEN a[3] LIKE 'space:%' THEN format('(SELECT s.workspace_id FROM spaces s WHERE s.id = t.%I)', substr(a[3], 7))
--                 ELSE format('t.%I', a[3]) END AS ws_sql,
--            (SELECT string_agg(format('t.%I::text', c), ' || ''/'' || ' ORDER BY o)
--               FROM unnest(string_to_array(a[2], ',')) WITH ORDINALITY AS u(c, o)) AS key_sql,
--            (SELECT string_agg(format('t.%I::text', c), ' || ''/'' || ' ORDER BY o)
--               FROM unnest(string_to_array(COALESCE(NULLIF(a[6], ''), a[2]), ',')) WITH ORDINALITY AS u(c, o)) AS log_key_sql,
--            COALESCE(regexp_replace(wh, '\mnew\.', 't.', 'gi'), 'true') AS when_sql,
--            CASE WHEN COALESCE(a[8], '') = '' THEN 'true'
--                 ELSE format('t.%I::text IS NOT DISTINCT FROM %L', split_part(a[8], '=', 1), split_part(a[8], '=', 2)) END AS filter_sql
--       FROM trg WHERE fn <> 'sync_stamp_attribute_trigger'
--   ),
--   fields AS (
--     SELECT g.*, left(x.spec, x.cut - 1) AS fld, substr(x.spec, x.cut, 1) AS kind, substr(x.spec, x.cut + 1) AS col
--       FROM g
--      CROSS JOIN LATERAL (SELECT s.spec, least(NULLIF(position('=' IN s.spec), 0), NULLIF(position('~' IN s.spec), 0),
--                                               NULLIF(position('@' IN s.spec), 0), NULLIF(position('^' IN s.spec), 0)) AS cut
--                            FROM unnest(string_to_array(g.a[5], ',')) AS s(spec)) x
--      WHERE g.fn = 'sync_stamp_trigger' AND COALESCE(g.a[5], '') <> ''
--   ),
--   plan AS (
--     SELECT 'stamps' AS part, a[1] AS table_name, 'row' AS unit,
--            format('SELECT %s AS ws, %L AS tn, %s AS rk, %L AS fld, NULL::text AS nv FROM %I t WHERE %s',
--                   ws_sql, a[1], key_sql, '*', tbl, when_sql) AS src_sql
--       FROM g WHERE fn = 'sync_stamp_trigger'
--     UNION ALL
--     SELECT 'stamps', a[1], a[6] || '*',
--            format('SELECT %s AS ws, %L AS tn, %s AS rk, %L || u.k AS fld, NULL::text AS nv FROM %I t CROSS JOIN LATERAL sync_json_units(t.%I::jsonb, %L) u WHERE %s',
--                   ws_sql, a[1], key_sql, a[6], tbl, a[4], a[5], when_sql)
--       FROM g WHERE fn = 'sync_stamp_json_trigger'
--     UNION ALL
--     SELECT 'stamps', 'node_attributes', 'row (a person or automation wrote it)',
--            'SELECT t.workspace_id AS ws, ''node_attributes'' AS tn, t.node_id::text || ''/'' || t.key AS rk, ''*'' AS fld, NULL::text AS nv FROM node_attributes t WHERE t.source IN (''ui'', ''explicit'', ''dispatcher'')'
--       FROM trg WHERE fn = 'sync_stamp_attribute_trigger' AND tbl = 'node_attributes'
--     UNION ALL
--     SELECT 'stamps', 'node_attributes._canvas_sections', 'section:*',
--            'SELECT t.workspace_id AS ws, ''node_attributes._canvas_sections'' AS tn, t.node_id::text AS rk, ''section:'' || u.k AS fld, NULL::text AS nv FROM node_attributes t CROSS JOIN LATERAL sync_json_units(sync_text_jsonb(t.value), ''array'') u WHERE t.key = ''_canvas_sections'' AND t.source IN (''ui'', ''explicit'', ''dispatcher'')'
--       FROM trg WHERE fn = 'sync_stamp_attribute_trigger' AND tbl = 'node_attributes'
--     UNION ALL
--     SELECT 'structure baseline', a[1], fld,
--            format('SELECT %s AS ws, %L AS tn, %s AS rk, %L AS fld, %s AS nv FROM %I t WHERE %s AND %s',
--                   ws_sql, a[1], log_key_sql, fld,
--                   CASE WHEN kind = '=' AND fld = 'deleted' THEN format('(t.%I IS NOT NULL)::text', col)
--                        WHEN kind = '@' OR (kind = '=' AND position('+' IN col) > 0)
--                          THEN 'jsonb_build_object(' || (SELECT string_agg(format('%L, t.%I', c, c), ', ' ORDER BY o)
--                                                           FROM unnest(string_to_array(col, '+')) WITH ORDINALITY AS u(c, o)) || ')::text'
--                        ELSE format('t.%I::text', col) END,
--                   tbl, when_sql, filter_sql)
--       FROM fields
--     UNION ALL
--     SELECT 'structure baseline', a[7], a[8] || '*',
--            format('SELECT %s AS ws, %L AS tn, %s AS rk, %L || u.k AS fld, u.v::text AS nv FROM %I t CROSS JOIN LATERAL sync_json_units(t.%I::jsonb, %L) u WHERE %s',
--                   ws_sql, a[7], key_sql, a[8], tbl, a[4], a[5], when_sql)
--       FROM g WHERE fn = 'sync_stamp_json_trigger' AND COALESCE(a[7], '') <> ''
--     UNION ALL
--     SELECT 'structure baseline', 'node_attributes', 'sections',
--            'SELECT t.workspace_id AS ws, ''node_attributes'' AS tn, t.node_id::text || ''/'' || t.key AS rk, ''sections'' AS fld, t.value AS nv FROM node_attributes t WHERE t.key = ''_canvas_sections'' AND t.source IN (''ui'', ''explicit'', ''dispatcher'')'
--       FROM trg WHERE fn = 'sync_stamp_attribute_trigger' AND tbl = 'node_attributes'
--   )
--   ,
--   r AS (
--     SELECT p.part, p.table_name, p.unit,
--            (xpath('/row/total/text()', x.v))[1]::text::bigint AS total,
--            (xpath('/row/already/text()', x.v))[1]::text::bigint AS already,
--            (xpath('/row/skipped/text()', x.v))[1]::text::bigint AS skipped,
--            (xpath('/row/bytes/text()', x.v))[1]::text::bigint AS est_bytes
--       FROM (SELECT DISTINCT part, table_name, unit, src_sql FROM plan) p
--      CROSS JOIN LATERAL (SELECT query_to_xml(CASE WHEN p.part = 'stamps'
--         THEN format('SELECT count(*) AS total, count(*) FILTER (WHERE e) AS already, (SELECT count(*) FROM (%3$s) s WHERE s.ws IS NULL OR s.rk IS NULL) AS skipped, COALESCE(sum(196 + 2 * (octet_length(tn) + octet_length(rk) + octet_length(fld))) FILTER (WHERE NOT e), 0) AS bytes FROM (SELECT u.*, EXISTS (SELECT 1 FROM sync_stamps s WHERE s.workspace_id = u.ws AND s.table_name = u.tn AND s.row_key = u.rk AND s.field = u.fld) AS e FROM (%3$s) u WHERE u.ws IS NOT NULL AND u.rk IS NOT NULL) z', p.table_name, p.unit, p.src_sql)
--         ELSE format('SELECT count(*) AS total, count(*) FILTER (WHERE e) AS already, (SELECT count(*) FROM (%3$s) s WHERE s.ws IS NULL OR s.rk IS NULL) AS skipped, COALESCE(sum(235 + 2 * (octet_length(tn) + octet_length(rk)) + octet_length(fld) + COALESCE(octet_length(nv), 0)) FILTER (WHERE NOT e), 0) AS bytes FROM (SELECT u.*, EXISTS (SELECT 1 FROM structure_log m WHERE m.workspace_id = u.ws AND m.table_name = ''baseline'' AND m.row_key = %1$L AND m.field = %2$L) AS e FROM (%3$s) u WHERE u.ws IS NOT NULL AND u.rk IS NOT NULL) z', p.table_name, p.unit, p.src_sql)
--         END, false, true, '') AS v) x
--   )
--   SELECT part, table_name, unit, total AS rows_now, already AS already_there, total - already AS will_add, est_bytes
--     FROM r
--   UNION ALL
--   SELECT 'totals', 'sync_stamps', 'rows today | rows this adds', (SELECT count(*) FROM sync_stamps), NULL, COALESCE(sum(total - already), 0), COALESCE(sum(est_bytes), 0)
--     FROM r WHERE part = 'stamps'
--   UNION ALL
--   SELECT 'totals', 'structure_log', 'rows today | rows this adds (baseline lines and one marker per workspace and unit kind)', (SELECT count(*) FROM structure_log), NULL,
--          COALESCE(sum(total - already), 0) + (SELECT count(*) FROM workspaces w CROSS JOIN (SELECT DISTINCT table_name, unit FROM r WHERE part = 'structure baseline') s
--                                                 WHERE NOT EXISTS (SELECT 1 FROM structure_log m WHERE m.workspace_id = w.id AND m.table_name = 'baseline' AND m.row_key = s.table_name AND m.field = s.unit)),
--          COALESCE(sum(est_bytes), 0)
--     FROM r WHERE part = 'structure baseline'
--   UNION ALL
--   SELECT 'skipped (no workspace found, or a NULL in the key): not stamped', table_name, unit, skipped, NULL, 0, NULL FROM r WHERE skipped > 0
--   UNION ALL
--   SELECT 'left without a stamp on purpose', 'node_attributes', 'source ' || a.source, count(*), NULL, 0, NULL
--     FROM node_attributes a
--    WHERE a.source NOT IN ('ui', 'explicit', 'dispatcher')
--      AND NOT EXISTS (SELECT 1 FROM sync_stamps s WHERE s.workspace_id = a.workspace_id AND s.table_name = 'node_attributes' AND s.row_key = a.node_id::text || '/' || a.key AND s.field = '*')
--    GROUP BY a.source
--   UNION ALL
--   SELECT 'trigger this migration does not know (stop and ask)', p.proname::text, c.relname::text, 0, NULL, NULL, NULL
--     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
--    WHERE NOT t.tgisinternal AND p.proname LIKE 'sync\_%trigger'
--      AND p.proname NOT IN ('sync_stamp_trigger', 'sync_stamp_json_trigger', 'sync_stamp_attribute_trigger')
--   ORDER BY 1, 2, 3
--

-- The pass is a function so a later migration that wires up another table or column ends with one line: SELECT * FROM sync_genesis_pass().
-- It is idempotent and returns what it added. A stamp is added only where the unit has none (ON CONFLICT DO NOTHING). A baseline is taken
-- per workspace, table and field kind: a marker line (table_name 'baseline', row_key = the table, field = the unit kind) says "this
-- workspace's baseline of this unit kind is taken", so a table or column wired up later gets its baseline on the next call, and the
-- ones already taken are not repeated. Rows it cannot place (no workspace found, or a NULL in the key) are counted in rows_skipped and
-- reported with a NOTICE; the preview lists them by table.
-- A write that runs while this is open: stamps are unique by (workspace, table, row, field), so a writer's trigger on the same key waits
-- for this transaction and then replaces the genesis stamp (DO UPDATE), and a genesis stamp is never written over a stamp that is there
-- (DO NOTHING). structure_log has no unique key: a baseline line records the value as this statement saw it (READ COMMITTED), and a
-- concurrent writer that committed in between has its own line with a real stamp; a reader takes, per unit, the line with the greatest
-- clock (genesis is 0/0, so it never beats a real line), so the baseline can only be the oldest line of a unit, whatever its id says.
-- The preview in the header does not call this function (it has to run before it exists).
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
      SELECT 'stamps', 'node_attributes._canvas_sections', 'section:*',
             'SELECT t.workspace_id AS ws, ''node_attributes._canvas_sections'' AS tn, t.node_id::text AS rk, ''section:'' || u.k AS fld, NULL::text AS nv FROM node_attributes t CROSS JOIN LATERAL sync_json_units(sync_text_jsonb(t.value), ''array'') u WHERE t.key = ''_canvas_sections'' AND t.source IN (''ui'', ''explicit'', ''dispatcher'')'
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

DO $do$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM sync_genesis_pass();
  RAISE NOTICE '202: % genesis stamp(s) added; % baseline line(s) and % marker(s) added to structure_log; % row(s) skipped', r.stamps_added, r.baseline_lines_added, r.markers_added, r.rows_skipped;
END
$do$;
