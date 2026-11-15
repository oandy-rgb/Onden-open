// One site, three surfaces (W38a, docs/architecture/site-render-model.md): the
// self-hosted site (GET /api/site), the zip export (GET /api/export-static) and
// the static host push (the same static copy, modules/website/publishing/staticSite.ts,
// rendered by a stand-in for the frontend that reads the served site) all serve
// the latest snapshot minus takedowns:
//   * a note published after the snapshot appears on none of them until the
//     next Publish;
//   * a takedown removes a page from all three at once;
//   * a changed site setting, like an edited body, waits for the next Publish.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("../modules/website/publishing/githubPages.js", () => ({
  pushToGitHubPages: async (files: Array<{ path: string; content: string | Buffer }>) => {
    h.paths = files.map((f) => f.path);
    return "https://example.test/";
  },
  expectedPagesUrl: () => "https://example.test/",
}));

import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import publishRouter from "../modules/website/routes.js";
import { performPagesPush } from "../modules/website/publishing/pagesPush.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { startFakeRenderer } from "./helpers/fakeRenderer.js";
import { seedQ } from "./helpers/seedQ.js";
import { setSiteConfig } from "./helpers/siteConfigFixture.js";
import { publishWithPreview } from "./helpers/publishWithPreview.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let currentActor: ActorCtx | null = null;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api", publishRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let owner: ActorCtx = { id: "one-site-owner", name: "Owner", role: "admin", type: "human" };
let space = "";
let renderer: Awaited<ReturnType<typeof startFakeRenderer>> | null = null;

type Site = { title?: string; payload: { nodes: Array<{ slug: string }>; presentation?: { site?: { brand?: string } } } };
const slugsOf = (site: Site) => site.payload.nodes.map((n) => n.slug).sort();

/** The slugs each surface serves, anonymous where the surface is public. */
async function surfaces(): Promise<Record<"site" | "zip" | "static", string[]>> {
  currentActor = null;
  const site = (await (await app.request("/api/site")).json()) as Site;
  currentActor = owner;
  const zip = Buffer.from(await (await app.request("/api/export-static")).arrayBuffer()).toString("latin1");
  // Entry names sit between binary zip headers: a slug never holds a control byte.
  const zipSlugs = [...zip.matchAll(/site\/([^/\x00-\x1f]+)\/index\.html/g)].map((m) => m[1]!);
  h.paths = [];
  await performPagesPush({ workspaceId, snapshotId: "latest" });
  const pushed = h.paths.flatMap((p) => /^site\/([^/]+)\/index\.html$/.exec(p)?.[1] ?? []);
  return { site: slugsOf(site), zip: [...new Set(zipSlugs)].sort(), static: pushed.sort() };
}
const everywhere = (slugs: string[]) => ({ site: slugs, zip: slugs, static: slugs });

async function markedNote(title: string): Promise<{ id: string; slug: string }> {
  const slug = `${title.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,'body') RETURNING id::text`, [workspaceId, title, slug])).rows[0]!.id;
  await putInSpace(id, space);
  expect((await send(`/api/nodes/${id}/attributes/_published`, "PUT", { value: "true", value_type: "bool" })).status).toBe(200);
  return { id, slug };
}
const publish = async () => { expect((await publishWithPreview((p, b) => send(p, "POST", b))).status).toBe(201); };

describe.skipIf(!isTestDb)("every surface serves the latest snapshot minus takedowns (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('One site',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(workspaceId, owner);
    currentActor = owner;
    space = await makeSpace(workspaceId, `pub-${randomUUID()}`, [{ id: owner.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
    // The static copy asks the frontend for each page; a stand-in answers.
    renderer = await startFakeRenderer(workspaceId);
  });
  afterAll(async () => { await renderer?.close(); });

  it("a note published after the snapshot waits for the next publish; a takedown leaves all three at once", async () => {
    const first = await markedNote("First");
    await publish();
    expect(await surfaces()).toEqual(everywhere([first.slug]));

    const later = await markedNote("Later");
    expect(await surfaces()).toEqual(everywhere([first.slug])); // marked after the snapshot: nowhere yet

    await publish();
    expect(await surfaces()).toEqual(everywhere([first.slug, later.slug].sort()));

    // Unpublished (a note can no longer be hidden, D104): taken down at once.
    expect((await send(`/api/nodes/${first.id}/attributes/_published`, "PUT", { value: "false", value_type: "bool" })).status).toBe(200);
    expect(await surfaces()).toEqual(everywhere([later.slug])); // no publish needed to take it down
  });

  it("a changed site setting waits for the next publish", async () => {
    await setSiteConfig(workspaceId, { brand: "Before" });
    await publish();
    const brand = async () => {
      currentActor = null;
      const site = (await (await app.request("/api/site")).json()) as Site;
      currentActor = owner;
      return site.payload.presentation?.site?.brand;
    };
    expect(await brand()).toBe("Before");
    await setSiteConfig(workspaceId, { brand: "After" });
    expect(await brand()).toBe("Before");
    await publish();
    expect(await brand()).toBe("After");
  });

  it("the site carries the workspace's zone, so site dates show the server's day (D46)", async () => {
    await publish();
    const { workspaceTimeZone, dayClock } = await import("../localDay.js");
    type Zoned = { payload: { presentation?: { time_zone?: string; day_start_hour?: number } } };
    currentActor = null;
    const site = (await (await app.request("/api/site")).json()) as Zoned;
    currentActor = owner;
    expect(site.payload.presentation?.time_zone).toBe(workspaceTimeZone());
    expect(site.payload.presentation?.day_start_hour).toBe(dayClock().dayStartHour);
  });
});
