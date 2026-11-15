import { persistActor } from "./helpers/persistActor.js";
// Structural prevention: /api/sync's event→channel switch used to silently ignore
// any event type it didn't explicitly name, so a new node-targeting event would
// leave the client's node projection stale (the TAG_APPLIED bug). A targetType=
// 'node' safety net now re-ships the node for ANY such event. Pinned here with an
// event type the switch deliberately does NOT name.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";

// This router harness injects identity; database snapshot/policy remain real.
vi.mock("../services/actorReadSnapshot.js", () => import("./helpers/injectedActorReadSnapshot.js"));
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId, event } from "../db.js";
import syncRouter from "../routes/sync.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/sync", syncRouter);

const admin: ActorCtx = { id: "ssn-admin", name: "Admin", role: "admin", type: "human" };

describe.skipIf(!isTestDb)("sync structural net — node-targeting events converge by default (DB)", () => {
  let WS = "";
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));

  });

  it("a node-targeting event the switch does NOT name still re-ships the node", async () => {
    currentActor = admin;
    const node = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','ssn node','ssn-node-' || $2, 'body') RETURNING id`,
      [WS, String(Date.now())])).rows[0]!.id;
    const since = (await q<{ max: string }>(`SELECT COALESCE(MAX(id),0)::text AS max FROM domain_events`)).rows[0]!.max;

    // An event type NOT in sync.ts's explicit switch, targeting the node. The
    // safety net (target_type='node') must still re-ship it.
    await event(WS, "NODE_BLESSED_FUTURE_TYPE", "node", node, {}, "user", admin.id);

    const delta = (await (await app.request(`/api/sync?since=${since}`)).json()) as { nodes: { upsert: Array<{ id: string }> } };
    expect(delta.nodes.upsert.some((n) => n.id === node)).toBe(true);
  });

  it("a non-node-targeting event (audit) does NOT pull a node row", async () => {
    currentActor = admin;
    const since = (await q<{ max: string }>(`SELECT COALESCE(MAX(id),0)::text AS max FROM domain_events`)).rows[0]!.max;
    // targetType 'token' (governance/audit) — the net must NOT fire.
    await event(WS, "TOKEN_RESCOPED", "token", "ssn-token", {}, "user", admin.id);
    const delta = (await (await app.request(`/api/sync?since=${since}`)).json()) as { nodes: { upsert: Array<{ id: string }> } };
    expect(delta.nodes.upsert.length).toBe(0);
  });
});
