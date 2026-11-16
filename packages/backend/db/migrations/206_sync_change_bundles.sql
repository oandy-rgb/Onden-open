-- 206: what a node has taken from which other node, and three rules a change bundle needs from the database (stamped-sync batch 2b-1;
-- src/spine/stampedBundle.ts, src/spine/stampedImport.ts applyChangeBundle). Adds only: one table and redefinitions of two functions.
-- No existing row is read for a purpose other than the preview below, changed or deleted.
--
-- WHAT THIS ADDS
--   sync_origins   one row per (workspace, origin): the origins this node accepts stamps of, and how far it holds them.
--                  `have` is {scope: highest sequence number of that origin whose writes to the scope this node holds contiguously}; the only scope today
--                  is 'content_nodes'. A column of sync_join cannot say it (one source, no later origins), and one number per origin would claim the tables that
--                  later batches add: a bundle of content_nodes moves 'content_nodes' only. `vouched_by` says why the origin is accepted: 'snapshot' (the source this
--                  workspace was joined from), 'admitted' (the owner admitted that node: the one the centre has to name before it takes its first bundle), or the node id of the
--                  sender whose bundle brought the origin. This node's own origin and 'genesis' are never rows: the first is sync_clock, the second is nobody's.
--                  A bundle from a node that has no row is refused whole.
--
-- WHAT THIS CHANGES IN BEHAVIOUR (two redefinitions; everything else of both functions is migration 205's text, word for word)
--   sync_stamp_put_over   (1) a write by a SYSTEM job (the stamp setting says "system": spine/stamps.ts stampTransaction) to a unit that has other heads is refused with
--                         SQLSTATE ON001, which spine/eventTransaction.ts turns into the retryable `sync_unit_in_conflict`; before, the write replaced the heads it had never looked at.
--                         A person's write is as before (it has seen the heads and replaces them). (2) a row made again over a permanent delete (or over a row whose creation
--                         carries what a deleter had seen) keeps the deleter's `seen` in the new creation's meta, so a write the deleter had seen is no longer a head beside the
--                         recreated value (src/spine/stampedMerge/store.ts `droppedBySeen`).
--   sync_touch_updated_at   a note's `updated_at` becomes the largest wall time of its units' stamps (a pure function of what replicates); sync_stamp_put_over sets it after a local write.
--                         It changes the value an ordinary write leaves in `updated_at` (the stamp's clock instead of the database's now()), never a row it was not the write of.
--   structure_log_import_skip   a line is still skipped while a snapshot or a merge is written, except the line the merge writes ITSELF for a change that came from another device
--                         (src/spine/stampedMerge/dbRows.ts sets `onden.merge_structure_line` around that one insert): what the triggers log meanwhile would carry no real stamp.
--
-- WHAT THIS DOES NOT DO, on purpose
--   * no existing stamp, row or log line is rewritten. sync_origins is filled from sync_join for workspaces joined before this migration (their source node, held up to its cut).
--   * the join is not changed: markJoinDone (src/spine/stampedImport.ts) writes the new row for the source of a snapshot from now on.
--   * a node that took a new id (src/browser/nodeIdentity.ts) did it before any exchange, so no sync_origins row names the old id.
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward; an older backend refuses a database with a migration it does not know).
-- In place: re-run the sync_stamp_put_over and structure_log_import_skip definitions of 205 / 204; the table can stay (nothing of the older code reads it).
-- drill: no allowance needed. This migration writes no row of any table the drill compares.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; counts only):
--
--   SELECT 'sync_origins rows made from finished joins' AS part, count(*)::bigint AS rows, (count(*) * 120)::bigint AS est_bytes FROM sync_join WHERE state = 'done'
--   UNION ALL SELECT 'sync_stamps rows rewritten', 0, 0
--   ;

CREATE TABLE IF NOT EXISTS sync_origins (
  workspace_id uuid NOT NULL,
  origin text NOT NULL,
  vouched_by text NOT NULL,
  have jsonb NOT NULL DEFAULT '{}'::jsonb,
  since timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, origin)
);

INSERT INTO sync_origins (workspace_id, origin, vouched_by, have)
SELECT j.workspace_id, j.source_node, 'snapshot', jsonb_build_object('content_nodes', j.cut_seq)
  FROM sync_join j WHERE j.state = 'done'
ON CONFLICT (workspace_id, origin) DO NOTHING;

CREATE OR REPLACE FUNCTION structure_log_import_skip() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(NEW.workspace_id) AND COALESCE(current_setting('onden.merge_structure_line', true), '') <> 'on' THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A note's `updated_at` is a function of the stamps that replicate: the largest wall time (ms) among the stamps of the row's units that COUNT as an edit (the other heads too). Three kinds
-- of stamp do not count, as today's write path (services/nodeUpdate.ts applyNodeColumns): the creation `*` (a row's `updated_at` at its creation is the value the INSERT gave it, which an import or a bundle carries as a column), the unit `sort` (a position among siblings is not an edit), and a stamp whose writer said "this save is housekeeping"
-- (`meta.quiet = true`: the write path sets onden.stamp_quiet around the UPDATE of a save that keeps `updated_at`: block-id migration, marker repair, link rewrite). Only the writer knows the third, so it is
-- written into the stamp's meta, where every node reads it. Every node computes the result from the
-- same stamps, so it is the same on every node; a local write sets it here (sync_stamp_put_over below) and a merge sets it after it wrote the stamps (src/spine/stampedMerge/dbRows.ts). A row with only
-- genesis stamps (wall 0) keeps what it has. Writes that do not pass through the row's units (attributes, tags, ...) still set it by their own code today: pinned in stampedBundle.integration.test.ts.
CREATE OR REPLACE FUNCTION sync_touch_updated_at(p_ws uuid, p_key text) RETURNS void AS $$
DECLARE v_wall bigint;
BEGIN
  SELECT max(w) INTO v_wall FROM (
    SELECT hlc_wall AS w FROM sync_stamps WHERE workspace_id = p_ws AND table_name = 'content_nodes' AND row_key = p_key AND origin <> 'genesis' AND field NOT IN ('*', 'sort') AND COALESCE(meta->>'quiet', '') <> 'true'
    UNION ALL SELECT hlc_wall FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = 'content_nodes' AND row_key = p_key AND origin <> 'genesis' AND field NOT IN ('*', 'sort') AND COALESCE(meta->>'quiet', '') <> 'true') x;
  IF v_wall IS NOT NULL AND v_wall > 0 THEN
    UPDATE content_nodes SET updated_at = to_timestamp(v_wall / 1000.0) WHERE id = p_key::uuid AND workspace_id = p_ws AND updated_at IS DISTINCT FROM to_timestamp(v_wall / 1000.0);
  END IF;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION sync_stamp_put_over(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb, p_old text, p_old_known boolean, p_meta jsonb DEFAULT NULL) RETURNS void AS $$
DECLARE
  v_origin text := s->>'origin';
  v_seq bigint := (s->>'seq')::bigint;
  d record;
  h record;
  v_saw jsonb := '{}'::jsonb;
  v_meta jsonb;
  v_again boolean := false;
  v_prev_seen jsonb;
  v_quiet boolean := p_field <> '*' AND COALESCE(current_setting('onden.stamp_quiet', true), '') = 'on'; -- this write is housekeeping: it does not count for `updated_at`
BEGIN
  IF sync_import_active(p_ws) THEN RETURN; END IF;
  SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field;
  IF FOUND THEN
    v_prev_seen := d.meta -> 'seen'; -- what a delete of this row had seen, carried by a creation that covers it
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
  -- a system job does not resolve a conflict nobody has looked at: its write has seen only the head the unit shows, and a `saw` cannot say that
  IF COALESCE(s->>'system', '') = 'true' AND NOT v_again
     AND EXISTS (SELECT 1 FROM sync_stamp_heads x WHERE x.workspace_id = p_ws AND x.table_name = p_table AND x.row_key = p_key AND x.field = p_field) THEN
    RAISE EXCEPTION 'sync_unit_in_conflict' USING ERRCODE = 'ON001';
  END IF;
  -- a write by this node has seen every head the unit had: they are replaced
  FOR h IN DELETE FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field RETURNING * LOOP
    IF h.origin = 'genesis' THEN v_saw := sync_saw_merge(v_saw, jsonb_build_object('genesis:' || h.content_hash, 0));
    ELSIF NOT (h.origin = v_origin AND h.seq = v_seq) THEN v_saw := sync_saw_merge(v_saw, sync_saw_merge(h.saw, jsonb_build_object(h.origin, h.seq)));
    END IF;
  END LOOP;
  IF p_meta IS NOT NULL THEN v_meta := p_meta;
  ELSIF NOT v_again AND p_table = 'content_nodes' AND p_field = 'parent' AND p_old_known THEN v_meta := jsonb_build_object('from', p_old);
  ELSIF NOT v_again AND p_field = '*' AND NOT p_deleted AND v_prev_seen IS NOT NULL THEN v_meta := jsonb_build_object('seen', v_prev_seen); END IF;
  IF v_quiet THEN v_meta := COALESCE(v_meta, '{}'::jsonb) || '{"quiet": true}'::jsonb;
  ELSIF v_meta ? 'quiet' THEN v_meta := NULLIF(v_meta - 'quiet', '{}'::jsonb); END IF;
  INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta)
  VALUES (p_ws, p_table, p_key, p_field, v_origin, v_seq, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid, p_deleted, v_saw, v_meta)
  ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
    origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
    author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted, saw = EXCLUDED.saw, meta = EXCLUDED.meta;
  IF p_table = 'content_nodes' AND NOT p_deleted AND NOT v_quiet AND p_field NOT IN ('*', 'sort') THEN PERFORM sync_touch_updated_at(p_ws, p_key); END IF;
END;
$$ LANGUAGE plpgsql;
