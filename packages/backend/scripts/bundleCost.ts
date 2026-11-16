// Time and peak memory to read and to apply a change bundle of N stamps (batch 2b-1), on PGlite in Node. Run: ONDEN_DB_DRIVER=pglite DATABASE_URL=postgres://x@localhost/onden_cloud_test npx tsx scripts/bundleCost.ts 1000
// Two PGlite databases in one process: node A holds a joined workspace,
// B joined it by snapshot, then A writes N notes (N unit stamps `*`, plus a title edit for every second one: the count printed is the stamps the bundle carries) and B takes them as one bundle.
// What this does NOT tell: a phone. It is a desktop Node process with an in-memory database (no storage, no WASM memory limit of a browser tab, no throttled CPU).
// (the script migrates one in-memory PGlite itself and uses its dump as the template both nodes start from.)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

delete process.env.ONDEN_PGLITE_SNAPSHOT;
const { migrate, pool, pglite, q, withTransaction } = await import("../src/db.js");
await migrate();
const template = join(mkdtempSync(join(tmpdir(), "bundle-cost-")), "template.tar");
writeFileSync(template, Buffer.from(await (await (await pglite!.database()).dumpDataDir("none")).arrayBuffer()));
await pool.end();
process.env.ONDEN_PGLITE_SNAPSHOT = template;
const { withRequestDevice } = await import("../src/requestContext.js");
const { buildSourceWorld, capture, fillFrom, openNode } = await import("../src/test/helpers/stampedWorld.js");
const { admit, bundleFor, peerOf, take } = await import("../src/test/helpers/stampedBundleWorld.js");
const { onNode } = await import("../src/test/helpers/distSim/realNode.js");
const { withEventTransaction } = await import("../src/spine/eventTransaction.js");
const { stampTransaction } = await import("../src/spine/stamps.js");

const n = Number(process.argv[2] ?? 1000);
// peak resident memory of the whole process so far (the kernel's high-water mark): a sampling timer cannot run while PGlite's WASM holds the thread
const peakMB = () => Math.round(process.resourceUsage().maxRSS / 1024);

const na = await openNode("a"), nb = await openNode("b");
const world = await buildSourceWorld(na);
await fillFrom(nb, world, await capture(na, world, 1_000_000));
const a = peerOf("A", na, world), b = peerOf("B", nb, world);
await admit(a, b);
// N stamps at A, in batches (one transaction and one stamp per 100 notes: the triggers stamp every row's `*` and every edited title)
await onNode(na, async () => {
  for (let done = 0; done < n; done += 200) {
    const batch = Math.min(200, n - done);
    await withRequestDevice(randomUUID(), () => withTransaction(() => withEventTransaction(world.ws, async () => {
      await stampTransaction(world.ws, world.owner.id);
      await q(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id)
               SELECT gen_random_uuid(), $1, 'manual', 'content', 'cost ' || g, 'cost-' || $3 || '-' || g, 'body ' || g, $2 FROM generate_series(1, $4::int) g`, [world.ws, world.spaceA, done, batch]);
    })));
  }
});
const stampsHere = await onNode(na, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes'`, [world.ws])).rows[0]!.n));
const beforeRead = peakMB();
const t0 = performance.now();
const bundle = await bundleFor(a, b);
const readMs = performance.now() - t0, readPeak = peakMB(), bytes = JSON.stringify(bundle).length;
const carried = bundle.items.reduce((s, i) => s + (i.kind === "row" ? i.stamps.length : 1), 0);
const t1 = performance.now();
const report = await take(b, bundle);
const applyMs = performance.now() - t1, applyPeak = peakMB();
console.log(JSON.stringify({ requestedStamps: n, stampsAtSender: stampsHere, stampsInBundle: carried, rowsCreated: report.created, bundleMB: +(bytes / 1024 / 1024).toFixed(2), readMs: Math.round(readMs), processPeakRssMBBeforeRead: beforeRead, processPeakRssMBAfterRead: readPeak, applyMs: Math.round(applyMs), processPeakRssMBAfterApply: applyPeak }));
rmSync(join(template, ".."), { recursive: true, force: true });
process.exit(0);
