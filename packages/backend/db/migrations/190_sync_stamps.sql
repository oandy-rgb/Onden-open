-- 190: write stamps (causal-stamps proposal §8, S1) and the structure change log (§8.5). Records only:
-- nothing reads these tables to decide anything, so what a user sees does not change.
--
--   sync_node        one row: this installation's node id (made the first time a write needs it).
--   sync_clock       one row per workspace: the next sequence number, the logical clock, and how many transactions wrote
--                    without a stamp from spine/mutate. Stamps only ever compare inside one workspace, and the write lock
--                    is per workspace too, so a long write in one workspace waits for nothing in another.
--   sync_stamps      for each row (and each tracked field of it) who last changed it: node, that node's sequence number,
--                    logical clock, author, device. field '*' is the whole row; deleted = true is the tombstone.
--   structure_log    append-only old -> new values of a note's parent, space and deleted state. Never sent anywhere.
--
-- sync_stamp_trigger() is the one generic trigger function; this migration attaches it to content_nodes only (S1).
-- spine/mutate.ts allocates one stamp per root transaction and passes it in the transaction setting
-- onden.stamp_<workspace id with _ for ->; a write that did not come through mutate gets a stamp made here with a NULL
-- author, and is counted. Both paths take the workspace's event-append lock (the one mutate() takes) BEFORE the
-- sync_clock row, so a transaction that wrote first and entered mutate() later cannot deadlock with one that did not.
-- A stamp from another node (spine/stamps.ts adoptForeignStamp) arrives through the same setting.
-- Existing rows get no stamp (S5 does that): a reader treats a missing stamp as "unknown", not as an error.
--
-- Rolling back to an older backend: it refuses to start on a database with a migration it does not know (db.ts);
-- after restoring the pre-upgrade backup nothing here exists. The trigger itself never reads anything the older code
-- could have changed, so a write made by older code could not fail on it.

CREATE TABLE IF NOT EXISTS sync_node (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  node_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_clock (
  workspace_id uuid PRIMARY KEY,
  next_seq bigint NOT NULL DEFAULT 1,
  hlc_wall bigint NOT NULL DEFAULT 0,
  hlc_counter integer NOT NULL DEFAULT 0,
  writes_without_mutate bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_stamps (
  workspace_id uuid NOT NULL,
  table_name text NOT NULL,
  row_key text NOT NULL,
  field text NOT NULL,
  origin text NOT NULL,
  seq bigint NOT NULL,
  hlc_wall bigint NOT NULL,
  hlc_counter integer NOT NULL,
  author text,
  device uuid,
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, table_name, row_key, field)
);

CREATE TABLE IF NOT EXISTS structure_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  table_name text NOT NULL,
  row_key text NOT NULL,
  field text NOT NULL,
  old_value text,
  new_value text,
  origin text NOT NULL,
  seq bigint NOT NULL,
  hlc_wall bigint NOT NULL,
  hlc_counter integer NOT NULL,
  author text,
  device uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS structure_log_row_idx ON structure_log (workspace_id, table_name, row_key, id);

CREATE OR REPLACE FUNCTION structure_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'structure_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER structure_log_no_update BEFORE UPDATE ON structure_log FOR EACH ROW EXECUTE FUNCTION structure_log_append_only();
CREATE OR REPLACE TRIGGER structure_log_no_delete BEFORE DELETE ON structure_log FOR EACH ROW EXECUTE FUNCTION structure_log_append_only();

-- Lock the workspace's clock row (making it, and the node row, the first time) and say what it holds. The workspace's
-- event-append lock comes first, the same key as spine/eventLock.ts, so every path takes the two locks in one order.
CREATE OR REPLACE FUNCTION sync_lock_clock(p_ws uuid) RETURNS TABLE (node_id text, next_seq bigint, hlc_wall bigint, hlc_counter integer) AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('event-append:' || p_ws::text));
  INSERT INTO sync_node (singleton, node_id) VALUES (true, gen_random_uuid()::text) ON CONFLICT (singleton) DO NOTHING;
  INSERT INTO sync_clock (workspace_id) VALUES (p_ws) ON CONFLICT (workspace_id) DO NOTHING;
  RETURN QUERY SELECT n.node_id, c.next_seq, c.hlc_wall, c.hlc_counter
                 FROM sync_clock c, sync_node n WHERE c.workspace_id = p_ws AND n.singleton FOR UPDATE OF c;
END;
$$ LANGUAGE plpgsql;

-- The stamp for a write that did not come through spine/mutate: same clock rule as src/hlc.ts tick()
-- (src/test/syncStamps.integration.test.ts checks the two agree). This is the database's own clock, spine/stamps.ts
-- reads the application's: on purpose, the clock rule (the larger of the two wins, else the counter goes up) takes
-- whichever is ahead, so a difference between the two machines' clocks never makes a stamp go backwards.
CREATE OR REPLACE FUNCTION sync_allocate_stamp(p_ws uuid) RETURNS jsonb AS $$
DECLARE
  c record;
  now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  new_wall bigint;
  new_counter integer;
BEGIN
  SELECT * INTO c FROM sync_lock_clock(p_ws);
  IF now_ms > c.hlc_wall THEN new_wall := now_ms; new_counter := 0;
  ELSE new_wall := c.hlc_wall; new_counter := c.hlc_counter + 1; END IF;
  UPDATE sync_clock SET next_seq = c.next_seq + 1, hlc_wall = new_wall, hlc_counter = new_counter,
                        writes_without_mutate = writes_without_mutate + 1 WHERE workspace_id = p_ws;
  RETURN jsonb_build_object('origin', c.node_id, 'seq', c.next_seq, 'wall', new_wall, 'counter', new_counter, 'bypass', true);
END;
$$ LANGUAGE plpgsql;

-- The setting that carries a workspace's stamp through the transaction.
CREATE OR REPLACE FUNCTION sync_stamp_setting(p_ws uuid) RETURNS text AS $$
  SELECT 'onden.stamp_' || replace(p_ws::text, '-', '_');
$$ LANGUAGE sql IMMUTABLE;

-- The workspace's stamp in this transaction: the one spine/stamps.ts set, or a new one (author NULL) made now and kept
-- for the rest of the transaction.
CREATE OR REPLACE FUNCTION sync_stamp_current(p_ws uuid) RETURNS jsonb AS $$
DECLARE s jsonb := NULLIF(current_setting(sync_stamp_setting(p_ws), true), '')::jsonb;
BEGIN
  IF s IS NULL THEN
    s := sync_allocate_stamp(p_ws);
    PERFORM set_config(sync_stamp_setting(p_ws), s::text, true);
  END IF;
  RETURN s;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_stamp_put(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb) RETURNS void AS $$
  INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted)
  VALUES (p_ws, p_table, p_key, p_field, s->>'origin', (s->>'seq')::bigint, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid, p_deleted)
  ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
    origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
    author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted;
$$ LANGUAGE sql;

-- A column of the row being changed, as text (NULL when the column is). Read one column at a time with dynamic SQL, not by
-- turning the whole row into jsonb: a note's body is large, and copying it twice on every title edit was the cost.
CREATE OR REPLACE FUNCTION sync_column(r anyelement, p_column text) RETURNS text AS $$
DECLARE v text;
BEGIN
  EXECUTE format('SELECT ($1).%I::text', p_column) INTO v USING r;
  RETURN v;
END;
$$ LANGUAGE plpgsql;

-- Did the column change? The field named 'deleted' counts only whether the column is set, the rest compare the value.
CREATE OR REPLACE FUNCTION sync_column_changed(o anyelement, n anyelement, p_field text, p_column text) RETURNS boolean AS $$
DECLARE changed boolean;
BEGIN
  IF p_field = 'deleted' THEN
    EXECUTE format('SELECT (($1).%1$I IS NULL) IS DISTINCT FROM (($2).%1$I IS NULL)', p_column) INTO changed USING o, n;
  ELSE
    EXECUTE format('SELECT ($1).%1$I IS DISTINCT FROM ($2).%1$I', p_column) INTO changed USING o, n;
  END IF;
  RETURN changed;
END;
$$ LANGUAGE plpgsql;

-- The value as logged in structure_log: 'true' / 'false' for the deleted state, the column's text otherwise.
CREATE OR REPLACE FUNCTION sync_logged_value(r anyelement, p_field text, p_column text) RETURNS text AS $$
  SELECT CASE WHEN p_field = 'deleted' THEN (sync_column(r, p_column) IS NOT NULL)::text ELSE sync_column(r, p_column) END;
$$ LANGUAGE sql;

-- Arguments: table label, key column, workspace column, tracked fields 'field=column,...' (each gets its own stamp when
-- it changes), structure fields 'field=column,...' (each gets an old -> new row in structure_log, or '').
CREATE OR REPLACE FUNCTION sync_stamp_trigger() RETURNS trigger AS $$
DECLARE
  tbl text := TG_ARGV[0];
  ws uuid;
  key text;
  s jsonb;
  spec text;
  fld text;
  col text;
  ov text;
  nv text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    ws := sync_column(OLD, TG_ARGV[2])::uuid; key := sync_column(OLD, TG_ARGV[1]);
  ELSE
    ws := sync_column(NEW, TG_ARGV[2])::uuid; key := sync_column(NEW, TG_ARGV[1]);
  END IF;
  s := sync_stamp_current(ws);

  IF TG_OP = 'INSERT' THEN
    PERFORM sync_stamp_put(ws, tbl, key, '*', false, s);
  ELSIF TG_OP = 'DELETE' THEN
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

  IF TG_ARGV[4] <> '' THEN
    FOREACH spec IN ARRAY string_to_array(TG_ARGV[4], ',') LOOP
      fld := split_part(spec, '=', 1);
      col := split_part(spec, '=', 2);
      -- A created row logs every field; a purged row logs only that it is gone (new value NULL).
      IF TG_OP = 'DELETE' THEN
        IF fld <> 'deleted' THEN CONTINUE; END IF;
        ov := sync_logged_value(OLD, fld, col); nv := NULL;
      ELSIF TG_OP = 'INSERT' THEN
        ov := NULL; nv := sync_logged_value(NEW, fld, col);
      ELSE
        IF NOT sync_column_changed(OLD, NEW, fld, col) THEN CONTINUE; END IF;
        ov := sync_logged_value(OLD, fld, col); nv := sync_logged_value(NEW, fld, col);
      END IF;
      INSERT INTO structure_log (workspace_id, table_name, row_key, field, old_value, new_value,
                                 origin, seq, hlc_wall, hlc_counter, author, device)
      VALUES (ws, tbl, key, fld, ov, nv,
              s->>'origin', (s->>'seq')::bigint, (s->>'wall')::bigint, (s->>'counter')::int,
              s->>'author', NULLIF(s->>'device', '')::uuid);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- content_nodes: the whole row, plus title, body, parent, sort order, hidden, space and deleted state each on their own.
-- Parent, space and deleted state are also logged in structure_log; sort order is not (proposal §8.5).
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_insert AFTER INSERT ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=sort_order,hidden=hidden,space=space_id,deleted=deleted_at',
    'parent=parent_id,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_update AFTER UPDATE ON content_nodes FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.markdown IS DISTINCT FROM NEW.markdown
     OR OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.sort_order IS DISTINCT FROM NEW.sort_order
     OR OLD.hidden IS DISTINCT FROM NEW.hidden OR OLD.space_id IS DISTINCT FROM NEW.space_id
     OR (OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL))
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=sort_order,hidden=hidden,space=space_id,deleted=deleted_at',
    'parent=parent_id,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_delete AFTER DELETE ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=sort_order,hidden=hidden,space=space_id,deleted=deleted_at',
    'parent=parent_id,space=space_id,deleted=deleted_at');
