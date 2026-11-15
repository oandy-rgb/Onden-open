// P0 publish/site leak stop-gaps (A-group). Proves a RESTRICTED actor (a viewer
// or an empty-space-scope bearer token) can no longer pull restricted data through
// the publish back-office:
//
//   1. GET /api/git/diff/:hash — admin-only.
//   2. GET /api/snapshots — admin-only.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import publishRouter from "../modules/website/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api", publishRouter);

const admin: ActorCtx = { id: "pcl-admin", name: "PCL Admin", role: "admin", type: "human" };
const viewer: ActorCtx = { id: "pcl-viewer", name: "PCL Viewer", role: "viewer", type: "human" };
const emptyToken: ActorCtx = {
  id: "pcl-token", name: "PCL empty-scope token", role: "admin", type: "agent",
  tokenScope: { tokenId: "pcl-tok-empty", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null },
};

describe.skipIf(!isTestDb)("publish/site leak stop-gaps (A-group, DB)", () => {
  let WS = "";

  beforeAll(async () => {
    WS = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Test','default')
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    )).rows[0]!.id;
    expect(WS).toBe(await getWorkspaceId());
    Object.assign(admin, await persistActor(WS, admin));
    Object.assign(viewer, await persistActor(WS, viewer));
    Object.assign(emptyToken, await persistActor(WS, emptyToken));

    await seedQ(
      `DELETE FROM content_nodes WHERE workspace_id = $1
         AND (slug LIKE 'pcl-%' OR title LIKE 'pcl %'
              OR (node_type = 'class_tag' AND title LIKE 'pcl-%'))`,
      [WS],
    );
  });

  it("GET /api/git/diff/:hash is admin-only (viewer + empty-scope token forbidden)", async () => {
    for (const [label, actor] of [["viewer", viewer], ["empty-scope token", emptyToken], ["anonymous", null]] as const) {
      currentActor = actor;
      const res = await app.request("/api/git/diff/deadbeef");
      // Anonymous is unauthenticated (401); a member or token is forbidden.
      expect([401, 403], `${label} must be denied /git/diff`).toContain(res.status);
    }
    currentActor = admin;
    const ok = await app.request("/api/git/diff/deadbeef");
    expect(ok.status).not.toBe(403);
  });

  it("GET /api/snapshots is admin-only (viewer + empty-scope token forbidden)", async () => {
    for (const [label, actor] of [["viewer", viewer], ["empty-scope token", emptyToken], ["anonymous", null]] as const) {
      currentActor = actor;
      const res = await app.request("/api/snapshots");
      expect([401, 403], `${label} must be denied /snapshots`).toContain(res.status);
    }
    currentActor = admin;
    expect((await app.request("/api/snapshots")).status).toBe(200);
  });
});
