// realPostgresAlso: this file is the real-Postgres exchange; on PGlite the same three processes each hold an in-memory PGlite.
// Change bundles between three PROCESSES with a database of their own each (the way three devices are; star: A is the centre, B and C join A by snapshot and exchange only with A).
// Each process is a worker (helpers/stampedBundleWorker.ts) driven over stdin/stdout. On a real Postgres this makes three empty databases on the server of DATABASE_URL (names end in _test),
// builds each from db/schema.sql and the migrations, and drops them at the end. What is proved: after all three wrote without exchanging (creates, titles, bodies, moves that close
// cycles, reorders, trash, undelete, deletes for good, the same id made again, concurrent edits of one field, one node with its clock 5 minutes ahead), bundles A↔B and A↔C twice leave
// the three databases with the same digest (rows, stamps with saw and meta, other heads); the same bundle twice changes nothing; a bundle from a node the receiver did not admit is refused.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildDatabase } from "./helpers/databaseBuild.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { ALL_TABLES } from "./helpers/stampedBundleWorld.js";
import { compareDigests, type TableDigest } from "../spine/snapshotSql.js";

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, "../..");
const worker = resolve(here, "helpers/stampedBundleWorker.ts");
const onPglite = process.env.ONDEN_DB_DRIVER === "pglite";
const tag = randomUUID().replaceAll("-", "").slice(0, 10);
const names = ["a", "b", "c"].map((n) => `stampbun_${n}_${tag}_test`);
const urlOf = (database: string) => { const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; return url.toString(); };

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function makeDatabase(name: string): Promise<void> {
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  const c = new pg.Client({ connectionString: urlOf(name) });
  await c.connect();
  try { await buildDatabase(c); } finally { await c.end(); }
}

class Node {
  private waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  private next = 1;
  private buffer = "";
  private proc: ChildProcessWithoutNullStreams;
  constructor(readonly label: string, database: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", NODE_ENV: "test", LOG_LEVEL: "warn", VITEST: "", VITEST_WORKER_ID: "", ONDEN_TEST_DB_KEEP: "" };
    if (onPglite) env.ONDEN_PGLITE_DIR = "memory://"; else env.DATABASE_URL = urlOf(database);
    this.proc = spawn("npx", ["tsx", worker], { cwd: backendDir, env });
    this.proc.stdout.on("data", (d: Buffer) => {
      this.buffer += d.toString();
      for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1);
        if (!line.startsWith("@@")) continue;
        const m = JSON.parse(line.slice(2)) as { id: number; ok: boolean; result?: unknown; error?: string };
        const w = this.waiting.get(m.id)!; this.waiting.delete(m.id);
        if (m.ok) w.ok(m.result); else w.no(new Error(`${this.label}: ${m.error}`));
      }
    });
    this.proc.stderr.on("data", (d: Buffer) => { if (process.env.DEBUG_WORKER) process.stderr.write(`[${this.label}] ${d}`); });
    this.proc.on("exit", (code) => { for (const w of this.waiting.values()) w.no(new Error(`${this.label} exited (${code})`)); });
  }
  call<T = any>(cmd: string, args: unknown = {}): Promise<T> {
    const id = this.next++;
    return new Promise<T>((ok, no) => { this.waiting.set(id, { ok, no }); this.proc.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`); });
  }
  stop() { this.proc.stdin.end(); setTimeout(() => this.proc.kill("SIGKILL"), 3000).unref(); } // the worker leaves when its input ends; the kill is for one that does not
}

type State = { digest: TableDigest[]; stamps: string; heads: string; conflicts: number };

describe.skipIf(!isTestDatabase())("change bundles between three processes", () => {
  const nodes: Node[] = [];
  beforeAll(async () => { if (!onPglite) for (const n of names) await makeDatabase(n); }, 600_000);
  afterAll(async () => {
    for (const n of nodes) n.stop();
    if (!onPglite) await admin(async (c) => { for (const n of names) await c.query(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`); });
  }, 120_000);

  it("A↔B and A↔C, twice: the same digest in all three; a bundle twice changes nothing; a sender nobody admitted is refused", async () => {
    const [a, b, c] = ["A", "B", "C"].map((l, i) => new Node(l, names[i]!));
    nodes.push(a, b, c);
    const ids = await Promise.all([a, b, c].map((n) => n.call<{ node: string }>("init")));
    const world = await a.call("world");
    const cap = await a.call("snapshot");
    await Promise.all([b.call("join", { world, cap, name: "B" }), c.call("join", { world, cap, name: "C" })]);
    await a.call("admit", { node: ids[1]!.node });
    await a.call("admit", { node: ids[2]!.node });

    const give = async (from: Node, to: Node, extra: { aheadMs?: number } = {}) => {
      const bundle = await from.call("bundle", { have: await to.call("have") });
      const r = await to.call("apply", { bundle, ...extra });
      expect(r.refused, `${from.label} → ${to.label}`).toBeUndefined();
      return { bundle, report: r.report as { stored: number; rejected: number } };
    };
    const state = (n: Node) => n.call<State>("state");
    const sameState = async (x: Node, y: Node) => {
      const [sx, sy] = [await state(x), await state(y)];
      const diff = compareDigests(sx.digest, sy.digest);
      if (diff.length) { // say which columns of which rows differ (what to look at first)
        const [rx, ry] = [await x.call<string[]>("rows"), await y.call<string[]>("rows")].map((r) => new Map(r.map((j) => { const o = JSON.parse(j); return [o.id as string, o] as const; })));
        for (const [id, o] of rx!) { const p = ry!.get(id); if (!p) { console.log("only at", x.label, id, o.title); continue; } for (const k of Object.keys(o)) if (JSON.stringify(o[k]) !== JSON.stringify(p[k])) { console.log("DIFF", id.slice(0, 8), k, JSON.stringify(o[k]).slice(0, 60), "|", JSON.stringify(p[k]).slice(0, 60)); if (k === "updated_at") for (const n of nodes) console.log("  ROWINFO", n.label, JSON.stringify(await n.call("rowinfo", { id: id.slice(0, 8) }))); } }
        for (const [id, o] of ry!) if (!rx!.has(id)) console.log("only at", y.label, id, o.title);
      }
      expect(diff, `${x.label} and ${y.label}: digest`).toEqual([]);
      expect(sx.stamps, `${x.label} and ${y.label}: stamps`).toBe(sy.stamps);
      expect(sx.heads, `${x.label} and ${y.label}: other heads`).toBe(sy.heads);
    };

    // batch 2b-2a: every stamped table travels. Tags every node can apply first, then each round writes notes AND attributes, tags, pointers and the keys of a tag's schema
    await a.call("write", { seed: 50, count: 6, weights: { tagMake: 3 } });
    await give(a, b); await give(a, c);
    for (let round = 0; round < 2; round++) {
      await Promise.all([a.call("write", { seed: 100 + round, count: 25 }), b.call("write", { seed: 200 + round, count: 25 }), c.call("write", { seed: 300 + round, count: 25, aheadMs: 5 * 60_000 })]);
      await Promise.all([a.call("write", { seed: 400 + round, count: 25, weights: ALL_TABLES }), b.call("write", { seed: 500 + round, count: 25, weights: ALL_TABLES }), c.call("write", { seed: 600 + round, count: 25, weights: ALL_TABLES })]);
      await give(b, a); await give(c, a);
      await give(a, b); await give(a, c);
    }
    // a node that took a note made again over a delete it had not seen sends what it holds on it again (README 「筆記以同一個 id 重建時」): the re-sends B and C wrote
    // while taking the last round go to A, and from A to the other
    await give(b, a); await give(c, a);
    await give(a, b); await give(a, c);
    await sameState(a, b); await sameState(a, c);

    // the same bundle twice: nothing changes
    const bundle = await b.call("bundle", { have: await a.call("have") });
    const first = await a.call("apply", { bundle }), again = await a.call("apply", { bundle });
    expect(first.report.rejected + again.report.rejected).toBe(0);
    expect(again.report.stored).toBe(0);
    await sameState(a, b);

    // C admits only A: a bundle that B made is refused there, and nothing changes
    const before = await state(c);
    const refused = await c.call("apply", { bundle });
    expect(refused.refused).toBe("bundle_unknown_sender");
    expect(await state(c)).toEqual(before);
  }, 900_000);
});
