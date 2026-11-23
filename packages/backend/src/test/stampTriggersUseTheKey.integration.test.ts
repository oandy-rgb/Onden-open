// What a save costs in the stamp tables does not grow with how many stamps the database holds (migration 226; review of PR #1946). The statement
// triggers of migration 215 (sync_rows_made_afresh, sync_rows_go_with_note) compared sync_stamps.table_name (text) with TG_TABLE_NAME (type name),
// which the primary key cannot serve, so each of them read the whole of sync_stamps: a save got slower as the database grew, a write over many notes
// with the square of it (anchorBulkCost.integration.test.ts timed out on real Postgres).
// Measured by behaviour, not by reading SQL: the same write (a note with its anchors and paragraph rows made, then the note deleted, each in one stamped
// transaction, as a save and a purge do) at 1,000, 10,000 and 100,000 other stamps, counting the rows Postgres reads from sync_stamps and
// sync_stamp_heads (pg_stat_user_tables: sequential reads plus index fetches). With 226 the count stays within a constant factor; with 215's functions
// it grows by about the stamps added (checked by hand when this file was written: the PR says how much). Both engines.
// SAFETY: one node database (a PGlite, or a database of the test server on a real Postgres), dropped after the test.
import { afterAll, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { awaitCountsOfEveryConnection } from "./helpers/statisticsOfEveryConnection.js";
import { buildSourceWorld, openNode } from "./helpers/stampedWorld.js";
import { seedQ } from "./helpers/seedQ.js";
import { stampTransaction } from "../spine/stamps.js";
import { withEventTransaction } from "../spine/eventTransaction.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const SIZES = [1_000, 10_000, 100_000] as const;
const ANCHORS = 20;
let node: RealNode | undefined;
afterAll(async () => { await node?.close(); });

/** Rows read so far from the two stamp tables (every connection's counters flushed first: a real Postgres keeps them per backend until then). */
async function stampRowsRead(): Promise<number> {
  await awaitCountsOfEveryConnection();
  const r = (await q<{ n: string }>(`SELECT (sum(seq_tup_read) + sum(COALESCE(idx_tup_fetch, 0)))::text AS n FROM pg_stat_user_tables
    WHERE relname IN ('sync_stamps', 'sync_stamp_heads')`)).rows[0]!;
  return Number(r.n);
}

describe.skipIf(!isTestDb)("the stamp triggers of a body write read the key, not the whole stamp table", () => {
  it(`a note's anchors made and the note deleted read about as many stamps at ${SIZES.join(", ")} other stamps`, async () => {
    node = await openNode("stamp-key");
    const world = await buildSourceWorld(node);
    const read: Record<number, { made: number; gone: number }> = {};
    await onNode(node, async () => {
      const ws = world.ws, owner = world.owner.id;
      const space = (await seedQ<{ id: string }>(`INSERT INTO spaces (workspace_id, name, kind) VALUES ($1, 'Key', 'shared') RETURNING id::text`, [ws])).rows[0]!.id;
      const stamped = (fn: () => Promise<void>) => withTransaction(() => withEventTransaction(ws, async () => { await stampTransaction(ws, owner); await fn(); }));
      let held = 0;
      for (const size of SIZES) {
        // other stamps of the same tables and workspace (other notes' anchors and paragraph rows), as a database that has been written to for a while holds
        await seedQ(`INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter)
          SELECT $1, CASE WHEN g % 2 = 0 THEN 'block_anchors' ELSE 'block_nodes' END, 'other-' || g, f, 'other-node', g, 1, 0
            FROM generate_series($2::int + 1, $3::int) g CROSS JOIN (VALUES ('*'), ('quote')) AS x(f) WHERE g % 2 = 0 OR f = '*'`, [ws, held, size]);
        held = size;
        // the planner told how big the tables are now, as autovacuum tells it on a database in use: what this file pins is the shape of the statements (a value
        // the key cannot serve reads the whole table whatever the statistics say), not how soon statistics follow a bulk load (the PR says what that costs)
        await q(`ANALYZE sync_stamps, sync_stamp_heads`);
        const note = crypto.randomUUID();
        const before = await stampRowsRead();
        await stamped(async () => {
          await q(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id)
                   VALUES ($1, $2, 'manual', 'content', $3, $3, $4, $5)`, [note, ws, `key ${size}`, Array.from({ length: ANCHORS }, (_, p) => `Paragraph ${p}`).join("\n\n"), space]);
          await q(`WITH a AS (
                     INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote)
                     SELECT $1, 'k' || substr(md5($2::text || p), 1, 11), $2::uuid, 0, 1, encode(sha256(convert_to(c.markdown, 'UTF8')), 'hex'), 'Paragraph ' || p
                       FROM content_nodes c CROSS JOIN generate_series(1, $3::int) p WHERE c.id = $2::uuid RETURNING anchor_id)
                   INSERT INTO block_nodes (workspace_id, note_id, block_ref, kind, anchor_id) SELECT $1, $2::uuid, anchor_id, 'paragraph', anchor_id FROM a`, [ws, note, ANCHORS]);
        });
        const middle = await stampRowsRead();
        await stamped(async () => { await q(`DELETE FROM content_nodes WHERE id = $1`, [note]); });
        const after = await stampRowsRead();
        read[size] = { made: middle - before, gone: after - middle };
        expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM block_anchors WHERE note_id = $1`, [note])).rows[0]!.n), "the note's anchors went with it").toBe(0);
      }
    });
    console.log(`[stamp triggers] stamp rows read by one note's ${ANCHORS} anchors made / the note deleted, at ${SIZES.join(" / ")} other stamps: ${JSON.stringify(read)}`);
    // the same write at 100 times the stamps: within a constant factor of the smallest (what it reads is the note's own stamps, through the key), plus a
    // small allowance; a scan of the table would read about 100,000 more
    const [small, , large] = SIZES;
    for (const k of ["made", "gone"] as const) {
      expect(read[large]![k], `${k}: ${read[large]![k]} rows read at ${large} stamps, ${read[small]![k]} at ${small}`).toBeLessThanOrEqual(3 * read[small]![k] + 500);
    }
  }, 600_000);
});
