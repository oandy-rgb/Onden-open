// What migration 215 adds to a transaction that touches the anchors of many notes at once (review of PR #1853, rounds 4 and 5): a space of 2,000 notes with 20
// anchors each, and a paragraph row on every anchor, is deleted (the rows go with their notes, as purgeSpaceDeleted's one statement does), and one transaction writes the
// anchors of 500 notes (what an import or a whole-space rewrite does). Each on a node with the triggers of 215 and on one where they are dropped (the write path of main).
// Rows read and written (pg_stat_user_tables) and the time are printed; rows read are asserted to stay within a constant factor of main's (the unit's bookkeeping is per
// statement and per note, never per note per row), and a deletion to write main's rows and at most two more per note (no tombstone per row gone with its note). Both engines.
import { afterEach, describe, expect, it } from "vitest";
import { dbDriver, pool, q, withTransaction } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, openNode } from "./helpers/stampedWorld.js";
import { seedQ } from "./helpers/seedQ.js";
import { stampTransaction } from "../spine/stamps.js";
import { withEventTransaction } from "../spine/eventTransaction.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

const NOTES = 2000, PER = 20, WRITTEN = 500;

async function counts(): Promise<{ read: number; written: number }> {
  await q(`SELECT pg_stat_force_next_flush()`); await q(`SELECT 1`);
  if (dbDriver === "postgres") {
    const clients = await Promise.all(Array.from({ length: pool.idleCount }, () => pool.connect()));
    try { for (const c of clients) { await c.query(`SELECT pg_stat_force_next_flush()`); await c.query(`SELECT 1`); } } finally { for (const c of clients) c.release(); }
  }
  await q(`SELECT pg_stat_clear_snapshot()`);
  const r = (await q<{ r: string; w: string }>(`SELECT (sum(seq_tup_read) + sum(COALESCE(idx_tup_fetch, 0)))::text AS r, (sum(n_tup_ins) + sum(n_tup_upd) + sum(n_tup_del))::text AS w FROM pg_stat_user_tables`)).rows[0]!;
  return { read: Number(r.r), written: Number(r.w) };
}
type Cost = { ms: number; read: number; written: number };
async function measured(fn: () => Promise<void>): Promise<Cost> {
  const s0 = await counts(); const t = performance.now();
  await fn();
  const ms = Math.round(performance.now() - t); const s1 = await counts();
  return { ms, read: s1.read - s0.read, written: s1.written - s0.written };
}

/** A node with a space of NOTES notes of PER tagged paragraphs, each with its anchor measured on the body; with or without the triggers of 215. */
async function bulkNode(without215: boolean): Promise<{ node: RealNode; ws: string; owner: string; space: string }> {
  const node = await openNode(without215 ? "main" : "branch");
  open.push(node);
  const world = await buildSourceWorld(node);
  return onNode(node, async () => {
    if (without215) {
      const triggers = (await q<{ t: string; tab: string }>(
        `SELECT t.tgname AS t, c.relname AS tab FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND c.relname IN ('block_anchors', 'block_nodes', 'note_anchor_places')
            AND (t.tgname LIKE '%sync_stamp%' OR t.tgname LIKE '%hash_is_body%' OR t.tgname LIKE 'block_anchors_unit_follows%' OR t.tgname = 'note_anchor_places_is_rows'
                 OR t.tgname LIKE '%go_with_note' OR t.tgname LIKE '%made_afresh' OR t.tgname LIKE '%in_notes_workspace_%')`)).rows;
      expect(triggers.length).toBeGreaterThan(8);
      for (const { t, tab } of triggers) await q(`DROP TRIGGER ${t} ON ${tab}`);
    }
    const space = (await seedQ<{ id: string }>(`INSERT INTO spaces (workspace_id, name, kind) VALUES ($1, 'Bulk', 'shared') RETURNING id::text`, [world.ws])).rows[0]!.id;
    // made 100 notes a statement: one statement of 500 notes and 10,000 anchors went past the backend's statement timeout (15 s) in a parallel batch on real Postgres
    for (let done = 0; done < NOTES; done += 100) {
      await seedQ(`
        WITH notes AS (
          INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
          SELECT $1, 'manual', 'content', 'bulk ' || g, 'bulk-' || g, (SELECT string_agg('Paragraph ' || p || ' of note ' || g || ' with a few words', E'\\n\\n') FROM generate_series(1, $4::int) p), $2
            FROM generate_series($3::int, $3::int + 99) g RETURNING id, markdown)
        , anchors AS (
          INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote)
          SELECT $1, 'b' || substr(md5(n.id::text || p), 1, 11), n.id, 0, 1, encode(sha256(convert_to(n.markdown, 'UTF8')), 'hex'), 'Paragraph ' || p
            FROM notes n CROSS JOIN generate_series(1, $4::int) p RETURNING note_id, anchor_id)
        INSERT INTO block_nodes (workspace_id, note_id, block_ref, kind, anchor_id)
        SELECT $1, note_id, anchor_id, 'paragraph', anchor_id FROM anchors`, [world.ws, space, done, PER]);
    }
    await q(`ANALYZE`);
    return { node, ws: world.ws, owner: world.owner.id, space };
  });
}

describe.skipIf(!isTestDb)("what migration 215 adds to a transaction over many notes' anchors", () => {
  it(`${NOTES} notes × ${PER} anchors: a space deleted, and one transaction writing the anchors of ${WRITTEN} notes (rows within a constant factor of main's; time printed)`, async () => {
    const out: Record<string, { write: Cost; remove: Cost }> = {};
    const held: Record<string, number> = {};
    for (const without215 of [true, false]) {
      const { node, ws, owner, space } = await bulkNode(without215);
      out[without215 ? "main" : "215"] = await onNode(node, async () => {
        const stamped = (fn: () => Promise<void>) => withTransaction(() => withEventTransaction(ws, async () => { await stampTransaction(ws, owner); await fn(); }));
        const write = await measured(() => stamped(async () => {
          await q(`UPDATE block_anchors a SET quote_prefix = 'rewritten' FROM (SELECT id FROM content_nodes WHERE space_id = $1 ORDER BY id LIMIT $2) n WHERE a.note_id = n.id`, [space, WRITTEN]);
        }));
        const anchors = async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM block_anchors WHERE workspace_id = $1`, [ws])).rows[0]!.n);
        const before = await anchors();
        // the stamps (and heads) of the space's anchors, paragraph rows and units: a purge takes them with the rows (round 6, point 3)
        const keys = (await q<{ t: string; k: string }>(
          `SELECT 'block_anchors' AS t, a.anchor_id AS k FROM block_anchors a JOIN content_nodes c ON c.id = a.note_id WHERE c.space_id = $1
           UNION ALL SELECT 'block_nodes', b.id::text FROM block_nodes b JOIN content_nodes c ON c.id = b.note_id WHERE c.space_id = $1
           UNION ALL SELECT 'note_anchor_places', p.note_id::text FROM note_anchor_places p JOIN content_nodes c ON c.id = p.note_id WHERE c.space_id = $1`, [space])).rows;
        const stampsOfKeys = async () => Number((await q<{ n: string }>(
          `WITH k AS (SELECT * FROM unnest($2::text[], $3::text[]) AS k(t, k))
           SELECT ((SELECT count(*) FROM sync_stamps s JOIN k ON s.table_name = k.t AND s.row_key = k.k WHERE s.workspace_id = $1)
                 + (SELECT count(*) FROM sync_stamp_heads s JOIN k ON s.table_name = k.t AND s.row_key = k.k WHERE s.workspace_id = $1))::text AS n`,
          [ws, keys.map((x) => x.t), keys.map((x) => x.k)])).rows[0]!.n);
        const stampsHeld = await stampsOfKeys();
        const remove = await measured(() => stamped(async () => { await q(`DELETE FROM content_nodes WHERE space_id = $1`, [space]); }));
        expect(before - await anchors()).toBe(NOTES * PER);
        held[without215 ? "main" : "215"] = stampsHeld;
        // nothing of a row that went with its note is left in the stamp tables (round 6, point 3). THIS is what pins "no tombstone per row" (round 7, point 5): the bound
        // on rows written below leaves room for about one write per row (the stamps removed), so a tombstone per row would pass it; it cannot pass this.
        expect(await stampsOfKeys()).toBe(0);
        expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM block_nodes b JOIN content_nodes c ON c.id = b.note_id WHERE c.space_id = $1`, [space])).rows[0]!.n)).toBe(0);
        return { write, remove };
      });
    }
    console.log(`[anchor bulk cost] ${NOTES} notes x ${PER} anchors: main ${JSON.stringify(out.main)}; with 215 ${JSON.stringify(out["215"])}`);
    // per note: its unit (written or removed) and its stamp; per anchor row: what main already does. Nothing grows with the notes a transaction has touched before.
    for (const k of ["write", "remove"] as const) expect(out["215"]![k].read / out.main![k].read, k).toBeLessThanOrEqual(4);
    // a row gone with its note writes no tombstone of its own (round 5, point 1) and takes its stamps with it (round 6, point 3): what a deletion writes is main's rows,
    // the removal of the stamps those rows held (one row each in sync_stamps, counted) and the note's anchors unit; nothing is written for a row
    console.log(`[anchor bulk cost] stamps the space's rows held: ${held["215"]}`);
    expect(out["215"]!.remove.written, "remove").toBeLessThanOrEqual(out.main!.remove.written + held["215"]! + NOTES);
  }, 1_200_000);
});
