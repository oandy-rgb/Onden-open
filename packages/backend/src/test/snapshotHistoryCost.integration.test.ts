// The cost of reading the history part of a snapshot grows with the number of versions, not faster (review of PR #1988, round 1, point 2c; spine/historyLayer.ts
// COST): the set is worked out once and every later read goes by key. Measured as rows read (helpers/rowsRead.ts), not time, at two sizes four times apart, both large enough that the planner goes by index (at a few dozen notes a scan of the whole small table is cheaper and the ratio says nothing).
// realPostgresAlso: the planner's choices (an index lookup by key, not a scan per chunk) are the engine's; on Postgres they are its own
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { readHistoryPages } from "../services/stampedSnapshot.js";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { rowsRead } from "./helpers/rowsRead.js";
import { buildSourceWorld, openNode } from "./helpers/stampedWorld.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
/** Four times the versions may read at most this many times the rows (4 plus a margin for the fixed part: the world's own notes, the catalog lookups). */
const MAX_RATIO = 4.6;

describe.skipIf(!isTestDb)("the cost of reading the history part", () => {
  const open: RealNode[] = [];
  afterAll(async () => { for (const n of open) await n.close(); });

  /** A source with `notes` notes of three saves each; the rows the database read while the whole history part (plan, pages, digests) was read. */
  async function cost(notes: number): Promise<{ versions: number; rows: number }> {
    const node = await openNode(`history-cost-${notes}-${randomUUID().slice(0, 6)}`);
    open.push(node);
    const world = await buildSourceWorld(node);
    await onNode(node, async () => {
      for (let i = 0; i < notes; i++) {
        const id = (await world.call("POST", "/api/nodes", { title: `Note ${i}`, markdown: `first ${i}`, space_id: world.spaceA })).id as string;
        await world.call("PATCH", `/api/nodes/${id}`, { markdown: `second ${i}` });
        await world.call("PATCH", `/api/nodes/${id}`, { markdown: `third ${i}` });
      }
      await q(`ANALYZE`);
    });
    const cut = await onNode(node, async () => Number((await q<{ n: string }>(`SELECT next_seq::text AS n FROM sync_clock WHERE workspace_id = $1`, [world.ws])).rows[0]!.n) - 1);
    const before = await rowsRead(node);
    const read = await onNode(node, () => readHistoryPages(world.owner, world.ws, { cut, pageBytes: 8_000 }, async () => undefined));
    return { versions: read.digests.all.versions, rows: (await rowsRead(node)) - before };
  }

  it("four times the versions read at most about four times the rows", async () => {
    const small = await cost(120);
    const large = await cost(480);
    // eslint-disable-next-line no-console
    console.log(`[history cost] ${small.versions} versions read ${small.rows} rows, ${large.versions} read ${large.rows} (${(large.rows / small.rows).toFixed(2)}×)`);
    expect(large.versions).toBeGreaterThan(small.versions * 3);
    expect(large.rows / small.rows).toBeLessThanOrEqual(MAX_RATIO);
  }, 600_000);
});
