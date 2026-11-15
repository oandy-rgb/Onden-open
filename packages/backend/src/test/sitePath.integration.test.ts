// A note's site address, read off the served snapshot (D42), against a real
// Postgres:
//   - GET /api/site/url/:id is the address the app's Copy link hands out:
//     two published "Plan" notes from different spaces get two addresses
//     (bug 2), and a note renamed after Publish keeps the snapshot's address,
//     which the site still serves (bug 3);
//   - `[[My Alias]]` survives redaction, named by the aliased note's served
//     slug (option 3: the snapshot lists no aliases), and opens that note on
//     the site, in the zip and in the single-note export (bug 1), the zip
//     linking relatively (bug 4).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import publishRouter from "../modules/website/routes.js";
import type { ActorCtx } from "../types.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { armSiteRebuild, disarmSiteRebuild } from "./helpers/siteRebuild.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, publishDefaultSpace } from "./helpers/spaceFixtures.js";
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import type { NodeRow } from "../modules/website/publishing/index.js";
import { servedLinkTarget } from "@onden/markdown";
import { seedQ } from "./helpers/seedQ.js";
import { postVia, publishWithPreview } from "./helpers/publishWithPreview.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api", publishRouter);
registerShippedModules();

const admin: ActorCtx = { id: "admin-1", name: "Admin", role: "admin", type: "human" };
const put = (id: string, key: string, value: string) => app.request(`/api/nodes/${id}/attributes/${key}`, {
  method: "PUT", body: JSON.stringify({ value }), headers: { "Content-Type": "application/json" },
});
const urlOf = async (id: string) =>
  ((await (await app.request(`/api/site/url/${id}`)).json()) as { published_url: string | null }).published_url;

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

describe.skipIf(!isTestDb)("site addresses come from the served snapshot (DB)", () => {
  const ids: Record<string, string> = {};
  afterAll(async () => { await disarmSiteRebuild(); });
  beforeAll(async () => {
    armSiteRebuild(() => WS);
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Site path test', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    await publishDefaultSpace(WS);
    Object.assign(admin, await persistActor(WS, admin));
    currentActor = admin;
    const lab = await makeSpace(WS, "lab", [{ id: admin.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
    const insert = async (key: string, title: string, slug: string, markdown: string, space: string | null) => {
      ids[key] = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
         VALUES ($1, 'manual', 'content', $2, $3, $4, coalesce($5::uuid, (SELECT id FROM spaces WHERE workspace_id = $1 AND is_default)))
         RETURNING id::text`, [WS, title, slug, markdown, space],
      )).rows[0]!.id;
      expect((await put(ids[key]!, "_published", "true")).status).toBe(200);
    };
    await insert("plan", "Plan", "plan", "default plan", null);
    await insert("labPlan", "Plan", "plan", "lab plan", lab);
    await insert("target", "Target", "target", "target body", null);
    await insert("links", "Links", "links", "[[My Alias]] and [[Nowhere]]", null);
    expect((await put(ids.target!, "aliases", JSON.stringify(["My Alias"]))).status).toBe(200);
    const published = await publishWithPreview(postVia(app));
    expect(published.status).toBe(201);
  });

  it("bug 2: two published Plan notes from different spaces have two addresses", async () => {
    expect(await urlOf(ids.plan!)).toBe("/site/plan");
    expect(await urlOf(ids.labPlan!)).toBe(`/site/plan-${ids.labPlan!.slice(0, 6)}`);
  });

  it("bug 3: a note renamed after Publish keeps the address the site serves", async () => {
    await seedQ(`UPDATE content_nodes SET title = 'Plan B', slug = 'plan-b' WHERE id = $1`, [ids.plan]);
    expect(await urlOf(ids.plan!)).toBe("/site/plan");
    const served = (await loadServedSite(WS)).payload.nodes as NodeRow[];
    expect(served.find((n) => n.slug === "plan")?.id).toBe(ids.plan);
    // Not on the site: no address, rather than one that 404s.
    expect(await urlOf(randomUUID())).toBeNull();
  });

  it("bugs 1 + 4: [[My Alias]] survives the snapshot and links the aliased page", async () => {
    const site = await loadServedSite(WS);
    const served = site.payload.nodes as NodeRow[];
    expect(served.find((n) => n.id === ids.links)?.markdown).toBe("[[target|My Alias]] and (private)");
    expect(JSON.stringify(site)).not.toContain('"aliases"');
    // The site opens it by the served slug (servedLinkTarget, no aliases).
    expect(servedLinkTarget("target|My Alias", served, ids.links)?.id).toBe(ids.target);
    const exported = await (await app.request(`/api/nodes/${ids.links}/export.html`)).text();
    expect(exported).toContain('href="/site/target">My Alias</a>');
    // The unpublished target was made inert by the snapshot; the live text
    // in the export names no page of the site: plain text either way.
    expect(exported).not.toContain("Nowhere</a>");
  });
});
