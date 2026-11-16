// Cost of copying a workspace with its write stamps to an empty database (services/stampedSnapshot.ts → services/stampedJoin.ts), in-memory PGlite:
//   npx tsx scripts/measure-stamped-snapshot.mts [notes]        (default 1000; the report uses 1000 and 20000)
// Two databases in one process (the backend reaches its database through one handle; this swaps it, as the test helper distSim/realNode.ts does).
// The source is seeded the way scripts/measure-genesis-s5.mts does (triggers off while seeding, then migration 202's pass stamps everything),
// plus one real person; the receiver is a database that was only migrated. It prints, for the export and for the import (with the finish:
// the receiver's digest and the comparison): milliseconds, the highest resident memory seen (sampled every 20 ms, minus what the process held
// when the phase began), and for the pages: how many, their total JSON bytes and the bytes after gzip level 6 (what would cross the wire).
// Counts and sizes only; no real data is used.
//
// Environment (all optional):
//   RECEIVER_TAR=<file>        the receiver is the browser app's packaged database (tsx src/browser/prepareSnapshot.ts <file>), opened the way a browser
//                              copy starts (its own node id, its one local sign-in joined to the snapshot's person), instead of a freshly migrated one
//   DROP_PARENT_INDEX=1        drop migration 205's content_nodes_parent_idx in both databases first: the cost before the index
// Memory, two numbers per phase (node --expose-gc, so retained is read after a collection): peakMiB = the highest resident set seen DURING the phase minus what the
// process held when it began; retainedMiB = what the process holds AFTER the phase (after gc and a 300 ms pause) minus what it held when it began. PGlite's wasm memory
// never goes back to the system, so retained is the growth of the database's own heap plus what the phase left in JS; both source and receiver databases are in this
// process, so the figures are for the receiving PHASE, not for a browser tab (the pages here are also kept as JSON strings, as a stream would not).
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { setEnvironment } from "../src/config.js";

setEnvironment({
  NODE_ENV: "production", ONDEN_DB_DRIVER: "pglite", ONDEN_PGLITE_DIR: "memory://",
  BETTER_AUTH_SECRET: "measure-only-never-used-to-sign-a-session", BETTER_AUTH_URL: "http://localhost", LOG_LEVEL: "warn",
});
const N = Number(process.argv[2] ?? 1000);
const db = await import("../src/db.js");
const { openPglite } = await import("../src/dbPglite.js");
const { readStampedPages } = await import("../src/services/stampedSnapshot.js");
const { abandonJoin, applyJoinPage, finishJoin, startJoin } = await import("../src/services/stampedJoin.js");
type Page = import("../src/spine/snapshotSql.js").StampedPage;

const holder = db.pglite as unknown as { opened: Promise<unknown> };
const sourceDb = await db.pglite!.database();
await db.migrate();
const receiverDb = await openPglite({ dataDir: "memory://", loadDataDir: async () => undefined });
holder.opened = Promise.resolve(receiverDb);
await db.migrate();
holder.opened = Promise.resolve(sourceDb);

if (process.env.DROP_PARENT_INDEX) {
  await db.q(`DROP INDEX IF EXISTS content_nodes_parent_idx`);
  holder.opened = Promise.resolve(receiverDb); await db.q(`DROP INDEX IF EXISTS content_nodes_parent_idx`); holder.opened = Promise.resolve(sourceDb);
}
const ms = (t: number) => Math.round(performance.now() - t);
const mib = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
async function peakOf<T>(work: () => Promise<T>): Promise<{ value: T; ms: number; peakMiB: number; retainedMiB: number }> {
  global.gc?.();
  const base = process.memoryUsage().rss;
  let peak = base;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  const t = performance.now();
  try {
    const value = await work();
    const took = ms(t);
    const high = Math.max(peak, process.memoryUsage().rss);
    clearInterval(timer);
    global.gc?.(); await new Promise((r) => setTimeout(r, 300)); global.gc?.();
    return { value, ms: took, peakMiB: mib(high - base), retainedMiB: mib(process.memoryUsage().rss - base) };
  } finally { clearInterval(timer); }
}

const { q } = db;
const ws = await db.getWorkspaceId();
const space = (await q(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
const owner = (await q(`INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'm', 'human') RETURNING id::text`, [ws])).rows[0]!.id;
const person = { id: owner, name: "m", type: "human" as const };

let t = performance.now();
await db.allowUnstampedWrite("measurement fixture", () => db.withTransaction(async () => {
  await q(`SET LOCAL session_replication_role = replica`);
  const TAGS = 60;
  await q(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, tag_schema)
           SELECT $1, 'manual', 'class_tag', 'tag ' || g, 'tag-m-' || g, jsonb_build_object('fields', jsonb_build_array(jsonb_build_object('name','a')), 'k' || g, g)
             FROM generate_series(1, $2::int) g`, [ws, TAGS]);
  await q(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id, deleted_at)
           SELECT $1, 'manual', 'content', 'note ' || g, 'note-m-' || g, repeat('body ', 40), $2, CASE WHEN g % 20 = 0 THEN now() END
             FROM generate_series(1, $3::int) g`, [ws, space, N]);
  const notes = `(SELECT id, row_number() OVER (ORDER BY slug) AS rn FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content' AND slug LIKE 'note-m-%')`;
  const tags = `(SELECT id, row_number() OVER (ORDER BY slug) AS rn FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag')`;
  await q(`UPDATE content_nodes c SET parent_id = p.id FROM ${notes} p, ${notes} k WHERE c.id = k.id AND k.rn % 5 <> 0 AND p.rn = (k.rn / 5) + 1 AND p.id <> k.id`, [ws]);
  await q(`INSERT INTO node_tags (node_id, tag_id) SELECT n.id, tg.id FROM ${notes} n JOIN ${tags} tg ON tg.rn = (n.rn % ${TAGS}) + 1`, [ws]);
  await q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) SELECT $1, n.id, k.key, 'v' || n.rn, k.source FROM ${notes} n CROSS JOIN (VALUES ('status','ui'), ('prio','explicit')) k(key, source) WHERE n.rn % 3 <> 0`, [ws]);
  await q(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) SELECT $1, a.id, b.id, 'relates_to', 'active', 'manual' FROM ${notes} a JOIN ${notes} b ON b.rn = a.rn + 1 WHERE a.rn % 2 = 0`, [ws]);
  await q(`INSERT INTO node_positions (node_id, surface, x, y, workspace_id) SELECT n.id, 'graph', n.rn, n.rn, $1 FROM ${notes} n WHERE n.rn % 2 = 0`, [ws]);
}));
await q(`SELECT * FROM sync_genesis_pass()`);
const seedMs = ms(t);

const pages: string[] = [];
let summary!: Awaited<ReturnType<typeof readStampedPages>>;
const exported = await peakOf(async () => {
  summary = await readStampedPages(person, ws, { since: null, layer: "rows" }, async (page) => { pages.push(JSON.stringify(page)); });
});
const jsonBytes = pages.reduce((n, p) => n + Buffer.byteLength(p), 0);
const gzipBytes = pages.reduce((n, p) => n + gzipSync(p, { level: 6 }).length, 0);
const rowsInSnapshot = summary.digest.reduce((n, d) => n + d.rows, 0);
const stampsInSnapshot = summary.digest.reduce((n, d) => n + d.stamps, 0);

let login: string | null = null;
if (process.env.RECEIVER_TAR) {
  const { readFile } = await import("node:fs/promises");
  const tar = new Blob([await readFile(process.env.RECEIVER_TAR)]);
  const packaged = await openPglite({ dataDir: "memory://", loadDataDir: async () => tar });
  holder.opened = Promise.resolve(packaged);
  const { ensureOwnNodeId } = await import("../src/browser/nodeIdentity.js");
  await ensureOwnNodeId();
  login = (await db.q<{ id: string }>(`SELECT id FROM "user" LIMIT 1`)).rows[0]!.id;
} else holder.opened = Promise.resolve(receiverDb);
const imported = await peakOf(async () => {
  await startJoin({ workspaceId: ws, sourceNode: summary.source, cutSeq: summary.cut, personActorId: owner });
  let applyMs = 0;
  for (const text of pages) { const t0 = performance.now(); await applyJoinPage(JSON.parse(text) as Page); applyMs += performance.now() - t0; }
  const t1 = performance.now();
  try { await finishJoin({ workspaceId: ws, pages: pages.length, digest: summary.digest, localLogin: login }); }
  catch (error) { await abandonJoin(ws); throw error; }
  return { applyMs: Math.round(applyMs), finishMs: ms(t1) };
});

console.log(JSON.stringify({
  notes: N, seedMs, rowsInSnapshot, stampsInSnapshot, pages: pages.length, jsonMiB: mib(jsonBytes), gzipMiB: mib(gzipBytes),
  receiver: process.env.RECEIVER_TAR ? "packaged browser database" : "freshly migrated database", parentIndex: process.env.DROP_PARENT_INDEX ? "dropped" : "present",
  export: { ms: exported.ms, peakMiB: exported.peakMiB, retainedMiB: exported.retainedMiB }, import: { ms: imported.ms, peakMiB: imported.peakMiB, retainedMiB: imported.retainedMiB, ...imported.value },
}, null, 1));
process.exit(0);
