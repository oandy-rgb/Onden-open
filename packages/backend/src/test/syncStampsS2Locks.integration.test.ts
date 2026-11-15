// Lock order of the writes that stamp the S2 tables (db/migrations/194_stamps_s2.sql). A stamp trigger takes the workspace's
// event-append lock (the one mutate() takes first), so a write that already holds a row and only then waits for that lock can
// wait on a mutate() that holds the lock and wants the same row: a deadlock. These tests run the product's own write paths on
// two connections and need a database that can: they are skipped on PGlite (helpers/pgliteSkips.ts needsSecondConnection) and
// are listed under "run on real Postgres" in the PR.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, observeCoreWritesWithoutEventLock, pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import tagRouter from "../routes/tags.js";
import edgeRouter from "../routes/edges.js";
import pointerRouter from "../routes/pointers.js";
import boardRouter from "../routes/boards.js";
import canvasRouter from "../routes/canvases.js";
import { withRequestDevice } from "../requestContext.js";
import type { ActorCtx } from "../types.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(!isTestDb)("lock order of the writes that stamp attributes, tags, edges, pointers and board cards", () => {
  let ws = "";
  let owner!: ActorCtx;
  let space = "";
  const server = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  server.onError(apiOnError);
  server.use("*", async (c, next) => { c.set("actor", owner); await withRequestDevice(randomUUID(), next); });
  server.route("/api/nodes", nodeRouter);
  server.route("/api/tags", tagRouter);
  server.route("/api/edges", edgeRouter);
  server.route("/api/pointers", pointerRouter);
  server.route("/api/boards", boardRouter);
  server.route("/api/canvases", canvasRouter);

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await server.request(path, {
      method, headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { status: res.status, json };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.json)}`).toBeLessThan(300);
    return r.json;
  };
  const note = async (markdown = "x") => (await ok("POST", "/api/nodes", { id: randomUUID(), title: `lock ${randomUUID().slice(0, 8)}`, markdown, space_id: space })).id as string;
  const tag = async () => (await ok("POST", "/api/tags", { name: `locktag-${randomUUID().slice(0, 8)}` })).id as string;

  beforeAll(async () => {
    await registerShippedModules();
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: "Lock Owner", role: "editor", type: "human" });
    space = await makeSpace(ws, `lock order ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
  });
  afterAll(async () => { await pool.end(); });

  // A mutate() (or any write that takes the lock first) holds the lock and then wants a row; the write under test must not
  // be holding that row while it waits for the lock. The holder is released only after the writer has had time to start.
  const holderWantsRowThenWriter = async (holder: () => Promise<unknown>, writer: () => Promise<unknown>) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const heldLock = new Promise<void>((r) => { held = r; });
    const holding = withEventTransaction(ws, async () => { held(); await gate; await holder(); });
    await heldLock;
    const writing = writer();
    await sleep(400); // the writer is by now at its first wait: for the lock, or (the fault) for the lock while holding the row
    release();
    const outcome = await Promise.race([Promise.all([holding, writing]).then(() => "finished" as const), sleep(15_000).then(() => "stuck" as const)]);
    expect(outcome).toBe("finished"); // a deadlock is answered by the database with an error, which rejects one of the two
  };

  // The product's writes that reach a stamp trigger, as requests on one note `n`, one other note `m`, one tag and one board.
  const stampingWrites = async () => {
    const [n, m] = [await note(), await note()];
    const t = await tag();
    const board = (await ok("POST", "/api/canvases", { space_id: space })).id as string;
    let round = 0;
    const ops: Array<[string, () => Promise<{ status: number }>]> = [
      ["tag on", () => call("PUT", `/api/nodes/${n}/tags/${t}`)],
      ["tag off", () => call("DELETE", `/api/nodes/${n}/tags/${t}`)],
      ["attribute", () => call("PUT", `/api/nodes/${n}/attributes/mood`, { value: `v${round}` })],
      ["attribute off", () => call("DELETE", `/api/nodes/${n}/attributes/mood`)],
      ["edge", () => call("POST", "/api/edges", { source_node_id: n, target_node_id: m, edge_type: "relates_to" })],
      ["pointer", () => call("POST", "/api/pointers", { target_id: n, parent_id: m })],
      ["card", () => call("PATCH", `/api/boards/${board}`, { cards: { upsert: [{ nodeId: n, x: round, y: round }] } })],
      ["card off", () => call("PATCH", `/api/boards/${board}`, { cards: { remove: [n] } })],
      ["graph position", () => call("PUT", `/api/nodes/${n}/position`, { surface: "graph", x: round, y: round })],
      ["paragraph tags", () => call("PATCH", `/api/nodes/${n}`, { markdown: round % 2 ? "- item {locktag-x}" : "- item" })],
      ["note text", () => call("PATCH", `/api/nodes/${m}`, { markdown: `text ${round}` })],
    ];
    return { ops, next: () => { round++; } };
  };

  // On any database, one connection: no product write to a stamped table runs in a transaction that has not yet taken the
  // workspace lock. (A fixture's direct SQL is not product code and is not what this looks at.)
  it("every stamping write takes the workspace lock before it writes", async () => {
    const { ops, next } = await stampingWrites();
    const seen: string[] = [];
    observeCoreWritesWithoutEventLock((table) => seen.push(table));
    try {
      for (let pass = 0; pass < 2; pass++) for (const [name, run] of ops) { next(); const r = await run(); expect(r.status, name).toBeLessThan(500); }
    } finally { observeCoreWritesWithoutEventLock(null); }
    expect(seen).toEqual([]);
  });

  describe("two connections", () => {
    it.skipIf(needsSecondConnection)("a graph position write does not hold its position row while it waits for the workspace lock", async () => {
      const n = await note();
      await ok("PUT", `/api/nodes/${n}/position`, { surface: "graph", x: 1, y: 1 });
      await holderWantsRowThenWriter(
        () => q(`DELETE FROM node_positions WHERE node_id = $1 AND surface = 'graph'`, [n]),
        () => ok("PUT", `/api/nodes/${n}/position`, { surface: "graph", x: 2, y: 2 }),
      );
      expect((await q<{ x: number }>(`SELECT x FROM node_positions WHERE node_id = $1 AND surface = 'graph'`, [n])).rows[0]?.x).toBe(2);
    }, 30_000);

    // Every write that reaches a stamp trigger, two at a time on the same note, tag and board, with a random pause in
    // between. A write path that waited for the lock while holding a row would deadlock with one of the others sooner or later.
    it.skipIf(needsSecondConnection)("any two of the stamping writes on the same note, tag and board finish without a deadlock", async () => {
      const { ops, next } = await stampingWrites();
      const jitter = () => sleep(Math.floor(Math.random() * 12));
      for (const [i, [nameA, a]] of ops.entries()) {
        for (const [nameB, b] of ops.slice(i)) {
          for (let k = 0; k < 2; k++) {
            next();
            const results = await Promise.race([
              Promise.all([(async () => { await jitter(); return a(); })(), (async () => { await jitter(); return b(); })()]),
              sleep(20_000).then(() => { throw new Error(`${nameA} + ${nameB}: did not finish (a lock wait that never ends)`); }),
            ]);
            for (const r of results) expect(r.status, `${nameA} + ${nameB}`).toBeLessThan(500); // a deadlock is a 500
          }
        }
      }
    }, 240_000);
  });
});
