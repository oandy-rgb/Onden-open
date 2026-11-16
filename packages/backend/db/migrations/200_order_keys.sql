-- 200: same-level order as a key that can always be placed between two others (distributed-ready proposal §4.7).
--
-- Before: content_nodes.sort_order and note_pointers.sort_order are integers the client chooses; moving one note
-- renumbers neighbours, and two devices that each reorder offline write the same numbers for different notes.
-- After: order_key (text, compared by byte: COLLATE "C"), a fractional-index key (@onden/markdown orderKey.ts).
-- Moving or inserting one note writes one row. Rows with the same key are ordered by order_stamp (the hybrid logical
-- clock of the write that set the key, a fixed-width string, '' when the row has none), then by id.
--
-- What this does to existing data (the owner approved a rewrite of existing rows, 2026-11-14):
--   * order_key is filled for EVERY row of both tables, live and trashed, from today's visible order: sort_order, then
--     created_at, then id (the sidebar's rule, lib/childOrder compareChildren), per (workspace, parent). Rows of one
--     group get a000..: 'a'+1 digit for the first 62, 'b'+2 digits for the next 3844, 'c'+3 digits after (no fraction,
--     so any later insertion between two neighbours costs one character). Pointers had no tie-break at all; they get
--     the same rule. Trashed rows take part in the numbering, so restoring one puts it back where it was.
--   * sort_order is NOT changed or dropped and nothing reads it afterwards: it stays one release so the backup/rollback
--     path (restore the pre-upgrade backup, switch the image back) has the old order. It no longer has a default, so a row
--     made after this migration has NULL there: a server that is asked to translate an old client's integer write
--     (services/orderKeys.ts translateLegacySortOrder) only compares against rows that still carry a number.
--   * The stamp field is still named 'sort': an existing stamp (sync_stamps / structure_log rows) is the stamp of this row's
--     place and carries over untouched; only the column the trigger watches changes. The backfill writes order_key
--     BEFORE the triggers are replaced, so it stamps nothing and logs nothing. structure_log now also records the order field
--     (proposal §8.5: it waited for this migration).
--
-- Rerun: the backfill runs only in the transaction that adds the column; a second run changes nothing.
-- Rolling back to an older backend: it refuses to start on a database with a migration it does not know (db.ts); restore the
-- pre-upgrade backup and switch the image back (docs/agents/deploy.md). An older backend that did start would see
-- sort_order as it was at this migration and show the order of that day.

-- PREVIEW (read-only: counts only, no titles, text or ids). Run it on the live database BEFORE the upgrade, as a plain query;
-- it reads the integer sort_order, which this migration leaves in place. The same query is scripts/order-keys-preview.sql.
--   rows_to_fill        rows that will get an order_key (every row, live and trashed, of that table)
--   groups              sibling groups (same workspace and parent), live and trashed rows together
--   groups_all_equal    groups with more than one row whose integers are ALL the same (the sidebar's order comes from created_at, id)
--   groups_with_ties    groups where at least two rows share an integer
--   longest_group       rows in the biggest group (the backfill raises above 242,234)
--   live_*              the same, counting live rows only (what the sidebar shows; live_groups = groups with a live row)
--
--   WITH g AS (
--     SELECT 'content_nodes' AS table_name, workspace_id, parent_id, count(*) AS n, count(DISTINCT sort_order) AS d,
--            count(*) FILTER (WHERE deleted_at IS NULL) AS live_n,
--            count(DISTINCT sort_order) FILTER (WHERE deleted_at IS NULL) AS live_d
--       FROM content_nodes GROUP BY workspace_id, parent_id
--     UNION ALL
--     SELECT 'note_pointers', workspace_id, parent_id, count(*), count(DISTINCT sort_order), count(*), count(DISTINCT sort_order)
--       FROM note_pointers GROUP BY workspace_id, parent_id)
--   SELECT table_name, sum(n) AS rows_to_fill, count(*) AS groups,
--          count(*) FILTER (WHERE n > 1 AND d = 1) AS groups_all_equal, count(*) FILTER (WHERE n > d) AS groups_with_ties,
--          max(n) AS longest_group, count(*) FILTER (WHERE live_n > 0) AS live_groups,
--          count(*) FILTER (WHERE live_n > 1 AND live_d = 1) AS live_groups_all_equal,
--          count(*) FILTER (WHERE live_n > live_d) AS live_groups_with_ties, max(live_n) AS longest_live_group
--     FROM g GROUP BY table_name ORDER BY table_name;

CREATE OR REPLACE FUNCTION order_key_even_tmp(rank integer) RETURNS text AS $$
DECLARE d text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
BEGIN
  IF rank < 62 THEN RETURN 'a' || substr(d, rank + 1, 1); END IF;
  IF rank < 62 + 3844 THEN RETURN 'b' || substr(d, ((rank - 62) / 62) + 1, 1) || substr(d, ((rank - 62) % 62) + 1, 1); END IF;
  IF rank < 3906 + 238328 THEN
    RETURN 'c' || substr(d, ((rank - 3906) / 3844) + 1, 1) || substr(d, ((rank - 3906) / 62) % 62 + 1, 1) || substr(d, ((rank - 3906) % 62) + 1, 1);
  END IF;
  -- More than 242,234 rows under one parent: stop instead of wrapping around into a wrong order.
  RAISE EXCEPTION 'order keys: % siblings under one parent is more than the 242,234 a backfill can number', rank + 1;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

DO $$
DECLARE
  filled_nodes bigint := 0;
  filled_pointers bigint := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'content_nodes' AND column_name = 'order_key') THEN
    ALTER TABLE content_nodes ADD COLUMN order_key text COLLATE "C" NOT NULL DEFAULT 'a0';
    ALTER TABLE content_nodes ADD COLUMN order_stamp text COLLATE "C" NOT NULL DEFAULT '';
    WITH ranked AS (
      SELECT id, row_number() OVER (PARTITION BY workspace_id, parent_id ORDER BY sort_order, created_at, id) - 1 AS rank
        FROM content_nodes)
    UPDATE content_nodes c SET order_key = order_key_even_tmp(ranked.rank::integer) FROM ranked WHERE c.id = ranked.id;
    GET DIAGNOSTICS filled_nodes = ROW_COUNT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'note_pointers' AND column_name = 'order_key') THEN
    ALTER TABLE note_pointers ADD COLUMN order_key text COLLATE "C" NOT NULL DEFAULT 'a0';
    ALTER TABLE note_pointers ADD COLUMN order_stamp text COLLATE "C" NOT NULL DEFAULT '';
    WITH ranked AS (
      SELECT id, row_number() OVER (PARTITION BY workspace_id, parent_id ORDER BY sort_order, created_at, id) - 1 AS rank
        FROM note_pointers)
    UPDATE note_pointers p SET order_key = order_key_even_tmp(ranked.rank::integer) FROM ranked WHERE p.id = ranked.id;
    GET DIAGNOSTICS filled_pointers = ROW_COUNT;
  END IF;
  RAISE NOTICE 'order keys filled: content_nodes % rows, note_pointers % rows', filled_nodes, filled_pointers;
END $$;

DROP FUNCTION order_key_even_tmp(integer);

-- The old integer: still there, no longer written or read; a new row has no number.
ALTER TABLE content_nodes ALTER COLUMN sort_order DROP NOT NULL, ALTER COLUMN sort_order DROP DEFAULT;
ALTER TABLE note_pointers ALTER COLUMN sort_order DROP NOT NULL, ALTER COLUMN sort_order DROP DEFAULT;

DROP INDEX IF EXISTS note_pointers_parent_idx;
CREATE INDEX IF NOT EXISTS note_pointers_parent_idx ON note_pointers (workspace_id, parent_id, order_key);
CREATE INDEX IF NOT EXISTS content_nodes_order_idx ON content_nodes (workspace_id, parent_id, order_key) WHERE deleted_at IS NULL;

-- order_stamp: the stamp of the write that set the key, copied by the database itself (the same stamp the stamp trigger
-- puts in sync_stamps, a foreign node's stamp when one is being adopted), so the tie rule is an ordinary ORDER BY and
-- travels with the row to every node.
CREATE OR REPLACE FUNCTION order_stamp_set() RETURNS trigger AS $$
DECLARE s jsonb;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.order_key IS DISTINCT FROM OLD.order_key THEN
    s := sync_stamp_current(NEW.workspace_id);
    NEW.order_stamp := lpad(s->>'wall', 15, '0') || lpad(s->>'counter', 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER content_nodes_order_stamp BEFORE INSERT OR UPDATE OF order_key ON content_nodes
  FOR EACH ROW EXECUTE FUNCTION order_stamp_set();
CREATE OR REPLACE TRIGGER note_pointers_order_stamp BEFORE INSERT OR UPDATE OF order_key ON note_pointers
  FOR EACH ROW EXECUTE FUNCTION order_stamp_set();

-- The stamp triggers watch order_key now; the stamp field keeps its name, 'sort'.
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_insert AFTER INSERT ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=space_id,deleted=deleted_at',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_update AFTER UPDATE ON content_nodes FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.markdown IS DISTINCT FROM NEW.markdown
     OR OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.order_key IS DISTINCT FROM NEW.order_key
     OR OLD.hidden IS DISTINCT FROM NEW.hidden OR OLD.space_id IS DISTINCT FROM NEW.space_id
     OR (OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL))
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=space_id,deleted=deleted_at',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_delete AFTER DELETE ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=space_id,deleted=deleted_at',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');

-- note_pointers: the arguments of 194 with the order column swapped.
CREATE OR REPLACE TRIGGER note_pointers_sync_stamp_insert AFTER INSERT ON note_pointers FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('note_pointers', 'id', 'workspace_id', 'sort=order_key,prefix=display_prefix', '', '', '');
CREATE OR REPLACE TRIGGER note_pointers_sync_stamp_update AFTER UPDATE ON note_pointers FOR EACH ROW
  WHEN (OLD.order_key IS DISTINCT FROM NEW.order_key OR OLD.display_prefix IS DISTINCT FROM NEW.display_prefix)
  EXECUTE FUNCTION sync_stamp_trigger('note_pointers', 'id', 'workspace_id', 'sort=order_key,prefix=display_prefix', '', '', '');
CREATE OR REPLACE TRIGGER note_pointers_sync_stamp_delete AFTER DELETE ON note_pointers FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('note_pointers', 'id', 'workspace_id', 'sort=order_key,prefix=display_prefix', '', '', '');

-- Genesis baseline (202, sync_genesis_pass). Before this migration no stamp trigger logged the place in structure_log, so a database
-- that took 202 first has no baseline of the 'sort' unit and no marker for it: the trigger arguments above wire it up now, and the
-- pass baselines it from the keys the backfill wrote (old value NULL, genesis, as every other baseline line) and writes the marker.
-- A new install runs this file before 202 (the function does not exist yet) and 202 baselines the keys itself; both orders end in
-- the same lines. The pass adds nothing it already added, so a rerun adds none.
DO $$
BEGIN
  IF to_regprocedure('sync_genesis_pass()') IS NOT NULL THEN
    PERFORM sync_genesis_pass();
  END IF;
END $$;
