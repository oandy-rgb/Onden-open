// Real actor rows, credentials, space membership and content. Only authenticated
// identity injection and the before/after-snapshot scheduling are controlled by
// the test. (Spaces model: the grant that changes is the reader's membership of
// the private note's space, or the note moving to a space they are not in; the
// workspace role and the old matter/tag scopes no longer decide reads.)
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import syncRouter from "../routes/sync.js";
import actorsRouter from "../routes/actors.js";
import { createToken, revokeToken, resolveBearerActor } from "../services/agentTokens.js";
import { adminOnlySpace, joinDefaultSpace, makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { moveToSpace, setMember } from "../services/spaces.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { mutate } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";
import { deleteWorkspaceActors, setWorkspaceOwner } from "./helpers/setOwner.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";

let ws: string, otherWs: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let sessionExternalId: string | null = null;
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop")),
    api: { getSession: vi.fn(async () => sessionExternalId
      ? { user: { id: sessionExternalId, name: "Reader", email: "reader@snapshot.test" } } : null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));
const { app: assembledApp } = await import("../app.js");
const modes = ["GET delta", "POST delta", "membership", "nodes"] as const;
type Mode = typeof modes[number];
let owner: ActorCtx, captured: ActorCtx, privateId: string, publicId: string;
let privateSpace: string, defaultSpace: string;
function appFor(actor: ActorCtx | null) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/sync", syncRouter);
  app.route("/api/actors", actorsRouter);
  return app;
}
async function request(mode: Mode, actor: ActorCtx | null = captured) {
  const app = appFor(actor);
  if (mode === "GET delta") return app.request("/api/sync?since=0");
  if (mode === "membership") return app.request("/api/sync/membership");
  return app.request(mode === "nodes" ? "/api/sync/nodes" : "/api/sync", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(mode === "nodes" ? { ids: [privateId, publicId] } : { since: 0, known: [privateId, publicId] }),
  });
}
async function ids(response: Response, mode: Mode): Promise<string[]> {
  expect(response.status).toBe(200);
  const body = await response.json();
  return mode === "membership" ? body.ids : (mode === "nodes" ? body.nodes : body.nodes.upsert).map((n: { id: string }) => n.id);
}
async function seedActor(workspaceId = ws): Promise<ActorCtx> {
  const result = await db.q<ActorCtx>(`INSERT INTO actors(workspace_id,name,type,external_id)
    VALUES($1,'Snapshot reader','human',$2) RETURNING id,name,type`, [workspaceId,randomUUID()]);
  await joinDefaultSpace(workspaceId, result.rows[0].id, "admin");
  return result.rows[0];
}
async function epoch() {
  return Number((await db.q("SELECT membership_epoch FROM workspaces WHERE id=$1", [ws])).rows[0].membership_epoch);
}
async function editPrivate() {
  await mutate({ actor: owner, workspaceId: ws, authority: { kind: "principal_admin" },
    event: { type: "NODE_UPDATED", targetType: "node", targetId: privateId },
    apply: async () => { await seedQ("UPDATE content_nodes SET markdown='after authority changed' WHERE id=$1", [privateId]); },
  });
}
type Change = "removed" | "moved";
/** Revoke the captured reader's access to the private note (and edit it in the
 *  same transaction): remove them from its space, or move the note into a
 *  space only the owner is in. */
async function changeAccess(change: Change, actor = captured) {
  const ownerOnly = change === "moved" ? await adminOnlySpace(ws, `owner-only-${randomUUID()}`, [owner.id]) : "";
  await withEventTransaction(ws, async () => {
    if (change === "removed") await setMember(owner, ws, privateSpace, actor.id, null);
    else await moveToSpace(owner, ws, privateId, ownerOnly, null);
    await editPrivate();
  });
}
async function restoreAccess(actor = captured) {
  await setMember(owner, ws, privateSpace, actor.id, "edit");
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("actor authority inside read snapshots", () => {
  beforeAll(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Actor snapshot',$1) RETURNING id", [randomUUID()])).rows[0].id;
    otherWs = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Other snapshot',$1) RETURNING id", [randomUUID()])).rows[0].id;
  });
  beforeEach(async () => {
    sessionExternalId = null;
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]);
    owner = await seedActor(); captured = await seedActor();
    await setWorkspaceOwner(ws, owner.id);
    defaultSpace = (await db.q<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=$1 AND is_default", [ws])).rows[0].id;
    privateSpace = await makeSpace(ws, `private-${randomUUID()}`, [{ id: owner.id, permission: "edit" }, { id: captured.id, permission: "edit" }]);
    for (const isPrivate of [true, false]) {
      const id = randomUUID();
      await mutate({ actor: owner, workspaceId: ws, authority: { kind: "principal_admin" },
        event: { type: "NODE_CREATED", targetType: "node", targetId: id },
        apply: async () => {
          await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
            VALUES($1::uuid,$2,'manual','content','Snapshot note',($1::uuid)::text,'before authority changed')`, [id,ws]);
        },
      });
      await putInSpace(id, isPrivate ? privateSpace : defaultSpace);
      if (isPrivate) privateId = id; else publicId = id;
    }
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=ANY($1::uuid[])", [[ws,otherWs]]);
    await deleteWorkspaceActors([ws,otherWs]);
  });

  for (const mode of modes) for (const change of ["removed", "moved"] as const) {
    it(`${mode}: ${change} changed before snapshot cannot retain the old actor grant`, async () => {
      expect(await ids(await request(mode), mode)).toContain(privateId);
      const capturedBefore = { ...captured };
      const reached = gate(), resume = gate();
      const original = db.withReadSnapshot;
      vi.spyOn(db, "withReadSnapshot").mockImplementationOnce(async fn => {
        reached.release(); await resume.promise; return original(fn);
      });
      const pending = request(mode);
      try {
        await Promise.race([reached.promise, pending.then(() => { throw new Error("snapshot not reached"); })]);
        await changeAccess(change);
      } finally { resume.release(); }
      const response = await pending;
      const responseBody = await response.clone().json();
      const visible = await ids(response, mode);
      expect(visible).not.toContain(privateId);
      expect(visible).toContain(publicId);
      if (mode === "POST delta") expect(responseBody.nodes.delete).toContain(privateId);
      expect(await ids(await request(mode), mode)).not.toContain(privateId);
      // Authentication's captured object is not mutated.
      expect(captured).toEqual(capturedBefore);
    });
  }

  it("a re-granted membership is visible without trusting the captured earlier (no-access) state", async () => {
    await changeAccess("removed");
    const oldCapture: ActorCtx = { ...captured };
    expect(await ids(await request("nodes", oldCapture), "nodes")).not.toContain(privateId);
    await restoreAccess();
    expect(await ids(await request("nodes", oldCapture), "nodes")).toContain(privateId);
  });

  it.each(["deleted", "other workspace", "anonymous"] as const)("%s actor returns 401, never public content", async kind => {
    const actor = kind === "anonymous" ? null : kind === "other workspace" ? await seedActor(otherWs) : captured;
    if (kind === "deleted") await db.q("DELETE FROM actors WHERE id=$1", [captured.id]);
    for (const mode of modes) {
      const response = await request(mode, actor);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });

  it.each(["revoked", "expired", "deleted", "different owner"] as const)("a previously resolved token that is %s is rejected", async kind => {
    const token = await createToken(captured.id);
    const resolved = await resolveBearerActor(token.plaintext);
    expect(resolved).not.toBeNull();
    if (kind === "revoked") await revokeToken(captured.id, token.id);
    if (kind === "expired") await db.q("UPDATE agent_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [token.id]);
    if (kind === "deleted") await db.q("DELETE FROM agent_tokens WHERE id=$1", [token.id]);
    if (kind === "different owner") await db.q("UPDATE agent_tokens SET actor_id=$2 WHERE id=$1", [token.id, owner.id]);
    const response = await request("nodes", resolved);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("token reach is the agent's membership, read again on every request", async () => {
    // A token reaches what its agent is a member of (spaces with external_ai on);
    // there is no per-token space list. Use a separate agent: a token held by the
    // human `captured` would reach that human's memberships.
    const agent = (await db.q<ActorCtx>(`INSERT INTO actors(workspace_id,name,type) VALUES($1,'Snapshot agent','agent') RETURNING id,name,type`, [ws])).rows[0];
    const token = await createToken(agent.id);
    const resolved = await resolveBearerActor(token.plaintext);
    expect(await ids(await request("nodes", resolved), "nodes")).toEqual([]);
    await setMember(owner, ws, defaultSpace, agent.id, "view");
    expect(await ids(await request("nodes", resolved), "nodes")).toEqual([publicId]);
    await setMember(owner, ws, privateSpace, agent.id, "view");
    expect((await ids(await request("nodes", resolved), "nodes")).sort()).toEqual([privateId, publicId].sort());
    await setMember(owner, ws, defaultSpace, agent.id, null);
    expect(await ids(await request("nodes", resolved), "nodes")).toEqual([privateId]);
    await changeAccess("removed", agent);
    expect(await ids(await request("nodes", resolved), "nodes")).toEqual([]);
    await restoreAccess(agent);
    expect(await ids(await request("nodes", resolved), "nodes")).toEqual([privateId]);
  });

  it.skipIf(needsSecondConnection)("a downgrade after the actor query keeps old content and old epoch, then denies on the next request", async () => {
    const startEpoch = await epoch();
    const reached = gate(), resume = gate();
    const original = db.q;
    let paused = false;
    vi.spyOn(db, "q").mockImplementation(async (sql, params) => {
      const result = await original(sql, params);
      if (!paused && sql.includes("FROM actors a") && sql.includes("t.access")) {
        paused = true; reached.release(); await resume.promise;
      }
      return result;
    });
    const pending = request("POST delta");
    try {
      await Promise.race([reached.promise, pending.then(() => { throw new Error("actor query not reached"); })]);
      await changeAccess("removed");
    } finally { resume.release(); }
    const first = await (await pending).json();
    expect(first.nodes.upsert.find((n: { id: string }) => n.id === privateId)?.markdown).toBe("before authority changed");
    expect(first.membership_epoch).toBe(startEpoch);
    const next = await (await request("POST delta")).json();
    expect(next.nodes.upsert.some((n: { id: string }) => n.id === privateId)).toBe(false);
    expect(next.nodes.delete).toContain(privateId);
    expect(next.membership_epoch).toBeGreaterThan(startEpoch);
  });

  it.each(["removed", "moved"] as const)("assembled app rechecks access (%s) after session actor resolution", async kind => {
    sessionExternalId = (await db.q<{ external_id: string }>("SELECT external_id FROM actors WHERE id=$1", [captured.id])).rows[0].external_id;
    const reached = gate(), resume = gate();
    const original = db.withReadSnapshot;
    vi.spyOn(db, "withReadSnapshot").mockImplementationOnce(async fn => {
      reached.release(); await resume.promise; return original(fn);
    });
    const pending = Promise.resolve(assembledApp.request("/api/sync?since=0"));
    try {
      await Promise.race([reached.promise, pending.then(() => { throw new Error("assembled snapshot not reached"); })]);
      await changeAccess(kind);
    } finally { resume.release(); }
    const visible = await ids(await pending, "GET delta");
    expect(visible).not.toContain(privateId);
    expect(visible).toContain(publicId);
  });

  it("assembled app keeps bearer credentials confined to MCP", async () => {
    const token = await createToken(captured.id);
    const response = await assembledApp.request("/api/sync?since=0", { headers: { authorization: `Bearer ${token.plaintext}` } });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("token_scope");
  });

  it("deleted actors cannot bypass revalidation via an empty or oversized request", async () => {
    await db.q("DELETE FROM actors WHERE id=$1", [captured.id]);
    const app = appFor(captured);
    for (const [path, body] of [
      ["/api/sync/nodes", { ids: [] }],
      ["/api/sync", { known: Array.from({ length: 50001 }, () => privateId) }],
    ] as const) {
      const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("assembled native requests cannot keep cached access", async () => {
    // Give this isolated workspace the native identity temporarily: native
    // requests act as the workspace's own System (index.ts getNativeActor), so
    // only this workspace's System row is set aside and restored afterwards.
    const systemRows = (await db.q<{ id: string }>("SELECT id FROM actors WHERE workspace_id=$1 AND external_id='system'", [ws])).rows.map(r => r.id);
    await db.q("UPDATE actors SET external_id=$1 WHERE id=ANY($2::uuid[])", [randomUUID(),systemRows]);
    await db.q("UPDATE actors SET external_id='system' WHERE id=$1", [captured.id]);
    const native = async () => assembledApp.request("/api/sync?since=0", { headers: { Origin: "http://localhost" } });
    try {
      expect(await ids(await native(), "GET delta")).toContain(privateId);
      await changeAccess("removed");
      expect(await ids(await native(), "GET delta")).not.toContain(privateId);
      await restoreAccess();
      expect(await ids(await native(), "GET delta")).toContain(privateId);
      await changeAccess("moved");
      const scoped = await ids(await native(), "GET delta");
      expect(scoped).toContain(publicId);
      expect(scoped).not.toContain(privateId);
      await db.q("DELETE FROM actors WHERE id=$1", [captured.id]);
      expect((await native()).status).toBe(401);
    } finally {
      await db.q("UPDATE actors SET external_id=NULL WHERE id=$1", [captured.id]);
      await db.q("UPDATE actors SET external_id='system' WHERE id=ANY($1::uuid[])", [systemRows]);
    }
  });

  it("an actor lookup failure remains a retryable server error and never falls back to cached grants", async () => {
    const error = new Error("actor lookup unavailable");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "q").mockRejectedValueOnce(error);
    const response = await request("nodes");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("[unhandled] unhandled route error"));
    expect(await ids(await request("nodes"), "nodes")).toContain(privateId);
  });
});
