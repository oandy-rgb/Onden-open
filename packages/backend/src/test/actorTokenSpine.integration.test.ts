// Actor + token mutations through the spine (Phase C) against a real Postgres.
// Permission changes are the highest-stakes writes, so they must leave an
// audit trail and clear the admin authority — by construction, via mutate():
//   - creating/deleting an actor and minting/revoking a token each emit an
//     attributed ACTOR_*/TOKEN_* domain event;
//   - token events carry only access metadata, never the plaintext or hash;
//   - a non-owner actor is refused (403); idempotent revoke emits no 2nd event.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import actorsRouter from "../routes/actors.js";
import type { ActorCtx } from "../types.js";
import { nativeOwnerActor, persistActor } from "./helpers/persistActor.js";
import { toolsForAccess } from "../services/agentTools/index.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/actors", actorsRouter);

let admin: ActorCtx = { id: "admin-1", name: "Admin", role: "admin", type: "human" };
let editor: ActorCtx = { id: "editor-1", name: "Editor", role: "editor", type: "human" };
// A delegated bearer token carrying the admin role — must NOT be able to define
// permissions (mint tokens, create actors), or an agent could escalate itself.
let adminToken: ActorCtx = {
  id: "admin-1", name: "Admin", role: "admin", type: "agent",
  tokenScope: { tokenId: "t", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
};
// The native-app owner: type='agent' System actor with NO tokenScope = principal.
let nativeOwner: ActorCtx = { id: "system", name: "System", role: "admin", type: "agent" };
let viewer: ActorCtx = { id: "viewer-1", name: "Viewer", role: "viewer", type: "human" };

const eventsFor = (targetType: string, targetId: string) =>
  q<{ event_type: string; actor_type: string; actor_id: string; payload: Record<string, unknown> }>(
    `SELECT event_type, actor_type, actor_id, payload FROM domain_events
      WHERE target_type = $1 AND target_id = $2 ORDER BY id ASC`,
    [targetType, targetId],
  );

describe.skipIf(!isTestDb)("actor + token mutations via spine (DB)", () => {
  let WS = "";
  beforeAll(async () => {
    // The read/write tool lists include module tools (semanticSearch, suggestLinks).
    registerShippedModules();
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default')
             ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    admin = await persistActor(WS, admin);
    editor = await persistActor(WS, editor);
    adminToken = await persistActor(WS, adminToken);
    nativeOwner = await nativeOwnerActor(WS);
    viewer = await persistActor(WS, viewer);
  });

  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const patch = (path: string, body: unknown) =>
    app.request(path, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const del = (path: string) => app.request(path, { method: "DELETE" });
  const get = (path: string) => app.request(path);

  it("non-admin is refused with 403", async () => {
    currentActor = editor;
    const res = await post("/api/actors", { name: "Bot", type: "agent" });
    expect(res.status).toBe(403);
  });

  it("a delegated admin-role token cannot define permissions, but the principal owner can (incl. native type='agent')", async () => {
    // Delegated token, admin role → blocked from minting/creating (owner_only).
    currentActor = adminToken;
    expect((await post("/api/actors", { name: "Escalated", type: "agent" })).status).toBe(403);
    // Owner via the native app (type='agent', no tokenScope) is NOT locked out.
    currentActor = nativeOwner;
    const created = await post("/api/actors", { name: "ByOwner", type: "agent" });
    expect(created.status).toBe(201);
    const newId = (await created.json()).id as string;
    // …and that owner-created actor's delegated token still can't mint more.
    currentActor = adminToken;
    expect((await post(`/api/actors/${newId}/tokens`, { access: "read" })).status).toBe(403);
  });

  it("non-admin gets 403 BEFORE any existence lookup (no 404 id-probing oracle)", async () => {
    currentActor = editor;
    // A non-admin must not be able to tell a real actor id from a fake one via
    // the response: the admin gate fires first, so a phantom id still 403s.
    const phantom = "00000000-0000-0000-0000-0000000000aa";
    expect((await post(`/api/actors/${phantom}/tokens`, { access: "read" })).status).toBe(403);
    expect((await post(`/api/actors/${phantom}/tokens/${phantom}/revoke`, {})).status).toBe(403);
    expect((await del(`/api/actors/${phantom}/tokens/${phantom}`)).status).toBe(403);
    expect((await patch(`/api/actors/${phantom}/tokens/${phantom}`, { access: "write" })).status).toBe(403);
  });

  it("changing a token's access in place: principal only, audited, secret never reissued", async () => {
    currentActor = admin;
    const a = await post("/api/actors", { name: "Rescope bot", type: "agent" });
    const actorId = (await a.json()).id as string;
    const minted = await post(`/api/actors/${actorId}/tokens`, { name: "rs", access: "read" });
    const tokenId = (await minted.json()).id as string;

    // A delegated admin-role token may NOT change access (would let an agent
    // widen its own grant) — principal_admin only.
    currentActor = adminToken;
    expect((await patch(`/api/actors/${actorId}/tokens/${tokenId}`, { access: "write" })).status).toBe(403);

    // The owner widens it; the secret is NOT reissued.
    currentActor = admin;
    const res = await patch(`/api/actors/${actorId}/tokens/${tokenId}`, { access: "write" });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.access).toBe("write");
    expect(updated.allowed_tools).toEqual(toolsForAccess("write"));
    expect(updated.token).toBeUndefined(); // an access change never hands back plaintext

    // Audit: a TOKEN_ACCESS_CHANGED event naming from/to, no secret.
    const events = await eventsFor("token", tokenId);
    const changed = events.rows.filter((e) => e.event_type === "TOKEN_ACCESS_CHANGED");
    expect(changed.length).toBe(1);
    expect(changed[0]!.payload).toEqual({ actor_id: actorId, from: "read", to: "write" });

    // And back down.
    const res2 = await patch(`/api/actors/${actorId}/tokens/${tokenId}`, { access: "read" });
    expect((await res2.json()).allowed_tools).toEqual(toolsForAccess("read"));

    // Unknown access, empty body → 400 invalid_access; the removed per-tool list → 400.
    const unknown = await patch(`/api/actors/${actorId}/tokens/${tokenId}`, { access: "admin" });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("invalid_access");
    expect((await patch(`/api/actors/${actorId}/tokens/${tokenId}`, {})).status).toBe(400);
    const legacy = await patch(`/api/actors/${actorId}/tokens/${tokenId}`, { allowed_tools: ["getNode"] });
    expect(legacy.status).toBe(400);
    expect((await legacy.json()).error).toBe("custom_tools_removed");

    // Changing a revoked token is rejected (not a back-door revive).
    await post(`/api/actors/${actorId}/tokens/${tokenId}/revoke`, {});
    expect((await patch(`/api/actors/${actorId}/tokens/${tokenId}`, { access: "write" })).status).toBe(404);
  });

  it("the actor roster (GET /api/actors) is closed to non-principals — viewer and delegated admin-token both 403", async () => {
    // Seed at least one actor so a leak would have something to disclose.
    currentActor = nativeOwner;
    expect((await post("/api/actors", { name: "Rostered", type: "agent" })).status).toBe(201);

    // A viewer must not be able to enumerate the actor roster (names/roles/
    // external_ids = the principal target list).
    currentActor = viewer;
    expect((await get("/api/actors")).status).toBe(403);

    // An editor — still not permission-administration, still refused.
    currentActor = editor;
    expect((await get("/api/actors")).status).toBe(403);

    // A delegated bearer token, even one carrying the admin role, is an MCP
    // credential — it cannot read the roster either (no agent self-recon).
    currentActor = adminToken;
    expect((await get("/api/actors")).status).toBe(403);

    // The principal owner (native type='agent', no tokenScope) CAN list.
    currentActor = nativeOwner;
    const ok = await get("/api/actors");
    expect(ok.status).toBe(200);
    expect(Array.isArray(await ok.json())).toBe(true);
  });

  it("creating an actor + minting/revoking a token emit attributed audit events", async () => {
    currentActor = admin;

    // Create actor → ACTOR_CREATED (no role: a member has none)
    const created = await post("/api/actors", { name: "Bot", type: "agent" });
    expect(created.status).toBe(201);
    const actorId = (await created.json()).id as string;
    const actorEvents = await eventsFor("actor", actorId);
    expect(actorEvents.rows.map((e) => e.event_type)).toContain("ACTOR_CREATED");
    expect(actorEvents.rows[0]!.actor_type).toBe("user"); // human admin → 'user'
    expect(actorEvents.rows[0]!.actor_id).toBe(admin.id);

    // Mint token → TOKEN_CREATED, with access metadata but NO secret
    const minted = await post(`/api/actors/${actorId}/tokens`, { name: "ci", access: "write" });
    expect(minted.status).toBe(201);
    const mintedBody = await minted.json();
    const tokenId = mintedBody.id as string;
    expect(typeof mintedBody.token).toBe("string"); // plaintext returned to caller once
    const tokenEvents = await eventsFor("token", tokenId);
    expect(tokenEvents.rows.map((e) => e.event_type)).toContain("TOKEN_CREATED");
    const payload = tokenEvents.rows[0]!.payload;
    const blob = JSON.stringify(payload);
    expect(blob).not.toContain(mintedBody.token);      // no plaintext leak
    expect(blob.toLowerCase()).not.toContain("hash");   // no hash leak
    expect(payload.actor_id).toBe(actorId);
    expect(payload.access).toBe("write");

    // Revoke → TOKEN_REVOKED; second revoke is a no-op with no extra event
    const r1 = await post(`/api/actors/${actorId}/tokens/${tokenId}/revoke`, {});
    expect((await r1.json()).revoked).toBe(true);
    const r2 = await post(`/api/actors/${actorId}/tokens/${tokenId}/revoke`, {});
    expect((await r2.json()).revoked).toBe(false);
    const afterRevoke = await eventsFor("token", tokenId);
    const revokeCount = afterRevoke.rows.filter((e) => e.event_type === "TOKEN_REVOKED").length;
    expect(revokeCount).toBe(1); // idempotent: exactly one audit event
  });

  it("deleting a non-existent token emits no TOKEN_DELETED event", async () => {
    currentActor = admin;
    const a = await post("/api/actors", { name: "Holder", type: "agent" });
    const actorId = (await a.json()).id as string;
    const phantomToken = "00000000-0000-0000-0000-0000000000bb";
    const res = await del(`/api/actors/${actorId}/tokens/${phantomToken}`);
    expect(res.status).toBe(200); // idempotent no-op
    const events = await eventsFor("token", phantomToken);
    expect(events.rows.filter((e) => e.event_type === "TOKEN_DELETED").length).toBe(0);
  });
  it("deleting an agent (external_id NULL) really removes it and its tokens (GAP-113)", async () => {
    currentActor = admin;
    const a = await post("/api/actors", { name: "Doomed bot", type: "agent" });
    const actorId = (await a.json()).id as string;
    const minted = await post(`/api/actors/${actorId}/tokens`, { name: "d", access: "read" });
    const tokenId = (await minted.json()).id as string;

    expect((await del(`/api/actors/${actorId}`)).status).toBe(200);
    expect((await q(`SELECT 1 FROM actors WHERE id = $1`, [actorId])).rows.length).toBe(0);
    expect((await q(`SELECT 1 FROM agent_tokens WHERE id = $1`, [tokenId])).rows.length).toBe(0);
    const events = await eventsFor("actor", actorId);
    expect(events.rows.filter((e) => e.event_type === "ACTOR_DELETED").length).toBe(1);
  });

  it("while the native bypass is on (tests), removing the System actor is an honest 409", async () => {
    currentActor = admin;
    const sys = await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type, external_id)
       VALUES ($1, 'System', 'agent', 'system')
       ON CONFLICT DO NOTHING RETURNING id`,
      [WS],
    );
    const id = sys.rows[0]?.id
      ?? (await q<{ id: string }>(`SELECT id FROM actors WHERE workspace_id = $1 AND external_id = 'system'`, [WS])).rows[0]!.id;
    const res = await del(`/api/actors/${id}`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("system_actor_in_use");
    expect((await q(`SELECT 1 FROM actors WHERE id = $1`, [id])).rows.length).toBe(1);
    expect((await eventsFor("actor", id)).rows.filter((e) => e.event_type === "ACTOR_DELETED")).toEqual([]);
  });

  it("minting stores the EXPANDED tool list for its access level, and the audit event names the access", async () => {
    currentActor = admin;
    const a = await post("/api/actors", { name: "Access bot", type: "agent" });
    const actorId = (await a.json()).id as string;

    const minted = await post(`/api/actors/${actorId}/tokens`, { name: "ro", access: "read" });
    expect(minted.status).toBe(201);
    const body = await minted.json();
    expect(body.access).toBe("read");
    expect(body.template).toBeUndefined();
    expect(body.allowed_tools).toEqual(toolsForAccess("read"));
    expect(body.allowed_tools).toEqual(
      expect.arrayContaining(["searchNodes", "getNode", "semanticSearch", "suggestLinks", "queryView"]),
    );
    expect(body.allowed_tools).not.toContain("createNode");
    // a write token adds editing tools
    const writer = await (await post(`/api/actors/${actorId}/tokens`, { name: "rw", access: "write" })).json();
    expect(writer.allowed_tools).toEqual(expect.arrayContaining(["searchNodes", "createNode", "updateNode"]));
    // the audit event carries the access (reviewable provenance)
    const events = await eventsFor("token", body.id as string);
    expect(events.rows[0]!.payload).toMatchObject({ actor_id: actorId, access: "read", allowed_tools: body.allowed_tools });
  });

  it("minting needs an access (400 invalid_access); the removed role, tool list, template and space lists are 400 with their own code", async () => {
    currentActor = admin;
    const a = await post("/api/actors", { name: "Access bot 2", type: "agent" });
    const actorId = (await a.json()).id as string;
    const code = async (res: Response) => ((await res.json()) as { error: string }).error;
    const none = await post(`/api/actors/${actorId}/tokens`, {});
    expect(none.status).toBe(400);
    expect(await code(none)).toBe("invalid_access");
    expect(await code(await post(`/api/actors/${actorId}/tokens`, { access: "superuser" }))).toBe("invalid_access");
    for (const [extra, error] of [
      [{ template: "read-only" }, "custom_tools_removed"],
      [{ allowed_tools: ["getNode"] }, "custom_tools_removed"],
      [{ read_space_ids: [] }, "token_scope_removed"],
      [{ write_space_ids: null }, "token_scope_removed"],
    ] as const) {
      const res = await post(`/api/actors/${actorId}/tokens`, { access: "read", ...extra });
      expect(res.status).toBe(400);
      expect(await code(res)).toBe(error);
    }
    const withRole = await post("/api/actors", { name: "Roled", type: "agent", role: "editor" });
    expect(withRole.status).toBe(400);
    expect(await code(withRole)).toBe("role_removed");
    expect((await q(`SELECT 1 FROM agent_tokens WHERE actor_id = $1`, [actorId])).rows).toHaveLength(0);
  });
});
