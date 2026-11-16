// Measurement (prints a table; asserts nothing): what each stroke saved on a PDF note
// adds to the database. MEASURE_N=1000 MEASURE_EVERY=1 to change the run.
import { describe, it, vi, beforeAll } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { makePatch } from "@onden/markdown";
import { pdfInkSim } from "./helpers/pdfInkEnvelope.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(DB);
vi.mock("../auth.js", () => ({
  auth: { handler: vi.fn(async () => new Response("noop", { status: 200 })), api: { getSession: vi.fn(async () => null) }, $context: Promise.resolve({ runMigrations: async () => {} }) },
}));
const { app } = await import("../app.js");
const req = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json, ...rest } = init;
  return Promise.resolve(app.request(path, { ...rest, headers: { origin: "http://localhost", ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : rest.body }));
};
const sizes = async () => {
  const r = await q<{ t: string; b: string; n: string }>(
    `SELECT relname AS t, pg_total_relation_size(c.oid)::text AS b, COALESCE(c.reltuples,0)::text AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relkind = 'r'`);
  const out: Record<string, number> = {};
  for (const row of r.rows) out[row.t] = Number(row.b);
  return out;
};
const count = async (table: string) => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]!.n);

describe.skipIf(!isTestDb)("measure", () => {
  let spaceId = "";
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const wsId = await getWorkspaceId();
    spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [wsId])).rows[0]!.id;
  });
  it("prints", async () => {
    const n = Number(process.env.MEASURE_N ?? 100), every = Number(process.env.MEASURE_EVERY ?? 10);
    const id = ((await (await req("/api/nodes", { method: "POST", json: { space_id: spaceId, title: "pdf ink measure", markdown: "x" } })).json()) as { id: string }).id;
    const sim = pdfInkSim();
    let prev = "";
    const before = await sizes();
    const base = { events: await count("domain_events"), blobs: await count("blobs") };
    let sent = 0, last = prev;
    for (let i = 1; i <= n; i++) {
      const next = sim.drawStroke();
      const body = prev === "" ? { value: next, value_type: "text", is_inheritable: false } : { value_patch: makePatch(prev, next), value_type: "text", is_inheritable: false };
      const raw = JSON.stringify(body);
      sent += Buffer.byteLength(raw);
      const res = await app.request(`/api/nodes/${id}/attributes/ink_data`, { method: "PUT", headers: { origin: "http://localhost", "content-type": "application/json" }, body: raw });
      if (res.status !== 200) throw new Error(`save ${i}: ${res.status} ${await res.text()}`);
      prev = next; last = next;
      if (i % every === 0 && i === n) break;
    }
    // The live attribute row is rewritten by every save; its old versions are dead space the database reuses (autovacuum on a
    // server, here by hand), not growth.
    await q(`VACUUM FULL node_attributes`).catch(() => undefined);
    const after = await sizes();
    const d = (t: string) => (after[t] ?? 0) - (before[t] ?? 0);
    const total = Object.keys(after).reduce((a, t) => a + d(t), 0);
    const chunkRows = (await count("ink_chunks")), manifestRows = (await count("ink_manifests"));
    console.log(`chunkRows=${chunkRows} manifestRows=${manifestRows} chunksBytes=${d("ink_chunks")} manifestsBytes=${d("ink_manifests")}`);
    console.log(`N=${n} valueBytes=${Buffer.byteLength(last)} wirePerSave=${Math.round(sent / n)} blobsRows=${(await count("blobs")) - base.blobs} eventsRows=${(await count("domain_events")) - base.events}`
      + ` blobsBytes=${d("blobs")} eventsBytes=${d("domain_events")} attrBytes=${d("node_attributes")} totalDbGrowth=${total} perSave=${Math.round(total / n)}`);
  }, 3_000_000);
});
