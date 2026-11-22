// The first save of a note that gets many anchors at once (a note written with many tagged paragraphs, an import, a restore) costs work in proportion to the anchors
// (review of PR #1853 after the merge, N2). Before, each new anchor was its own INSERT statement, and the statement-level trigger of migration 215 rewrote the whole anchors
// unit after each one (note_anchor_places_follow) and the commit-time check ran once per statement: n anchors cost n rewrites of a unit of up to n entries, quadratic.
// The bound is on the rows the database reads (pg_stat_user_tables), not on time: four times the anchors read at most 4 × 1.25 times the rows. Times are printed
// (ONDEN_SAVE_COST_REPORT=1 also prints an ordinary save, and a one-character edit of a note with 200 anchors), never asserted. Both engines.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { dbDriver, pool, q, withTransaction } from "../db.js";
import { withRequestDevice } from "../requestContext.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction } from "../spine/stamps.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, makeCaller, openNode } from "./helpers/stampedWorld.js";
import { awaitAllDispatchers, inflightNodeIds } from "../services/dispatcherQueue.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

/** Rows read so far, every table (sequential and index fetches), once every connection's counts are in (anchorSaveCost.integration.test.ts `stats`: a backend sends its
 *  counts at most once a second, and pg_stat_force_next_flush() reaches only the backend that calls it, so the work a save leaves is awaited and every idle one flushes). */
async function rowsRead(): Promise<number> {
  while (inflightNodeIds().length > 0) await awaitAllDispatchers();
  await q(`SELECT pg_stat_force_next_flush()`); await q(`SELECT 1`);
  if (dbDriver === "postgres") {
    const clients = await Promise.all(Array.from({ length: pool.idleCount }, () => pool.connect()));
    try { for (const c of clients) { await c.query(`SELECT pg_stat_force_next_flush()`); await c.query(`SELECT 1`); } } finally { for (const c of clients) c.release(); }
  }
  await q(`SELECT pg_stat_clear_snapshot()`);
  return Number((await q<{ r: string }>(`SELECT (sum(seq_tup_read) + sum(COALESCE(idx_tup_fetch, 0)))::text AS r FROM pg_stat_user_tables`)).rows[0]!.r);
}
const tagged = (n: number, line: (i: number) => string = (i) => `Paragraph ${i} of the long note, tagged so it gets an anchor {kept}`) => Array.from({ length: n }, (_, i) => line(i)).join("\n\n") + "\n";

type Cost = { anchors: number; rows: number; ms: number };
/** A note made empty, then saved once with `n` tagged paragraphs (n new anchors in that one save). */
async function firstSave(n: number, line?: (i: number) => string): Promise<Cost & { edit?: { rows: number; ms: number }; plain?: { rows: number; ms: number } }> {
  const node = await openNode(`save${n}`);
  open.push(node);
  const world = await buildSourceWorld(node);
  return onNode(node, async () => {
    const call = makeCaller(world.owner);
    const note = (await call("POST", "/api/nodes", { title: "Long", markdown: "", space_id: world.spaceA })).id as string;
    const plainNote = (await call("POST", "/api/nodes", { title: "Plain", markdown: "No tags here.\n", space_id: world.spaceA })).id as string;
    // a node of some size (2,000 notes with their stamps), analyzed, as a node with data is: on a world smaller than the save, every look-up is planned as a scan of a tiny table
    await withRequestDevice(randomUUID(), () => withTransaction(() => withEventTransaction(world.ws, async () => {
      await stampTransaction(world.ws, world.owner.id);
      await q(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
               SELECT $1, 'manual', 'content', 'filler ' || g, 'filler-' || g, 'body ' || g, $2 FROM generate_series(1, 2000) g`, [world.ws, world.spaceA]);
    })));
    await awaitAllDispatchers();
    await q(`ANALYZE`);
    const start = await rowsRead();
    const per = async () => new Map((await q<{ t: string; s: string; i: string; n: string }>(`SELECT relname AS t, seq_tup_read::text AS s, COALESCE(idx_tup_fetch,0)::text AS i, seq_scan::text AS n FROM pg_stat_user_tables`)).rows.map((r) => [r.t, [Number(r.s), Number(r.i), Number(r.n)]] as const));
    const before = process.env.ONDEN_SAVE_COST_TABLES === "1" ? await per() : new Map();
    let t = performance.now();
    await call("PATCH", `/api/nodes/${note}`, { markdown: tagged(n, line) });
    const ms = performance.now() - t;
    const rows = (await rowsRead()) - start;
    if (process.env.ONDEN_SAVE_COST_TABLES === "1") { const after = await per(); console.log(`[tables ${n}]`, [...after].map(([t, v]) => { const b = before.get(t) ?? [0, 0, 0]; return [t, v[0]! - b[0]!, v[1]! - b[1]!, v[2]! - b[2]!] as const; }).filter((x) => x[1] + x[2] > 0).sort((x, y) => (y[1] + y[2]) - (x[1] + x[2])).slice(0, 8).map((x) => `${x[0]} seq ${x[3]}×=${x[1]} idx=${x[2]}`).join("; ")); }
    await awaitAllDispatchers();
    const anchors = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM block_anchors WHERE note_id = $1`, [note])).rows[0]!.n);
    if (process.env.ONDEN_SAVE_COST_REPORT !== "1") return { anchors, rows, ms };
    // a one-character edit of the note that now has n anchors, and an ordinary save of a note without any
    const s1 = await rowsRead(); t = performance.now();
    await call("PATCH", `/api/nodes/${note}`, { markdown: tagged(n).replace("Paragraph 0 ", "Paragraph 0. ") });
    const edit = { ms: performance.now() - t, rows: (await rowsRead()) - s1 };
    await awaitAllDispatchers();
    const s2 = await rowsRead(); t = performance.now();
    await call("PATCH", `/api/nodes/${plainNote}`, { markdown: "No tags here, edited.\n" });
    const plain = { ms: performance.now() - t, rows: (await rowsRead()) - s2 };
    await awaitAllDispatchers();
    return { anchors, rows, ms, edit, plain };
  });
}

describe.skipIf(!isTestDb)("a note's first save with many new anchors", () => {
  // Review of PR #1940, round 1, point 5: one statement takes at most 65,535 parameters (9 a new paragraph row: 7,281 rows). A save reads paragraphs only in a body of at
  // most 32,000 characters (@onden/markdown BLOCK_PARSE_MAX), so the most one save makes is about 4,500 (`a {k}` and a blank line each): that save is taken. The rows are
  // still written in parts of 5,000 (blockNodes.ts INSERT_PART_ROWS), a guard in case that bound moves.
  it("the largest save a body allows (4,500 new tagged paragraphs in 31,500 characters) is taken: every paragraph has its anchor and its row", async () => {
    const c = await firstSave(4500, () => "a {k}");
    console.log(`[first save] ${c.anchors} anchors in one save: ${c.rows} rows, ${Math.round(c.ms)} ms`);
    expect(c.anchors).toBe(4500);
  }, 900_000);

  it("four times the anchors in one save read at most 5 times the rows (it was quadratic: one statement and one rewrite of the whole unit per anchor)", async () => {
    const small = await firstSave(100);
    const large = await firstSave(400);
    expect([small.anchors, large.anchors]).toEqual([100, 400]);
    console.log(`[first save] ${small.anchors} anchors: ${small.rows} rows, ${Math.round(small.ms)} ms; ${large.anchors} anchors: ${large.rows} rows, ${Math.round(large.ms)} ms (${(large.rows / small.rows).toFixed(2)}×)`);
    expect(large.rows / small.rows).toBeLessThanOrEqual(4 * 1.25);
    // ONDEN_SAVE_COST_REPORT=1: a save with 200 new anchors, a one-character edit of that note, an ordinary save, three times (printed only; a test that skips would
    // trip the skip gate, so this is part of the test above)
    if (process.env.ONDEN_SAVE_COST_REPORT === "1") for (let k = 0; k < 3; k++) {
      const c = await firstSave(200);
      console.log(`[save cost] first save with ${c.anchors} anchors: ${Math.round(c.ms)} ms, ${c.rows} rows; one-character edit of it: ${Math.round(c.edit!.ms)} ms, ${c.edit!.rows} rows; ordinary save: ${Math.round(c.plain!.ms)} ms, ${c.plain!.rows} rows`);
    }
  }, 900_000);

});
