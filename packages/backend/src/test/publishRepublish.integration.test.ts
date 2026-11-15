import { persistActor } from "./helpers/persistActor.js";
// Publish toggle + auto-redeploy on unpublish (audit #2) against a real Postgres.
//   - The `_published` opt-in toggle is writable via the attributes route
//     (it was wrongly rejected as a reserved key, so the toggle never worked).
//   - Un-publishing re-pushes the static site at once: no new snapshot (the
//     site is the latest snapshot minus takedowns, W38a), the latest one
//     pushed again, without the node.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import nodesRouter from "../routes/nodes.js";
import publishRouter from "../modules/website/routes.js";
import type { ActorCtx } from "../types.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { armSiteRebuild, disarmSiteRebuild } from "./helpers/siteRebuild.js";
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";
import { postVia, publishWithPreview } from "./helpers/publishWithPreview.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api", publishRouter);
// The re-deploy on `_published` is the website module's attribute hook.
registerShippedModules();

const admin: ActorCtx = { id: "admin-1", name: "Admin", role: "admin", type: "human" };

const setPublished = (id: string) =>
  app.request(`/api/nodes/${id}/attributes/_published`, {
    method: "PUT", body: JSON.stringify({ value: "true", value_type: "bool" }), headers: { "Content-Type": "application/json" },
  });
// 「不發布」: the default space publishes, so a note leaves the site by keeping itself off.
const unpublish = (id: string) =>
  app.request(`/api/nodes/${id}/attributes/_published`, {
    method: "PUT", body: JSON.stringify({ value: "false", value_type: "bool" }), headers: { "Content-Type": "application/json" },
  });
const snapshotCount = async () =>
  Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM publish_snapshots WHERE workspace_id = $1`, [WS])).rows[0]!.n);
const servedNodeIds = async (): Promise<string[]> =>
  (((await loadServedSite(WS)).payload.nodes ?? []) as Array<{ id: string }>).map((n) => n.id);
const pushes: Array<Record<string, unknown>> = [];

// Its own workspace: the shared 'default' one holds other files' notes.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
describe.skipIf(!isTestDb)("publish toggle + redeploy on unpublish (DB)", () => {
  let node = "";
  afterAll(async () => { await disarmSiteRebuild(); });
  beforeAll(async () => {
    armSiteRebuild(() => WS, (p) => pushes.push(p)); // rebuilds ride the outbox (site_rebuild)
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Site test', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    await publishDefaultSpace(WS);
    await setModulesOn(WS, null);
    Object.assign(admin, await persistActor(WS, admin));

    await q(`DELETE FROM publish_snapshots WHERE workspace_id = $1`, [WS]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [WS]);
    node = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Page','page-${Date.now()}','body') RETURNING id`,
      [WS],
    )).rows[0]!.id;
  });

  it("the `_published` toggle is writable (carve-out from reserved keys); other `_` keys still rejected", async () => {
    currentActor = admin;
    expect((await setPublished(node)).status).toBe(200); // was 400 before the fix
    const row = await q(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_published'`, [node]);
    expect(row.rows[0]).toMatchObject({ value: "true" });
    // a genuinely-derived reserved key is still rejected
    const status = (await app.request(`/api/nodes/${node}/attributes/_status`, {
      method: "PUT", body: JSON.stringify({ value: "x" }), headers: { "Content-Type": "application/json" },
    })).status;
    expect(status).toBe(400);
  });

  it("un-publishing re-pushes the latest snapshot without the node (static site converges)", async () => {
    currentActor = admin;
    expect((await setPublished(node)).status).toBe(200); // published, whichever test ran first
    expect((await publishWithPreview(postVia(app))).status).toBe(201);
    expect(await servedNodeIds()).toContain(node);
    const before = await snapshotCount();
    await expect.poll(() => pushes.length, { timeout: 5000 }).toBeGreaterThan(0);
    const pushed = pushes.length;

    expect((await unpublish(node)).status).toBe(200);
    expect(await servedNodeIds()).not.toContain(node);
    // The re-push runs once the attribute write commits; no new snapshot.
    await expect.poll(() => pushes.length, { timeout: 5000 }).toBe(pushed + 1);
    expect(await snapshotCount()).toBe(before);
  });
});
