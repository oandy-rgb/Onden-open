// Real queries + independent committed writers; barriers control the interleave.
// Only the route's workspace and scheduling are injected, never policy results.
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import * as readPolicy from "../services/readPolicy.js";
import { apiOnError } from "../httpError.js";
import syncRouter from "../routes/sync.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { insertTaskNodeTx } from "../services/tasksStore.js";
import { mutate } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let admin: ActorCtx = { id: "snapshot-admin", name: "Test", role: "admin", type: "human" };
let viewer: ActorCtx = { ...admin, id: "snapshot-viewer", role: "viewer" };
function appFor(actor = viewer) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/sync", syncRouter);
  return app;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function interleave(request: () => Promise<Response>, write: () => Promise<void>) {
  const reached = gate(), resume = gate();
  const original = readPolicy.readableNodeIdSet;
  vi.spyOn(readPolicy, "readableNodeIdSet").mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    reached.release();
    await resume.promise;
    return result;
  });
  const pending = request();
  try {
    // A failed request must fail the test instead of leaving a barrier hanging.
    await Promise.race([reached.promise, pending.then(() => { throw new Error("request never reached read set"); })]);
    await write();
  } finally { resume.release(); }
  return pending;
}

async function emit(type: string, targetType: "node" | "edge" | "workspace" | "tag", id: string, payload?: Record<string, unknown>) {
  await mutate({ actor: admin, workspaceId: ws, authority: { kind: "principal_admin" },
    event: { type, targetType, targetId: id, payload }, apply: async () => {} });
}
async function epoch() {
  return Number((await db.q("SELECT membership_epoch FROM workspaces WHERE id=$1", [ws])).rows[0].membership_epoch);
}
async function cursor() {
  return Number((await db.q("SELECT COALESCE(MAX(id),0) AS id FROM domain_events WHERE workspace_id=$1", [ws])).rows[0].id);
}
// Spaces model: host (and its task) live in hostSpace, where the viewer is a
// member; revoking = removing the viewer from that space, granting = adding
// them back. peer stays in the default space.
let host: string, peer: string, task: string, hostSpace: string, edge: string;
async function node() {
  const id = randomUUID();
  await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
    VALUES($1::uuid,$2,'manual','content','public title',($1::uuid)::text,'public body')`, [id, ws]);
  await emit("NODE_CREATED", "node", id);
  return id;
}
async function change(revoke: boolean) {
  await withEventTransaction(ws, async () => {
    if (revoke) {
      await db.q("DELETE FROM space_members WHERE space_id=$1 AND actor_id=$2::uuid", [hostSpace, viewer.id]);
      await db.bumpMembershipEpoch(ws);
      await emit("SPACE_MEMBER_SET", "workspace", ws, { space_id: hostSpace, actor_id: viewer.id, permission: null, previous_permission: "view" });
    }
    await seedQ("UPDATE content_nodes SET markdown='secret body' WHERE id=$1", [host]);
    await seedQ("UPDATE content_nodes SET title='secret task' WHERE id=$1", [task]);
    await seedQ("UPDATE node_attributes SET value='secret attribute' WHERE node_id=$1 AND key='test'", [host]);
    await seedQ("UPDATE node_edges SET edge_type='secret edge' WHERE id=$1", [edge]);
    await db.q("UPDATE workspaces SET name='secret workspace' WHERE id=$1", [ws]);
    await emit("NODE_UPDATED", "node", host);
    await emit("NODE_UPDATED", "node", task);
    await emit("ATTRIBUTE_SET", "node", host, { key: "test" });
    await emit("EDGE_CREATED", "edge", edge);
    await emit("WORKSPACE_UPDATED", "workspace", ws);
  });
}
async function request(mode: "delta" | "nodes", actor = viewer) {
  return appFor(actor).request(mode === "delta" ? "/api/sync" : "/api/sync/nodes", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(mode === "delta" ? { since: 0, known: [host, task] } : { ids: [host, task] }),
  });
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("sync policy and projections share a snapshot", () => {
  beforeAll(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Sync snapshot',$1) RETURNING id", [randomUUID()])).rows[0].id;
    admin = await persistActor(ws, admin);
    viewer = await persistActor(ws, viewer);
  });
  beforeEach(async () => {
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]);
    await withEventTransaction(ws, async () => {
      host = await node(); peer = await node(); task = randomUUID();
      hostSpace = await makeSpace(ws, `host-${randomUUID()}`, [{ id: admin.id, permission: "edit" }, { id: viewer.id, permission: "view" }]);
      await insertTaskNodeTx({ workspaceId: ws, id: task, hostId: host, title: "public task" });
      await putInSpace(host, hostSpace); // with its task
      // An insert after the first mutate() in this transaction lands in the
      // admin's personal space (onden.actor_space); peer belongs in the default.
      await putInSpace(peer, (await db.q<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=$1 AND is_default", [ws])).rows[0].id);
      await emit("NODE_CREATED", "node", task);
      await seedQ("INSERT INTO node_attributes(workspace_id,node_id,key,value,value_type) VALUES($1,$2,'test','public attribute','text')", [ws,host]);
      await emit("ATTRIBUTE_SET", "node", host, { key: "test" });
      edge = (await seedQ<{ id: string }>("INSERT INTO node_edges(workspace_id,source_node_id,target_node_id,edge_type,status) VALUES($1,$2,$3,'public edge','active') RETURNING id", [ws,host,peer])).rows[0].id;
      await emit("EDGE_CREATED", "edge", edge);
      await db.q("UPDATE workspaces SET name='public workspace' WHERE id=$1", [ws]);
      await emit("WORKSPACE_UPDATED", "workspace", ws);
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  // Append-only history remains in this suite's isolated workspace.
  afterAll(async () => { await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]); });

  for (const mode of ["delta", "nodes"] as const) {
    it.skipIf(needsSecondConnection)(`${mode}: a revoke + edit after authorization cannot ship the new private projections`, async () => {
      const startEpoch = await epoch(), startCursor = await cursor();
      const response = await interleave(() => request(mode), () => change(true));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain("secret");
      const nodes = mode === "delta" ? body.nodes.upsert : body.nodes;
      expect(nodes.find((n: { id: string }) => n.id === host)?.markdown).toBe("public body");
      expect(body.attributes.upsert.find((a: { key: string }) => a.key === "test")?.value).toBe("public attribute");
      expect((mode === "delta" ? body.tasks.upsert : body.tasks)[0]?.title).toBe("public task");
      expect((mode === "delta" ? body.edges.upsert : body.edges)[0]?.edge_type).toBe("public edge");
      if (mode === "delta") {
        expect(Number(body.last_event_id)).toBe(startCursor);
        expect(body.membership_epoch).toBe(startEpoch);
      }
      // A fresh request sees the committed revoke, including task + edge ends.
      const next = await (await request(mode)).json();
      expect((mode === "delta" ? next.nodes.upsert : next.nodes).some((n: { id: string }) => n.id === host)).toBe(false);
      expect(next.attributes.upsert.some((a: { node_id: string }) => a.node_id === host)).toBe(false);
      expect(mode === "delta" ? next.tasks.upsert : next.tasks).toEqual([]);
      expect(mode === "delta" ? next.edges.upsert : next.edges).toEqual([]);
      if (mode === "delta") {
        expect(next.nodes.delete).toContain(host);
        expect(next.tasks.delete).toContain(task);
        expect(next.membership_epoch).toBeGreaterThan(startEpoch);
      }
      // Same current policy, authorized reader: no global suppression of data.
      const allowed = await (await request(mode, admin)).json();
      expect((mode === "delta" ? allowed.nodes.upsert : allowed.nodes).find((n: { id: string }) => n.id === host)?.markdown).toBe("secret body");
    });
  }

  it.skipIf(needsSecondConnection)("membership returns ids and epoch from the same snapshot; the next stale page explicitly retries", async () => {
    const startEpoch = await epoch();
    const getPage = async () => appFor().request(`/api/sync/membership?expected_epoch=${startEpoch}`);
    const response = await interleave(getPage, () => change(true));
    const page = await response.json();
    expect(page.retry_required).not.toBe(true);
    expect(page.epoch).toBe(startEpoch);
    expect(page.ids).toContain(host);
    const next = await (await getPage()).json();
    expect(next.retry_required).toBe(true);
    expect(next.epoch).toBeGreaterThan(startEpoch);
    const fresh = await (await appFor().request("/api/sync/membership")).json();
    expect(fresh.ids).not.toContain(host);
    expect(fresh.ids).not.toContain(task);
  });

  it.skipIf(needsSecondConnection)("an ordinary edit stays behind this page's cursor and arrives with every channel on the next GET", async () => {
    const startEpoch = await epoch(), startCursor = await cursor();
    const response = await interleave(() => request("delta"), () => change(false));
    const first = await response.json();
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(Number(first.last_event_id)).toBe(startCursor);
    expect(first.membership_epoch).toBe(startEpoch);
    const next = await (await appFor().request(`/api/sync?since=${first.last_event_id}`)).json();
    expect(next.nodes.upsert.find((n: { id: string }) => n.id === host)?.markdown).toBe("secret body");
    expect(next.attributes.upsert.find((a: { key: string }) => a.key === "test")?.value).toBe("secret attribute");
    expect(next.tasks.upsert[0]?.title).toBe("secret task");
    expect(next.edges.upsert[0]?.edge_type).toBe("secret edge");
    expect(next.workspace.name).toBe("secret workspace");
    expect(Number(next.last_event_id)).toBeGreaterThan(startCursor);
    expect(next.membership_epoch).toBe(startEpoch);
  });

  it.skipIf(needsSecondConnection)("a grant during the read appears with its epoch on the next response", async () => {
    await change(true);
    const startEpoch = await epoch();
    const response = await interleave(() => request("delta"), () => withEventTransaction(ws, async () => {
      await db.q("INSERT INTO space_members(space_id,actor_id,permission) VALUES($1,$2::uuid,'view')", [hostSpace, viewer.id]);
      await db.bumpMembershipEpoch(ws);
      await emit("SPACE_MEMBER_SET", "workspace", ws, { space_id: hostSpace, actor_id: viewer.id, permission: "view", previous_permission: null });
    }));
    const first = await response.json();
    expect(first.nodes.upsert.some((n: { id: string }) => n.id === host)).toBe(false);
    expect(first.nodes.delete).toContain(host);
    expect(first.membership_epoch).toBe(startEpoch);
    const next = await (await request("delta")).json();
    expect(next.nodes.upsert.find((n: { id: string }) => n.id === host)?.markdown).toBe("secret body");
    expect(next.nodes.delete).not.toContain(host);
    expect(next.membership_epoch).toBeGreaterThan(startEpoch);
  });

  it.skipIf(needsSecondConnection)("creation during a membership page stays in the next event window without a false empty set", async () => {
    const startCursor = await cursor(), startEpoch = await epoch();
    let created: string;
    const response = await interleave(async () => appFor().request("/api/sync/membership"),
      async () => { await withEventTransaction(ws, async () => { created = await node(); }); });
    const page = await response.json();
    expect(page.retry_required).not.toBe(true);
    expect(page.ids).toContain(host);
    expect(page.ids).not.toContain(created!);
    expect(page.epoch).toBe(startEpoch);
    // Back off 256 ids: /api/sync parses `since` as a JS number, lossy once the
    // shared DB's event ids pass 2^53 (eventRestoreAtomicity moves them there).
    const next = await (await appFor().request(`/api/sync?since=${Math.max(0, startCursor - 256)}`)).json();
    expect(next.nodes.upsert.some((n: { id: string }) => n.id === created)).toBe(true);
  });
  // ("role and scope cannot combine grants that never coexisted" was removed:
  // human matter scope and token tag scope no longer exist; a token's space
  // scope and the membership it intersects are read in one query.)
});
