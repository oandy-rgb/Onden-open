-- 221: the merge core before the transport, batch 1 (proposal docs/architecture/proposals/own-node-transport-2026-11-22.md §4.2 and §6 "batch 1"; README
-- src/spine/stampedMerge/README.md "接上傳輸前必須完成"). Redefines one function; no table, column, row or stamp is added, changed or deleted.
--
-- 1. A write outside every stamped transaction does not settle a conflict (item 17, "the trigger does not know who writes").
--    The stamp trigger knows a system job's write and an AI token's (spine/stamps.ts stampTransaction puts `system` in the stamp: migration 206 refuses such a
--    write to a unit that holds other heads, sync_unit_in_conflict). A write that no root stamped (no mutate, no stampTransaction: a background pass, a
--    maintenance script, a test's seed) gets its stamp from sync_allocate_stamp below, with no author: nobody looked at the heads either. Before, that stamp
--    said nothing about who wrote, and the trigger let the write replace every head of the unit, as a person's does. Now the stamp says `system`, so it is
--    refused the same way. A root that comes later in the same transaction (stampTransaction keeps the stamp and sets its author) says itself whether it is a
--    system's, and from then the stamp is that root's (spine/stamps.ts).
--    No change on one server: a unit has other heads only after another node's bundle was taken, which no product path does yet; the function allocates
--    the same numbers as before (src/test/syncSystemWriteConflict.integration.test.ts, "a write outside every root").

-- 2. READ-ONLY PREVIEW, nothing to apply (review of PR #1940, round 1, point 2). A received check must never be stricter than what an honest node holds, so the
--    writers' caps the database does not hold are NOT checked on receive (src/spine/stampedMerge/dbUnits.ts). Run these on the server (counts only, no text) to know:
--    a) how many values exceed a cap that is no longer checked on receive (clamping them with a CHECK is a change of data: the owner decides):
--         SELECT (SELECT count(*) FROM content_nodes WHERE length(title) > 500 OR length(markdown) > 2000000) AS notes_over_cap,
--                (SELECT count(*) FROM block_anchors WHERE greatest(length(quote), length(quote_prefix), length(quote_suffix)) > 2000000) AS quotes_over_cap;
--    b) the rules still checked on receive (they must be 0, or a bundle carrying that row is refused for ever). An order key keyBetween accepts (notes and
--       pointers, dbUnits.ts checkOrderKey; @onden/markdown orderKey.ts validate in SQL: digits 0-9A-Za-z, 1 to 256 of them, not 'A' and 26 zeros, at least as
--       long as its head says, a fraction not ending in 0; compared with isValidOrderKey on 83 keys, a00 and ~ among them, review of PR #1940 round 2, point 2):
--         SELECT t, count(*) FROM (SELECT 'notes' AS t, order_key AS k FROM content_nodes UNION ALL SELECT 'pointers', order_key FROM note_pointers) x,
--                LATERAL (SELECT COALESCE(CASE WHEN k ~ '^[a-z]' THEN ascii(k) - 95 WHEN k ~ '^[A-Z]' THEN 92 - ascii(k) END, 1000) AS n) h
--          WHERE NOT (k ~ '^[0-9A-Za-z]+$' AND length(k) <= 256 AND k <> 'A' || repeat('0', 26) AND length(k) >= h.n AND (length(k) = h.n OR right(k, 1) <> '0'))
--          GROUP BY t;
--       The anchors' tables:
--         SELECT (SELECT count(*) FROM block_nodes WHERE length(label) > 4000 OR length(text_cache) > 4000) AS paragraph_text_over,
--                (SELECT count(*) FROM block_nodes WHERE detached_tags IS NOT NULL AND (cardinality(detached_tags) > 666666
--                   OR EXISTS (SELECT 1 FROM unnest(detached_tags) t WHERE t IS NULL OR length(t) NOT BETWEEN 1 AND 200))) AS detached_tags_odd,
--                (SELECT count(*) FROM block_nodes WHERE block_ref !~ '^[a-zA-Z0-9-]{1,64}$' OR (anchor_id IS NOT NULL AND anchor_id !~ '^[a-zA-Z0-9-]{1,64}$')) AS paragraph_ids_odd;
--    (The other tables are checked on receive only for what their columns hold: their type, NOT NULL and their own CHECKs, which every value already in them meets.)

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
  -- `system`: nobody who looked at a unit's heads wrote this (migration 206 sync_stamp_put_over refuses it on a unit in conflict)
  RETURN jsonb_build_object('origin', c.node_id, 'seq', c.next_seq, 'wall', new_wall, 'counter', new_counter, 'bypass', true, 'system', true);
END;
$$ LANGUAGE plpgsql;
