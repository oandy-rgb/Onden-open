// Lock order of the writes that stamp the S3 tables (db/migrations/199_stamps_s3.sql: JSON keys of content_nodes, spaces, space_members, workspaces). A stamp trigger takes the workspace's
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
import spaceRouter from "../routes/spaces.js";
import workspaceRouter from "../routes/workspace.js";
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

describe.skipIf(!isTestDb)("lock order of the writes that stamp JSON keys, spaces, space members and workspace settings", () => {
  let ws = "";
  let owner!: ActorCtx;
  let member!: ActorCtx;
  let space = "";
  const server = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  server.onError(apiOnError);
  server.use("*", async (c, next) => { c.set("actor", owner); await withRequestDevice(randomUUID(), next); });
  server.route("/api/nodes", nodeRouter);
  server.route("/api/tags", tagRouter);
  server.route("/api/boards", boardRouter);
  server.route("/api/canvases", canvasRouter);
  server.route("/api/spaces", spaceRouter);
  server.route("/api/workspace", workspaceRouter);

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

  beforeAll(async () => {
    await registerShippedModules();
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: "Lock Owner", role: "admin", type: "human" });
    member = await persistActor(ws, { id: "", name: "Lock Member", role: "editor", type: "human" });
    space = await makeSpace(ws, `lock order ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
  });
  afterAll(async () => { await pool.end(); });

  const holderWantsRowThenWriter = async (holder: () => Promise<unknown>, writer: () => Promise<unknown>) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const heldLock = new Promise<void>((r) => { held = r; });
    const holding = withEventTransaction(ws, async () => { held(); await gate; await holder(); });
    await heldLock;
    const writing = writer();
    await sleep(400);
    release();
    const outcome = await Promise.race([Promise.all([holding, writing]).then(() => "finished" as const), sleep(15_000).then(() => "stuck" as const)]);
    expect(outcome).toBe("finished");
  };

  // The product's writes that reach one of the S3 triggers.
  const stampingWrites = async () => {
    const t = (await ok("POST", "/api/tags", { name: `locktag-${randomUUID().slice(0, 8)}` })).id as string;
    const sp = (await ok("POST", "/api/spaces", { name: `lock space ${randomUUID().slice(0, 6)}` })).id as string;
    const board = (await ok("POST", "/api/canvases", { space_id: space })).id as string;
    let round = 0;
    const ops: Array<[string, () => Promise<{ status: number }>]> = [
      ["tag schema fields", () => call("PATCH", `/api/tags/${t}/schema`, { fields: [{ name: `f${round}`, type: "text" }] })],
      ["tag schema behaviour", () => call("PATCH", `/api/tags/${t}/schema`, { behaviour: { sub_pages: round % 2 === 0 } })],
      ["space rename", () => call("PATCH", `/api/spaces/${sp}`, { name: `renamed ${round}` })],
      ["space switch", () => call("PATCH", `/api/spaces/${sp}`, { capabilities: { publish: round % 2 === 0 } })],
      ["member add", () => call("PUT", `/api/spaces/${sp}/members/${member.id}`, { permission: round % 2 ? "view" : "edit" })],
      ["member remove", () => call("DELETE", `/api/spaces/${sp}/members/${member.id}`)],
      ["workspace time", () => call("PATCH", "/api/workspace/time", { day_start_hour: round % 5 })],
      ["module off", () => call("PATCH", "/api/workspace/modules", { module: "external_calendars", imported: false })],
      ["module on", () => call("PATCH", "/api/workspace/modules", { module: "external_calendars", imported: true })],
      ["board section", () => call("PATCH", `/api/boards/${board}`, { sections: { upsert: [{ id: "s1", title: `t${round}`, x: round, y: 0, width: 50, height: 50 }] } })],
      ["board section off", () => call("PATCH", `/api/boards/${board}`, { sections: { remove: ["s1"] } })],
    ];
    return { ops, next: () => { round++; } };
  };

  // One connection, any database: no product write to a stamped table runs in a transaction that has not yet taken the workspace lock.
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
    it.skipIf(needsSecondConnection)("a member change does not hold its member row while it waits for the workspace lock", async () => {
      const sp = (await ok("POST", "/api/spaces", { name: `lock member ${randomUUID().slice(0, 6)}` })).id as string;
      await ok("PUT", `/api/spaces/${sp}/members/${member.id}`, { permission: "view" });
      await holderWantsRowThenWriter(
        () => q(`UPDATE space_members SET permission = 'view' WHERE space_id = $1 AND actor_id = $2`, [sp, member.id]),
        () => ok("PUT", `/api/spaces/${sp}/members/${member.id}`, { permission: "edit" }),
      );
      expect((await q<{ permission: string }>(`SELECT permission FROM space_members WHERE space_id = $1 AND actor_id = $2`, [sp, member.id])).rows[0]?.permission).toBe("edit");
    }, 30_000);

    it.skipIf(needsSecondConnection)("any two of the stamping writes finish without a deadlock", async () => {
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
            for (const r of results) expect(r.status, `${nameA} + ${nameB}`).toBeLessThan(500);
          }
        }
      }
    }, 240_000);
  });
});
