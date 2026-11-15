// The 網站 switch on the website module's own routes (modules/website/index.ts).
//
//   • Off (or never agreed to): publishing writes answer 409 module_not_imported.
//   • Off: taking content DOWN still works — marking a note 「不發布」 queues the
//     static-copy re-push, and the served site drops the page.
//   • Off: an already-public site is still served (reads are never gated).
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import publishRouter from "../modules/website/routes.js";
import { websiteModule } from "../modules/website/index.js";
import { moduleWriteGate } from "../modules/index.js";
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import { isModuleImported, workspaceModules } from "../services/workspaceModules.js";
import type { ActorCtx } from "../types.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { armSiteRebuild, disarmSiteRebuild } from "./helpers/siteRebuild.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";
import { persistActor } from "./helpers/persistActor.js";
import { postVia, publishWithPreview } from "./helpers/publishWithPreview.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

const admin: ActorCtx = { id: "admin-site-switch", name: "Admin", role: "admin", type: "human" };
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", admin); await next(); });
// The gate exactly as mountModules applies it: the module's declared prefixes.
const gate = moduleWriteGate(websiteModule, async (mod) => isModuleImported(await workspaceModules(WS), mod.id));
for (const prefix of websiteModule.routePrefixes ?? []) app.use(prefix, gate).use(`${prefix}/*`, gate);
app.route("/api/nodes", nodesRouter);
app.route("/api", publishRouter);
registerShippedModules();

const json = (method: string, body: unknown = {}) =>
  ({ method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const onSite = async (): Promise<string[]> =>
  (((await loadServedSite(WS)).payload.nodes ?? []) as Array<{ id: string }>).map((n) => n.id);
const pagesPushes: unknown[] = []; // the static-copy re-pushes the drain heard

describe.skipIf(!isTestDb)("website module switch (DB)", () => {
  let pub = "";
  let page = "";
  afterAll(async () => { await disarmSiteRebuild(); });
  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Switch', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    Object.assign(admin, await persistActor(WS, admin));
    pub = await makeSpace(WS, `pub-${randomUUID()}`, [{ id: admin.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
    armSiteRebuild(() => WS, (payload) => { pagesPushes.push(payload); });
  });
  // Tests run in a random order: each starts from a live site with the module on.
  beforeEach(async () => {
    await setModulesOn(WS, null);
    page = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Live page',$2,'body') RETURNING id::text`, [WS, randomUUID()])).rows[0]!.id;
    await putInSpace(page, pub);
    expect((await app.request(`/api/nodes/${page}/attributes/_published`, json("PUT", { value: "true", value_type: "bool" }))).status).toBe(200);
    expect((await publishWithPreview(postVia(app))).status).toBe(201);
    expect(await onSite()).toContain(page);
  });

  it("module off: publishing writes are refused with module_not_imported", async () => {
    await setModulesOn(WS, []);
    for (const path of ["/api/publish", "/api/publish/include", "/api/publish/preview", "/api/preview"]) {
      const res = await app.request(path, json("POST"));
      expect(res.status, path).toBe(409);
      expect(await res.json()).toEqual({ error: "module_not_imported", module: "website" });
    }
  });

  it("never agreed to: the same refusal, and the live site is still served", async () => {
    await q(`UPDATE workspaces SET modules_confirmed = '[]'::jsonb WHERE id = $1`, [WS]);
    expect((await app.request("/api/publish", json("POST"))).status).toBe(409);
    expect(await onSite()).toContain(page);
  });

  it("module off: the public site is still served and the back-office reads stay open", async () => {
    await setModulesOn(WS, []);
    expect(await onSite()).toContain(page);
    expect((await app.request("/api/site")).status).toBe(200);
    expect((await app.request("/api/snapshots")).status).toBe(200);
  });

  it("module off: 「不發布」 still queues the re-push and removes the page from the served site", async () => {
    await setModulesOn(WS, []);
    const pushedBefore = pagesPushes.length;
    expect((await app.request(`/api/nodes/${page}/attributes/_published`, json("PUT", { value: "false", value_type: "bool" }))).status).toBe(200);
    await expect.poll(onSite, { timeout: 5000 }).not.toContain(page);
    // The static copy is pushed again without the page.
    await expect.poll(() => pagesPushes.length, { timeout: 5000 }).toBeGreaterThan(pushedBefore);
  });

  it("module off: trashing a published note still takes it off the site", async () => {
    await setModulesOn(WS, []);
    expect((await app.request(`/api/nodes/${page}`, { method: "DELETE" })).status).toBe(200);
    await expect.poll(onSite, { timeout: 5000 }).not.toContain(page);
  });

  it("module on: publishing works", async () => {
    expect((await publishWithPreview(postVia(app))).status).toBe(201);
  });
});
