// PATCH /api/nodes/:id reparent must refuse to create a parent_id CYCLE — moving
// a node under its own descendant. A cycle wedges every ancestor walk (the
// read-policy cascade, subtree delete, breadcrumb, getSubtreeIds) into an
// infinite loop (M4).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);

const J = { "content-type": "application/json" };
const patchParent = (id: string, parent_id: string | null): Promise<Response> =>
  Promise.resolve(app.request(`/api/nodes/${id}`, { method: "PATCH", headers: J, body: JSON.stringify({ parent_id }) }));
const parentOf = async (id: string): Promise<string | null> =>
  (await q<{ parent_id: string | null }>(`SELECT parent_id FROM content_nodes WHERE id=$1`, [id])).rows[0]!.parent_id;

describe.skipIf(!isTestDb)("reparent cycle guard (M4)", () => {
  let WS = "";
  const stamp = Date.now();
  let a = "", b = "", c = "";

  const mkNode = async (label: string): Promise<string> =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden, sort_order)
       VALUES ($1,'manual','content',$2,$3,'body',false,0) RETURNING id`,
      [WS, `rc ${label} ${stamp}`, `rc-${label}-${stamp}`],
    )).rows[0]!.id;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    currentActor = await persistActor(WS, { id: "rc-admin", name: "Admin", role: "admin", type: "human" });
    a = await mkNode("a");
    b = await mkNode("b");
    c = await mkNode("c");
    // Build a chain a → b → c.
    expect((await patchParent(b, a)).status).toBe(200);
    expect((await patchParent(c, b)).status).toBe(200);
  });

  it("moving a node under a direct child is rejected (a → b, then a under b)", async () => {
    const res = await patchParent(a, b);
    expect(res.status).toBe(400);
    expect(await parentOf(a), "a's parent unchanged — the cycle was never written").toBeNull();
  });

  it("moving a node under a deeper descendant is rejected (a under c, where a → b → c)", async () => {
    const res = await patchParent(a, c);
    expect(res.status).toBe(400);
    expect(await parentOf(a)).toBeNull();
  });

  it("a legitimate reparent (no cycle) still succeeds (c moves from b to a)", async () => {
    const res = await patchParent(c, a);
    expect(res.status).toBe(200);
    expect(await parentOf(c)).toBe(a);
    // And the chain a → b is intact, so a is still safely re-rootable to null.
    expect((await patchParent(a, null)).status).toBe(200);
  });
});
