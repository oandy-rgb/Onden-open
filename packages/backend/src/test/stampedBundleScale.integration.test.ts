// Taking a bundle costs time in proportion to its size (review of PR #1758, item 1). The first version took 17.5 s for 1,000 rows and 438 s for 10,000: every statement compared the row id as TEXT
// (`id::text = $1`), which keeps the primary key's index from being used, so each of the ~40 statements per row scanned the table; the rows of a bundle were also matched to their stamps with a filter per row.
// This fails when the cost per row grows with the size again: a bundle four times as large must not take more than 5.2 times as long (linear is 4; the broken version was 6.2 for 1,000 → 4,000). stampedBundle.guard.test.ts also forbids the text comparison itself, which this size alone shows only in part.
// SAFETY: PGlite databases made from the migrated template; only in a PGlite run.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { withRequestDevice } from "../requestContext.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction } from "../spine/stamps.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, bundleFor, peerOf, take } from "./helpers/stampedBundleWorld.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "") && process.env.ONDEN_DB_DRIVER === "pglite";
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

async function applyMs(rows: number): Promise<number> {
  const na = await openNode("a"), nb = await openNode("b");
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  const a = peerOf("A", na, world), b = peerOf("B", nb, world);
  await admit(a, b);
  await onNode(na, async () => {
    for (let done = 0; done < rows; done += 200) {
      await withRequestDevice(randomUUID(), () => withTransaction(() => withEventTransaction(world.ws, async () => {
        await stampTransaction(world.ws, world.owner.id);
        await q(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id)
                 SELECT gen_random_uuid(), $1, 'manual', 'content', 'scale ' || g, 'scale-' || $3::int || '-' || g, 'body ' || g, $2 FROM generate_series(1, $4::int) g`,
        [world.ws, world.spaceA, done, Math.min(200, rows - done)]);
      })));
    }
  });
  const bundle = await bundleFor(a, b);
  const t = performance.now();
  const report = await take(b, bundle);
  const ms = performance.now() - t;
  expect(report.created).toBe(rows);
  return ms;
}

describe.skipIf(!isTestDb)("the cost of taking a bundle grows in proportion to its size", () => {
  it("four times the rows take less than 5.2 times as long", async () => {
    const small = await applyMs(500);
    const large = await applyMs(2000);
    expect(large / small, `500 rows: ${Math.round(small)} ms, 2,000 rows: ${Math.round(large)} ms`).toBeLessThan(5.2);
  }, 240_000);
});
