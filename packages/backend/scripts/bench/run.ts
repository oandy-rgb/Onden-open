// Backend half of `npm run bench`: the real service functions against the
// seeded _bench database, each timed N times (median / p95) after warm-up.
//
//   npx tsx scripts/bench/run.ts [--runs=9] [--only=substring]
//
// Writes <repo>/.bench/backend.json and the slim lean2 bootstrap the frontend
// half decodes (.bench/bootstrap-slim-lean2.json). Search needs pgroonga; with
// no pgroonga the two search metrics are reported as skipped, not as zero.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import pg from "pg";
import { summarize, timeMs, type Summary } from "../../../../scripts/bench/stats.mjs";
import { assertBenchDatabase, benchDatabaseUrl, SCHEMA_SKIPS } from "./common.js";
import { COMMON_WORD, MEDIA_FILENAME, RARE_WORD, SHAPE, readSeedRow, seedBenchDatabase } from "./seed.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../../../.bench");

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const RUNS = Number(arg("runs") ?? 9);
const only = arg("only");

const url = benchDatabaseUrl();
assertBenchDatabase(url);
// db.ts reads DATABASE_URL when it is first imported: point it at the bench database before that.
process.env.DATABASE_URL = url;

async function main() {
  let seeded = await readSeedRow(url);
  if (!seeded) {
    console.log("[bench] no seeded database yet; seeding (about 3 minutes)");
    await seedBenchDatabase(url);
    seeded = await readSeedRow(url);
  }
  if (!seeded) throw new Error("seeding did not produce a bench_seed row");
  const workspaceId = seeded.workspace_id;
  const actor = { id: seeded.owner_id, name: "Bench Owner", type: "human" as const };

  const { pool } = await import("../../src/db.js");
  const { buildBootstrap } = await import("../../src/services/sync/bootstrap.js");
  const { buildSyncDelta } = await import("../../src/services/sync/delta.js");
  const { runNodeQuery } = await import("../../src/services/nodeQuery.js");
  const { readTagCatalog } = await import("../../src/services/tagCatalog.js");
  const { loadServedSite, servedSiteShowsMedia } = await import("../../src/modules/website/publishing/servedSite.js");
  const { searchNodes } = await import("../../src/services/nodeSearch.js");
  const { Hono } = await import("hono");
  const { default: eventsRouter } = await import("../../src/routes/events.js");

  const probe = new pg.Client({ connectionString: url });
  await probe.connect();
  const hasPgroonga = (await probe.query("SELECT 1 FROM pg_extension WHERE extname = 'pgroonga'")).rowCount === 1;
  const lastEventId = Number((await probe.query("SELECT max(id) AS id FROM domain_events")).rows[0].id);
  await probe.end();

  const eventsApp = new Hono<{ Variables: { actor: typeof actor | null } }>();
  eventsApp.use(async (c, next) => { c.set("actor", actor); await next(); });
  eventsApp.route("/", eventsRouter as never);

  const metrics: Record<string, Summary> = {};
  const skipped: Record<string, string> = {};
  const extra: Record<string, number> = {};

  async function bench(name: string, fn: () => unknown, options: { runs?: number; warmup?: number } = {}) {
    if (only && !name.includes(only)) return;
    const runs = options.runs ?? RUNS;
    metrics[name] = await timeMs(fn, { runs, warmup: options.warmup ?? 2 });
    console.log(`[bench] ${name.padEnd(34)} median ${String(metrics[name]!.median).padStart(9)} ms   p95 ${String(metrics[name]!.p95).padStart(9)} ms   (${runs} runs)`);
  }

  // lean2 is what the app asks for; slim (?bodies=none) is what it picks from 2000 notes up.
  // The full-body path stops at BOOTSTRAP_NODE_LIMIT notes and is the slow one (review #8),
  // so it gets fewer runs.
  await bench("backend.bootstrap_lean", () => buildBootstrap(actor, workspaceId, { slimBodies: false, lean: true, compact: true }), { runs: 3, warmup: 1 });
  await bench("backend.bootstrap_slim", () => buildBootstrap(actor, workspaceId, { slimBodies: true, lean: true, compact: true }));
  await bench("backend.sync_delta_empty", () => buildSyncDelta(actor, workspaceId, { since: lastEventId, known: [] }));
  await bench("backend.sync_delta_500_events", () => buildSyncDelta(actor, workspaceId, { since: lastEventId - 500, known: [] }));

  if (hasPgroonga) {
    await bench("backend.search_common_word", () => searchNodes(workspaceId, COMMON_WORD, actor));
    await bench("backend.search_rare_word", () => searchNodes(workspaceId, RARE_WORD, actor));
  } else {
    for (const name of ["backend.search_common_word", "backend.search_rare_word"]) skipped[name] = "pgroonga is not installed in this Postgres";
    console.log("[bench] search skipped: pgroonga is not installed in this Postgres");
  }

  await bench("backend.node_query_sort_attribute", () => runNodeQuery(actor, workspaceId, { sort: "-status", limit: 50 }));
  await bench("backend.tag_catalog", () => readTagCatalog(actor, workspaceId));
  await bench("backend.served_site_load", () => loadServedSite(workspaceId), { runs: Math.min(RUNS, 5), warmup: 1 });
  await bench("backend.media_visibility_check", () => servedSiteShowsMedia(workspaceId, MEDIA_FILENAME, [seeded.media_owner_id]));
  await bench("backend.event_list_page", async () => {
    const res = await eventsApp.request("/?limit=50");
    if (res.status !== 200) throw new Error(`event list answered ${res.status}`);
    await res.text();
  });

  // The COMMIT of one import of 5,000 notes (src/test/versionCommitCost.integration.test.ts): every deferred check of migration 220 runs inside it, one
  // statement under the 15-second statement timeout of a server (db.ts). Its time, alone on this job; the integration test counts its rows instead (a
  // shared CI machine stretched the same COMMIT past 15 s). Last, because it writes: the notes are removed after each run (so each run starts from the
  // same table sizes), their events cannot be (domain_events is append-only), so the seed is marked stale and the next bench reseeds.
  if (!only || "backend.commit_5000_notes".includes(only)) {
    const { withTransaction } = await import("../../src/db.js");
    const { withEventTransaction } = await import("../../src/spine/eventTransaction.js");
    const { createNote } = await import("../../src/services/noteCreate.js");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const spaceId = (await admin.query<{ id: string }>("SELECT id::text AS id FROM spaces WHERE workspace_id = $1 AND is_default LIMIT 1", [workspaceId])).rows[0]!.id;
    const samples: number[] = [];
    try {
      for (let run = 0; run < Math.min(RUNS, 3); run++) {
        const ids = Array.from({ length: 5000 }, () => randomUUID());
        let workEnd = 0;
        try {
          await withTransaction(() => withEventTransaction(workspaceId, async () => {
            for (const [i, id] of ids.entries()) {
              await createNote({ actor, workspaceId, id, title: `Bench import ${i}`, markdown: `Bench import ${i}\n\nwith a line of text`, spaceId, event: { uiContext: "bench.import" } });
            }
            workEnd = performance.now();
          }));
          samples.push(performance.now() - workEnd);
        } finally {
          await admin.query("DELETE FROM content_nodes WHERE id = ANY($1::uuid[])", [ids]);
        }
      }
    } finally {
      await admin.query("DELETE FROM bench_seed"); // the events stay: the next `npm run bench` reseeds
      await admin.end();
    }
    metrics["backend.commit_5000_notes"] = summarize(samples, "ms");
    console.log(`[bench] ${"backend.commit_5000_notes".padEnd(34)} median ${String(metrics["backend.commit_5000_notes"]!.median).padStart(9)} ms   (${samples.length} runs; the statement timeout is 15000 ms)`);
  }

  // The payload the frontend half decodes: what GET /api/bootstrap?bodies=none sends to lean2 clients.
  if (!only || "frontend".includes(only) || only.includes("bootstrap")) {
    const payload = await buildBootstrap(actor, workspaceId, { slimBodies: true, lean: true, compact: true });
    const json = JSON.stringify(payload);
    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, "bootstrap-slim-lean2.json"), json);
    extra.bootstrap_slim_lean2_bytes = Buffer.byteLength(json);
    extra.bootstrap_slim_lean2_gzip_bytes = gzipSync(json).length;
    extra.bootstrap_slim_lean2_nodes = (payload as { nodes: unknown[] }).nodes.length;
  }

  await pool.end();
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, "backend.json"), JSON.stringify({
    part: "backend", database: assertBenchDatabase(url), shape: SHAPE, runs: RUNS, hasPgroonga,
    skippedSchema: SCHEMA_SKIPS, metrics, skipped, extra,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
