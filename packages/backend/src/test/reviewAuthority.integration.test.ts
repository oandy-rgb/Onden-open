// D77: "who may review" is one rule — spine/authority.ts reviewAuthority —
// used by the inbox routes, eventReview's spine authority and the bootstrap's
// `can_review`. Since the owner/member model (migration 127) that rule is the
// workspace owner alone, and members have no workspace role to change:
//
//   - the owner reviews: held approvals, owner-tier included, and failed
//     deliveries are listed to them and they can decide;
//   - nobody else does, however much they may edit: a member who used to be a
//     reviewer or an admin, a viewer, an agent actor without a token, and a
//     delegated token all get an empty queue and 403 on deciding;
//   - PATCH/POST /api/actors with a `role` is 400 role_removed (the owner
//     cannot lose or change ownership through the roster either).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";

// A workspace of its own: its owner is whoever was persisted last as a human
// (fixture shorthand "admin"), its approval queue is the whole workspace's, and bootstrap reads all
// of it — none of which should depend on other tests' rows.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
import inboxRouter from "../routes/inbox.js";
import actorsRouter from "../routes/actors.js";
import { reviewAuthority } from "../spine/authority.js";
import { buildBootstrap } from "../services/sync/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/inbox", inboxRouter);
app.route("/api/actors", actorsRouter);

const deputy: ActorCtx = { id: "d77-deputy", name: "Deputy", role: "admin", type: "human" };
const owner: ActorCtx = { id: "d77-owner", name: "Owner", role: "admin", type: "human" };
const reviewer: ActorCtx = { id: "d77-rev", name: "Reviewer", role: "reviewer", type: "human" };
const viewer: ActorCtx = { id: "d77-viewer", name: "Viewer", role: "viewer", type: "human" };
const sessionAgent: ActorCtx = { id: "d77-agent", name: "Agent", role: "reviewer", type: "agent" };
const token: ActorCtx = {
  id: "d77-token", name: "Bot", role: "admin", type: "agent",
  tokenScope: { tokenId: "t", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
};

const patch = (id: string, body: unknown) =>
  app.request(`/api/actors/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const listApprovals = async () => (await (await app.request("/api/inbox/approvals")).json()) as { approvals: Array<{ id: string; effect_kind: string }> };
const listFailed = async () => (await (await app.request("/api/inbox/failed-effects")).json()) as { failed: Array<{ id: string }> };
const ownerId = async () => (await q<{ id: string | null }>(`SELECT owner_actor_id::text AS id FROM workspaces WHERE id = $1`, [WS])).rows[0]!.id;

describe.skipIf(!isTestDb)("D77 review authority and the owner's role (DB)", () => {
  let publishId = "";
  let deadId = "";

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('D77', $1) RETURNING id::text`, [`d77-${randomUUID()}`])).rows[0]!.id;
    // The last human admin persisted becomes the owner (persistActor).
    for (const a of [deputy, owner, reviewer, viewer, sessionAgent, token]) Object.assign(a, await persistActor(WS, a));
  });

  beforeEach(async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1 AND dedup_key LIKE 'd77-%'`, [WS]);
    // Dedup keys are unique across workspaces while pending: name them per run.
    publishId = (await q<{ id: string }>(
      `INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload, status)
       VALUES ($1, 'tag_pack', $2, '{}', 'pending_approval') RETURNING id::text`, [WS, `d77-pack-${WS}`])).rows[0]!.id;
    deadId = (await q<{ id: string }>(
      `INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload, status, last_error)
       VALUES ($1, 'pages_push', $2, '{}', 'dead', 'boom') RETURNING id::text`, [WS, `d77-dead-${WS}`])).rows[0]!.id;
  });

  it("reviewAuthority: only the owner reviews; a former reviewer or admin, a viewer, an agent actor and a token do not", async () => {
    expect(await reviewAuthority(owner)).toBe(true);
    expect(await reviewAuthority(reviewer)).toBe(false);
    expect(await reviewAuthority(deputy)).toBe(false);
    expect(await reviewAuthority(viewer)).toBe(false);
    expect(await reviewAuthority(sessionAgent)).toBe(false);
    expect(await reviewAuthority(token)).toBe(false);
  });

  it("the owner sees approvals (owner tier too) and failed deliveries, and decides", async () => {
    currentActor = owner;
    expect((await listApprovals()).approvals.map((a) => a.id)).toContain(publishId);
    expect((await listFailed()).failed.map((f) => f.id)).toContain(deadId);
  });

  it("reviewer and deputy are plain members: nothing listed, nothing decidable; the owner decides", async () => {
    for (const actor of [reviewer, deputy]) {
      currentActor = actor;
      expect((await listApprovals()).approvals.map((a) => a.id)).not.toContain(publishId);
      expect((await listFailed()).failed).toEqual([]);
      expect((await app.request(`/api/inbox/approvals/${publishId}/approve`, { method: "POST" })).status).toBe(403);
    }
    currentActor = owner;
    expect((await app.request(`/api/inbox/approvals/${publishId}/reject`, { method: "POST" })).status).toBe(200);
  });

  it("a viewer gets an empty queue and 403 on deciding", async () => {
    currentActor = viewer;
    expect((await listApprovals()).approvals).toEqual([]);
    const res = await app.request(`/api/inbox/batch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", event_ids: ["1"] }),
    });
    expect(res.status).toBe(403);
  });

  it("bootstrap: can_review follows reviewAuthority", async () => {
    expect((await buildBootstrap(owner, WS, { slimBodies: true })).can_review).toBe(true);
    expect((await buildBootstrap(reviewer, WS, { slimBodies: true })).can_review).toBe(false);
    expect((await buildBootstrap(deputy, WS, { slimBodies: true })).can_review).toBe(false);
    expect((await buildBootstrap(viewer, WS, { slimBodies: true })).can_review).toBe(false);
  });

  it("a role change is 400 role_removed — for the owner too — and ownership stays; a rename still works", async () => {
    currentActor = owner;
    for (const role of ["editor", "viewer", "reviewer", "admin"]) {
      const res = await patch(owner.id, { role });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "role_removed" });
    }
    expect(await ownerId()).toBe(owner.id);
    expect((await patch(owner.id, { name: "Owner Renamed" })).status).toBe(200);
  });

  it("a role on a member or a new actor is 400 role_removed, valid or not", async () => {
    currentActor = owner;
    for (const role of ["superuser", "editor"]) {
      const bad = await patch(reviewer.id, { role });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: "role_removed" });
    }
    const badCreate = await app.request("/api/actors", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", type: "human", role: "root" }),
    });
    expect(badCreate.status).toBe(400);
    expect(await badCreate.json()).toMatchObject({ error: "role_removed" });
  });

  it("the roster marks the owner's row", async () => {
    currentActor = owner;
    const rows = (await (await app.request("/api/actors")).json()) as Array<{ id: string; is_owner: boolean }>;
    expect(rows.find((r) => r.id === owner.id)?.is_owner).toBe(true);
    expect(rows.find((r) => r.id === deputy.id)?.is_owner).toBe(false);
  });
});
