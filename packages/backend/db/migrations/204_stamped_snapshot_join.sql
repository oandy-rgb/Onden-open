-- 204: the joining state of a database that is being filled from another node's stamped snapshot, and the one switch that lets
-- the stamp triggers stand aside while that happens (docs/architecture/proposals/add-device-snapshot-2026-11-15.md §3, §4).
-- Adds only: one table and three functions/triggers. No existing row is read, changed or deleted, and nothing runs until the
-- one TypeScript entry (src/spine/stampedImport.ts) turns the switch on inside a transaction.
--
--   sync_join   the join record: at most one row per workspace being filled. `state` 'joining' while pages arrive, 'done' once every
--               page is in and the two databases' digests agree. source_node = the node the snapshot was made on, cut_seq = that
--               node's sequence number when it started reading (everything after it is a later change, not part of the snapshot),
--               page_hashes = sha-256 of every page applied so far, by page number (an applied page is never applied differently),
--               shell_person = the one person the empty database had when the join began (id, name, sign-in link, write mode, whether they
--               owned the workspace): the workspace they were in is replaced by the snapshot's, so a join that is given up, or taken back at the
--               next boot after a crash, puts them back (db.ts restoreShellPerson). import_batches = how many pages were written with the triggers standing aside (the visible, countable exception,
--               like sync_clock.writes_without_mutate). No foreign key to workspaces: the workspace row arrives in the first page.
--
--   sync_import_active(ws)   true only while (a) the transaction set `onden.stamp_import_<ws>` to 'on' and (b) a sync_join row of
--                            that workspace is 'joining'. The setting is local to the transaction (set_config(..., true)), so the
--                            moment the transaction ends every trigger behaves as before; (b) means a stray setting does nothing.
--   sync_stamp_put(...)      same body as migration 190, plus: while sync_import_active(ws), write nothing (the snapshot carries
--                            the stamps and the importer writes them as received).
--   order_stamp_set()        same body as migration 200, plus: while sync_import_active(ws), keep the order_stamp the snapshot row carries.
--   structure_log_import_skip  BEFORE INSERT on structure_log: while sync_import_active(ws), the line is not written (the log never
--                            leaves a device, so it is not rebuilt from a snapshot).
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: DROP TRIGGER structure_log_import_skip ON
-- structure_log; re-run the sync_stamp_put definition of migration 190; DROP FUNCTION sync_import_active; DROP TABLE sync_join.
-- drill: no allowance needed; nothing existing is written.

CREATE TABLE IF NOT EXISTS sync_join (
  workspace_id uuid PRIMARY KEY,
  source_node text NOT NULL,
  cut_seq bigint NOT NULL,
  state text NOT NULL DEFAULT 'joining' CHECK (state IN ('joining', 'done')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  person_actor_id uuid,
  shell_person jsonb,
  page_hashes jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_through integer NOT NULL DEFAULT 0,
  rows_applied bigint NOT NULL DEFAULT 0,
  import_batches bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_join_one_joining ON sync_join ((true)) WHERE state = 'joining';

CREATE OR REPLACE FUNCTION sync_import_active(p_ws uuid) RETURNS boolean AS $$
BEGIN
  IF COALESCE(current_setting('onden.stamp_import_' || replace(p_ws::text, '-', '_'), true), '') <> 'on' THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = p_ws AND j.state = 'joining');
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION sync_stamp_put(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb) RETURNS void AS $$
BEGIN
  IF sync_import_active(p_ws) THEN RETURN; END IF;
  INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted)
  VALUES (p_ws, p_table, p_key, p_field, s->>'origin', (s->>'seq')::bigint, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid, p_deleted)
  ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
    origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
    author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION structure_log_import_skip() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER structure_log_import_skip BEFORE INSERT ON structure_log FOR EACH ROW EXECUTE FUNCTION structure_log_import_skip();

-- order_stamp_set (migration 200) copies the writing transaction's stamp into order_stamp whenever a row is inserted or its key
-- changes. A snapshot row carries the order_stamp its source gave it (it is the tie rule between equal keys, so it has to be
-- the same on every node): while sync_import_active(ws) the function leaves what the importer wrote. The rest is 200's body,
-- word for word (src/test/guards/orderStampSet.guard.test.ts).
CREATE OR REPLACE FUNCTION order_stamp_set() RETURNS trigger AS $$
DECLARE s jsonb;
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR NEW.order_key IS DISTINCT FROM OLD.order_key THEN
    s := sync_stamp_current(NEW.workspace_id);
    NEW.order_stamp := lpad(s->>'wall', 15, '0') || lpad(s->>'counter', 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
