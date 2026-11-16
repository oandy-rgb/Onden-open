// Two devices change the same sibling group while offline, then both send and both pull: the group ends in one order on both
// copies, whichever device reaches the server first, and the order is the one the tie rule says (key, then the stamp of the
// write that set it, then id). Each "device" plans its own writes from its own copy of the group, with the app's planner
// (lib/childOrder planSiblingOrder's rule: keyBetween the neighbours' keys), and never sees the other's rows until it pulls.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { sortChildren } from "@onden/markdown";
import { compareOrdered, keyBetween } from "@onden/markdown/contract";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const admin: ActorCtx = { id: "okd-admin", name: "Admin", role: "admin", type: "human" };
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", admin); await next(); });
app.route("/api/nodes", nodesRouter);
const send = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

type Row = { id: string; order_key: string; order_stamp: string };

describe.skipIf(!isTestDb)("two devices reorder one group offline (DB)", () => {
  let ws = "";
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    ws = await getWorkspaceId();
    Object.assign(admin, await persistActor(ws, admin));
  });

  const make = async (title: string, parent: string | null) => {
    const res = await send("POST", "/api/nodes", { title, parent_id: parent });
    return await res.json() as Row & { id: string };
  };
  /** What a device holds: the group's rows in the order the server last sent them (a pull). */
  const pull = async (parent: string): Promise<Row[]> => (await q<Row>(
    `SELECT id::text, order_key, order_stamp FROM content_nodes WHERE workspace_id = $1 AND parent_id = $2 AND deleted_at IS NULL`, [ws, parent])).rows;
  const serverOrder = async (parent: string) => (await q<{ id: string }>(
    `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND parent_id = $2 AND deleted_at IS NULL ORDER BY order_key COLLATE "C", order_stamp COLLATE "C", id`, [ws, parent])).rows.map((r) => r.id);

  /** One scenario: five notes, then two devices, each offline, each inserting one note at the same place and moving one note. */
  async function scenario(first: "A" | "B") {
    const parent = (await make(`group ${randomUUID()}`, null)).id;
    const base: Row[] = [];
    for (let i = 0; i < 5; i++) base.push(await make(`n${i}`, parent));
    const snapshot = sortChildren(await pull(parent));
    // Both devices start from the same copy and plan from it alone.
    const plan = (who: "A" | "B") => {
      const ids = snapshot.map((r) => r.id);
      const newId = randomUUID();
      // The same place for both inserts: between n1 and n2 (so the two new notes get the same key).
      const insertKey = keyBetween(snapshot[1]!.order_key, snapshot[2]!.order_key);
      // A moves n4 to the front; B moves n0 to the back.
      const moveKey = who === "A" ? keyBetween(null, snapshot[0]!.order_key) : keyBetween(snapshot[4]!.order_key, null);
      return { newId, insertKey, moveId: who === "A" ? ids[4]! : ids[0]!, moveKey, who };
    };
    const plans = { A: plan("A"), B: plan("B") };
    expect(plans.A.insertKey).toBe(plans.B.insertKey);
    for (const who of [first, first === "A" ? "B" : "A"] as const) {
      const p = plans[who];
      const created = await send("POST", "/api/nodes", { id: p.newId, title: `new by ${who}`, parent_id: parent, order_key: p.insertKey });
      expect(created.status).toBe(201);
      expect((await send("PATCH", `/api/nodes/${p.moveId}`, { order_key: p.moveKey })).status).toBe(200);
    }
    // Both devices pull.
    const a = sortChildren(await pull(parent)).map((r) => r.id);
    const b = sortChildren([...(await pull(parent))].reverse()).map((r) => r.id);
    expect(a).toEqual(b);
    expect(a).toEqual(await serverOrder(parent));
    return { ids: a, plans, base: base.map((r) => r.id), parent };
  }

  it.each(["A", "B"] as const)("converges to one order when %s reaches the server first", async (first) => {
    const { ids, plans, base } = await scenario(first);
    expect(ids).toHaveLength(7);
    // The moves landed where their devices put them, the two inserts sit between n1 and n2 (in either order), nothing else moved.
    expect(ids[0]).toBe(plans.A.moveId);
    expect(ids.at(-1)).toBe(plans.B.moveId);
    expect(ids.slice(1, -1).filter((id) => base.includes(id))).toEqual([base[1], base[2], base[3]]);
    const between = ids.slice(ids.indexOf(base[1]!) + 1, ids.indexOf(base[2]!));
    expect(new Set(between)).toEqual(new Set([plans.A.newId, plans.B.newId]));
  });

  it("the two inserts are ordered by the stamp of the write that set the key: the one that arrived first comes first", async () => {
    for (const first of ["A", "B"] as const) {
      const { ids, plans } = await scenario(first);
      const second = first === "A" ? "B" : "A";
      expect(ids.indexOf(plans[first].newId)).toBeLessThan(ids.indexOf(plans[second].newId));
    }
  });

  it("two nodes that exchange their rows in either order end with the same list (the comparison needs nothing else)", () => {
    const r = (id: string, order_key: string, order_stamp: string): Row => ({ id, order_key, order_stamp });
    const rows = [r("c", "a1", "2"), r("a", "a1", "2"), r("b", "a1", "1"), r("z", "a0", "9"), r("n", "a1", "")];
    const one = [...rows].sort(compareOrdered).map((x) => x.id);
    const other = [...rows].reverse().sort(compareOrdered).map((x) => x.id);
    expect(one).toEqual(other);
    expect(one).toEqual(["z", "n", "b", "a", "c"]);
  });
});
