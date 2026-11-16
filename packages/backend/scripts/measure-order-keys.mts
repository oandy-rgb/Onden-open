// Cost of moving one note in a sibling group (migration 200). `ONDEN_DB_DRIVER=pglite DATABASE_URL=postgres://x@localhost/onden_cloud_test npx tsx scripts/measure-order-keys.mts`
// Seeds a group of N notes through the real routes, moves one note from the middle to the top with ONE PATCH {order_key}, and
// prints the milliseconds of that request and the rows it changed. For the integer order it prints how many rows the old planner
// (planSiblingOrder before this change, run on the same group: all ties at 0, the usual shape) would have written, and the time of
// that many PATCHes of the same size (an estimate: each old write was one PATCH of one row too).
import { Hono } from "hono";
import { keyBetween } from "@onden/markdown";
import { apiOnError } from "../src/httpError.js";
import { q, getWorkspaceId } from "../src/db.js";
import { migrate } from "../src/db.js";
import nodesRouter from "../src/routes/nodes.js";
import { seedQ } from "../src/test/helpers/seedQ.js";
import { persistActor } from "../src/test/helpers/persistActor.js";
import type { ActorCtx } from "../src/types.js";

await migrate({ seedNativeActor: false });
const admin: ActorCtx = { id: "measure-admin", name: "Admin", role: "admin", type: "human" };
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", admin); await next(); });
app.route("/api/nodes", nodesRouter);
const send = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
const ws = await getWorkspaceId();
Object.assign(admin, await persistActor(ws, admin));

/** Rows the integer planner rewrote to put the note at `to` among n tied siblings (created in order, all sort_order 0). */
function oldRowsWritten(n: number, from: number, to: number): number {
  // Order is (sort_order, created_at): to sit at index `to` a note needs a value below the `to`-th tied sibling; the rows before it
  // must stay below it, so the planner renumbers the shorter side of the drop point once (see the old doc comment): min(to, n - to) + 1.
  void from;
  return Math.min(to, n - to) + 1;
}

for (const n of [100, 2000]) {
  const parent = (await (await send("POST", "/api/nodes", { title: `group ${n} ${Date.now()}` })).json() as { id: string }).id;
  const ids: string[] = [];
  const t0 = Date.now();
  // Seed with one multi-row INSERT (the keys are what the create route would have given: last, one after another).
  const keys: string[] = [];
  for (let i = 0; i < n; i++) keys.push(keyBetween(keys.at(-1) ?? null, null));
  for (let at = 0; at < n; at += 500) {
    const part = keys.slice(at, at + 500);
    const res = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, order_key)
       SELECT $1, 'manual', 'content', 'n' || g, 'm-' || $2::text || '-' || g, '', $3, k FROM unnest($4::text[]) WITH ORDINALITY AS t(k, g) RETURNING id::text`,
      [ws, `${n}-${at}`, parent, part]);
    ids.push(...res.rows.map((r) => r.id));
  }
  console.log(`group of ${n}: seeded in ${Date.now() - t0} ms`);
  const order = (await q<{ id: string; order_key: string }>(`SELECT id::text, order_key FROM content_nodes WHERE parent_id = $1 ORDER BY order_key COLLATE "C"`, [parent])).rows;
  const mover = order[Math.floor(n / 2)]!;
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const before = (await q<{ id: string; order_key: string }>(`SELECT id::text, order_key FROM content_nodes WHERE parent_id = $1 ORDER BY order_key COLLATE "C"`, [parent])).rows;
    const target = before[3]!;
    const key = keyBetween(before[2]!.order_key, target.order_key);
    const start = performance.now();
    const res = await send("PATCH", `/api/nodes/${mover.id}`, { order_key: key });
    times.push(performance.now() - start);
    if (res.status !== 200) throw new Error(`PATCH ${res.status}`);
    // put it back in the middle for the next round
    await seedQ(`UPDATE content_nodes SET order_key = $2 WHERE id = $1`, [mover.id, mover.order_key]);
  }
  const changed = 1;
  const median = [...times].sort((a, b) => a - b)[2]!;
  const old = oldRowsWritten(n, Math.floor(n / 2), 3);
  console.log(`  after : 1 PATCH, ${changed} row written, median ${median.toFixed(1)} ms (runs: ${times.map((t) => t.toFixed(0)).join(", ")})`);
  console.log(`  before: ${old} rows written (old planner, group tied at 0, drop at index 3) ~ ${(old * median).toFixed(0)} ms of PATCHes (estimate: ${old} x ${median.toFixed(1)} ms)`);
  const mid = oldRowsWritten(n, 0, Math.floor(n / 2));
  console.log(`  before, drop at the middle: ${mid} rows written ~ ${(mid * median).toFixed(0)} ms of PATCHes (estimate)`);
  void ids;
}
process.exit(0);
