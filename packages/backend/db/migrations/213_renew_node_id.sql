-- 213: a database restored from a backup takes a new node id (docs/architecture/proposals/node-rebase-2026-11-16.md §6; the owner's
-- answer of 2026-11-17 to §11 question 2: the restore command does it, a backend start never does). Adds only: two functions.
-- No existing row is read, changed or deleted by this migration; the functions write only when they are called.
--
-- WHY. A node's id is the origin of every write stamp it makes (sync_stamps.origin, with sequence numbers per origin in sync_clock.next_seq).
-- pg_dump carries sync_node and sync_clock, so a database restored from an older dump numbers its next writes from where the dump stopped:
-- (origin, seq) pairs the server had already handed out, with other content, before it was restored (the "USN rollback" of
-- docs/research/sync-design-vs-literature-2026-11-16.md item 1). A new id makes every later write a new pair.
--
-- WHAT THIS ADDS
--   sync_take_node_id()    the one rule by which a node takes a new id: the sync_node row, locked, gets gen_random_uuid(); made if there was
--                          none. Returns (before_id, after_id); before_id is NULL when the database had no id. The browser copy's first boot
--                          (src/browser/nodeIdentity.ts ensureOwnNodeId) and sync_renew_node_id() both call it; nothing else changes sync_node.node_id
--                          (src/test/guards/restoreRenewsNodeId.guard.test.ts).
--   sync_renew_node_id()   what the restore command runs once the data is loaded (scripts/lib/renewNodeId.sh, from scripts/restore.sh and
--                          scripts/restore-drill.sh). In one transaction, after the event-append lock and the clock row of every workspace
--                          that has a clock (sync_lock_clock: the order every writer takes them in):
--                            * the node takes a new id (sync_take_node_id);
--                            * every sync_clock row: next_seq = 1 (the new origin's own sequence starts), and the clock reading becomes the larger
--                              of what the row held and the largest reading of any stamp or other head of that workspace, so the next stamp sorts
--                              after every stamp the database holds. writes_without_mutate and merge_batches stay (they count exceptions of the
--                              workspace, not of an origin);
--                            * the old id becomes an origin this node holds, not its own: one sync_origins row per workspace whose clock had numbered
--                              writes (next_seq > 1), vouched_by 'self-restore', have = every carried label at next_seq - 1 (it holds every write it numbered:
--                              they were its own). A peer that holds later writes of the old id can send them back, and they are taken as any other
--                              origin's (spine/stampedImport.ts applyChangeBundle). 'self-restore' is not a sender: only 'snapshot' and 'admitted' are.
--                          Not changed: no stamp, other head or structure_log line (the old id's stamps stay, attributed to the old id, byte for byte;
--                          `saw` keeps naming it), sync_join (it names the node a workspace was joined FROM, never this node), the other sync_origins rows.
--                          Returns (old_node_id, new_node_id, workspaces = clock rows renumbered, origins_added).
--
-- WHAT THIS DOES NOT DO, on purpose
--   * no call. migrate() never calls either function, and no backend start does (guard above): only the restore command knows a database was restored.
--   * no resend of writes that were never accepted, no `replaces` for peers, no device-side exit (node-rebase §2–§5, later batches).
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: DROP FUNCTION sync_renew_node_id(); DROP FUNCTION
-- sync_take_node_id(); and re-deploy the older src/browser/nodeIdentity.ts with it (it calls sync_take_node_id).
-- drill: no allowance needed. This migration writes no row of any table the drill compares.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; counts only). The migration defines two
-- functions and calls neither (restoreRenewsNodeId.guard.test.ts "no product code and no migration calls sync_renew_node_id()"), so it adds no row:
--
--   SELECT 'sync_origins rows this migration adds' AS part, 0::bigint AS rows
--   UNION ALL SELECT 'sync_node rows it changes', 0
--   UNION ALL SELECT 'sync_clock rows it changes', 0
--   UNION ALL SELECT 'functions it defines that exist already', count(*) FROM pg_proc WHERE proname IN ('sync_take_node_id', 'sync_renew_node_id')
--   ;

CREATE OR REPLACE FUNCTION sync_take_node_id() RETURNS TABLE (before_id text, after_id text) AS $$
DECLARE v_before text; v_after text;
BEGIN
  SELECT n.node_id INTO v_before FROM sync_node n WHERE n.singleton FOR UPDATE;
  INSERT INTO sync_node (singleton, node_id) VALUES (true, gen_random_uuid()::text)
    ON CONFLICT (singleton) DO UPDATE SET node_id = EXCLUDED.node_id
    RETURNING sync_node.node_id INTO v_after;
  RETURN QUERY SELECT v_before, v_after;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_renew_node_id() RETURNS TABLE (old_node_id text, new_node_id text, workspaces bigint, origins_added bigint) AS $$
DECLARE v_ws uuid; v_old text; v_new text; v_clocks bigint; v_origins bigint;
BEGIN
  -- every writer takes a workspace's event-append lock, then its clock row (spine/stamps.ts); a renewal takes all of them, in one order
  FOR v_ws IN SELECT c.workspace_id FROM sync_clock c ORDER BY c.workspace_id LOOP
    PERFORM 1 FROM sync_lock_clock(v_ws);
  END LOOP;
  SELECT t.before_id, t.after_id INTO v_old, v_new FROM sync_take_node_id() t;
  -- the old id's own writes, as an origin held up to the last number it gave (before the clock is renumbered below)
  IF v_old IS NOT NULL THEN
    -- held up to that number for every label a change bundle carries: the same shape as spine/stampedBundle.ts haveOfAll, from the one list
    -- spine/stampedMerge/dbUnits.ts CARRIED_LABELS (restoreRenewsNodeId.guard.test.ts keeps the two equal: a label added there needs a migration here)
    INSERT INTO sync_origins (workspace_id, origin, vouched_by, have)
    SELECT c.workspace_id, v_old, 'self-restore', (SELECT jsonb_object_agg(l, c.next_seq - 1) FROM unnest(ARRAY['workspaces', 'spaces', 'space_members', 'content_nodes', 'node_attributes', 'node_tags', 'node_edges', 'note_pointers', 'node_positions', 'function_refs', 'rss_subscriptions', 'rss_mutes', 'external_calendars', 'actor_module_settings', 'content_nodes.tag_schema', 'spaces.capabilities', 'function_refs.config', 'workspaces.modules_off', 'workspaces.modules_confirmed']) AS l)
      FROM sync_clock c WHERE c.next_seq > 1;
    GET DIAGNOSTICS v_origins = ROW_COUNT;
  ELSE
    v_origins := 0;
  END IF;
  WITH top AS (
    SELECT s.workspace_id, s.hlc_wall, s.hlc_counter FROM sync_stamps s
    UNION ALL SELECT h.workspace_id, h.hlc_wall, h.hlc_counter FROM sync_stamp_heads h
  ), best AS (
    SELECT DISTINCT ON (workspace_id) workspace_id, hlc_wall, hlc_counter FROM top ORDER BY workspace_id, hlc_wall DESC, hlc_counter DESC
  )
  UPDATE sync_clock c SET next_seq = 1,
         hlc_wall = CASE WHEN b.hlc_wall IS NOT NULL AND (b.hlc_wall, b.hlc_counter) > (c.hlc_wall, c.hlc_counter) THEN b.hlc_wall ELSE c.hlc_wall END,
         hlc_counter = CASE WHEN b.hlc_wall IS NOT NULL AND (b.hlc_wall, b.hlc_counter) > (c.hlc_wall, c.hlc_counter) THEN b.hlc_counter ELSE c.hlc_counter END
    FROM sync_clock c2 LEFT JOIN best b ON b.workspace_id = c2.workspace_id
   WHERE c2.workspace_id = c.workspace_id;
  GET DIAGNOSTICS v_clocks = ROW_COUNT;
  RETURN QUERY SELECT v_old, v_new, v_clocks, v_origins;
END;
$$ LANGUAGE plpgsql;
