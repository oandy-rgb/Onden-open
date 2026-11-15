// Frontend half of `npm run bench`. The input is the slim lean2 bootstrap the
// backend half wrote from the seeded 20k-note workspace
// (<repo>/.bench/bootstrap-slim-lean2.json); the code under test is the real
// app code, run in Node with a real sql.js database. Output: <repo>/.bench/frontend.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { describe, expect, it } from "vitest";
import { timeMs, type Summary } from "../../../../scripts/bench/stats.mjs";
import type { Bootstrap } from "../../src/lib/api";
import { decodeBootstrapWire } from "../../src/lib/data/bootstrapWire";
import { applySyncDelta, patchNode } from "../../src/lib/data/storeOps";
import type { AppliedSyncDelta } from "../../src/lib/localDb";
import { persistBootstrapInto } from "../../src/lib/localDbPersist";
import { prepareLocalDatabase } from "../../src/lib/localDbSchema";
import { tagMemberCounts } from "../../src/lib/nodeTags";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../../../.bench");
const payloadPath = resolve(outDir, "bootstrap-slim-lean2.json");
const RUNS = Number(process.env.BENCH_RUNS ?? 9);

describe("frontend benchmark", () => {
  it("measures the bootstrap, delta and tag-count paths", async () => {
    expect(existsSync(payloadPath), `${payloadPath} is written by the backend half (npm run bench)`).toBe(true);
    const wire = JSON.parse(readFileSync(payloadPath, "utf8")) as Bootstrap;
    const metrics: Record<string, Summary> = {};
    const record = async (name: string, ...args: Parameters<typeof timeMs>) => {
      metrics[name] = await timeMs(...args);
      console.log(`[bench] ${name.padEnd(34)} median ${String(metrics[name]!.median).padStart(9)} ms   p95 ${String(metrics[name]!.p95).padStart(9)} ms   (${RUNS} runs)`);
    };

    let decoded = decodeBootstrapWire(wire);
    await record("frontend.decode_bootstrap_wire", () => { decoded = decodeBootstrapWire(wire); }, { runs: RUNS });
    expect(decoded.nodes.length).toBeGreaterThan(20_000);

    // A cold start: an empty local database, the whole payload written into it.
    const SQL: SqlJsStatic = await initSqlJs();
    let db: Database | null = null;
    await record("frontend.persist_bootstrap_into", () => persistBootstrapInto(db!, decoded), {
      runs: RUNS,
      prepare: () => { db?.close(); db = new SQL.Database(); prepareLocalDatabase(db); },
    });
    const stored = db!.exec("SELECT count(*) FROM nodes")[0]!.values[0]![0];
    expect(stored).toBe(decoded.nodes.length);
    db!.close();

    // 500 changed notes arriving over 20k held ones (a reconnect after a day offline).
    const changed = decoded.nodes.filter((_, i) => i % 40 === 0).slice(0, 500).map((n) => ({ ...n, title: `${n.title}!`, updated_at: "2026-10-24T00:00:00Z" }));
    expect(changed).toHaveLength(500);
    const delta: AppliedSyncDelta = {
      last_event_id: "1",
      nodes: { upsert: changed, delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] },
      attributes: { upsert: [], delete: [] }, workspace: null,
    };
    let applied = decoded;
    await record("frontend.apply_sync_delta_500_upserts", () => { applied = applySyncDelta(decoded, delta); }, { runs: RUNS });
    expect(applied.nodes).toHaveLength(decoded.nodes.length);

    // An autosave that only touches the body: the counts are recomputed over a new nodes array.
    const patched = patchNode(decoded, decoded.nodes[100]!.id, { markdown: "edited" });
    const tags = decoded.tags ?? [];
    expect(tags.length).toBeGreaterThan(0);
    let counts = new Map<string, number>();
    await record("frontend.tag_member_counts_after_body_patch", () => { counts = tagMemberCounts(tags, patched.nodes); }, { runs: RUNS });
    expect(counts.size).toBeGreaterThan(0);

    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "frontend.json"), JSON.stringify({
      part: "frontend", runs: RUNS, nodes: decoded.nodes.length, edges: decoded.edges.length, attributes: decoded.attributes?.length ?? 0, metrics,
    }, null, 2));
  });
});
