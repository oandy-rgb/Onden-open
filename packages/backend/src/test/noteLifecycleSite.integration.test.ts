import { persistActor } from "./helpers/persistActor.js";
// A published note leaves the site when it leaves the public set by any
// route (the site is the latest snapshot minus takedowns, W38a; the static
// host's re-push runs after the COMMIT):
//   - trashing it (DELETE) takes it off; undelete does not put it back by itself: a note taken off
//     the site returns with the next Publish (owner 2026-11-14, publishing/takenDown.ts);
//   (every rebuild rides the outbox — site_rebuild — after the commit, so the
//   checks poll);
//   - undoing its delete from event history: the same, back with the next Publish;
//   - a move into a publishing space shows it at the next Publish; undoing
//     the move takes it off (scan P0 #6).
//   - deleting a published canvas takes it off (the canvas route used to stamp
//     deleted_at itself and tell no module).
// Also: undoing a delete after another note took the slug re-slugs instead of
// failing (scan P2 #31).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import canvasesRouter from "../routes/canvases.js";
import publishRouter from "../modules/website/routes.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import { moveToSpace } from "../services/spaces.js";
import type { ActorCtx } from "../types.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { armSiteRebuild, disarmSiteRebuild } from "./helpers/siteRebuild.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { postVia, publishWithPreview } from "./helpers/publishWithPreview.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/canvases", canvasesRouter);
app.route("/api", publishRouter);
registerShippedModules();

const admin: ActorCtx = { id: "admin-lifecycle", name: "Admin", role: "admin", type: "human" };
const json = (method: string, body: unknown = {}) =>
  ({ method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

// Its own workspace: the shared 'default' one holds other files' notes.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
let pub = "";
let priv = "";

const onSite = async (): Promise<string[]> =>
  (((await loadServedSite(WS)).payload.nodes ?? []) as Array<{ id: string }>).map((n) => n.id);
const publish = async () => { expect((await publishWithPreview(postVia(app))).status).toBe(201); };
const lastEvent = async (type: string, target: string) =>
  (await q<{ id: string }>(
    `SELECT id::text FROM domain_events WHERE event_type = $1 AND target_id = $2 ORDER BY domain_events.id DESC LIMIT 1`, [type, target],
  )).rows[0]!.id;
const epoch = async () =>
  (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [WS])).rows[0]!.e;

/** A note in `spaceId`, marked for publishing through the attribute route. */
async function publishedNote(spaceId: string, title = `Page ${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,'body') RETURNING id::text`, [WS, title, randomUUID()])).rows[0]!.id;
  await putInSpace(id, spaceId);
  expect((await app.request(`/api/nodes/${id}/attributes/_published`, json("PUT", { value: "true", value_type: "bool" }))).status).toBe(200);
  return id;
}

describe.skipIf(!isTestDb)("a published note leaving the site by trash or undo (DB)", () => {
  afterAll(async () => { await disarmSiteRebuild(); });
  beforeAll(async () => {
    armSiteRebuild(() => WS); // rebuilds ride the outbox (site_rebuild)
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Site test', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    Object.assign(admin, await persistActor(WS, admin));
    currentActor = admin;
    pub = await makeSpace(WS, `pub-${randomUUID()}`, [{ id: admin.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
    priv = await makeSpace(WS, `priv-${randomUUID()}`, [{ id: admin.id, role: "manager" }], { publish: false, external_ai: false, backup: true });
    await publishedNote(pub);
    // republishSite only reconverges a site that was published once.
    expect((await publishWithPreview(postVia(app))).status).toBe(201);
  });

  it("trashing a published note takes it off the site; after undelete it returns with the next publish", async () => {
    const page = await publishedNote(pub);
    expect(await onSite()).not.toContain(page); // marked: on the site at the next Publish
    await publish();
    expect(await onSite()).toContain(page);
    expect((await app.request(`/api/nodes/${page}`, { method: "DELETE" })).status).toBe(200);
    await expect.poll(onSite, { timeout: 5000 }).not.toContain(page);
    expect((await app.request(`/api/nodes/${page}/undelete`, json("POST"))).status).toBe(200);
    expect(await onSite()).not.toContain(page);
    await publish();
    expect(await onSite()).toContain(page);
  });

  it("undoing its delete from history brings it back re-slugged if its slug was taken, on the site with the next publish", async () => {
    const title = `Plan ${randomUUID().slice(0, 8)}`;
    const page = await publishedNote(pub, title);
    await publish();
    const slug = (await q<{ slug: string }>(`SELECT slug FROM content_nodes WHERE id = $1`, [page])).rows[0]!.slug;
    expect((await app.request(`/api/nodes/${page}`, { method: "DELETE" })).status).toBe(200);
    await expect.poll(onSite, { timeout: 5000 }).not.toContain(page);
    // Another note takes the slug while this one is in the trash.
    const squatter = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'x') RETURNING id::text`, [WS, title, slug])).rows[0]!.id;
    await putInSpace(squatter, pub);

    const result = await restoreEvent(await lastEvent("NODE_DELETED", page), { actor: admin, workspaceId: WS });
    expect(result).toMatchObject({ restored: true });
    expect((await q<{ slug: string }>(`SELECT slug FROM content_nodes WHERE id = $1`, [page])).rows[0]!.slug).not.toBe(slug);
    expect(await onSite()).not.toContain(page);
    await publish();
    expect(await onSite()).toContain(page);
  });

  it("deleting a published canvas takes it off the site", async () => {
    const board = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','canvas','Board',$2,'') RETURNING id::text`, [WS, `canvas-${randomUUID()}`])).rows[0]!.id;
    await putInSpace(board, pub);
    expect((await app.request(`/api/nodes/${board}/attributes/_published`, json("PUT", { value: "true", value_type: "bool" }))).status).toBe(200);
    await publish();
    expect(await onSite()).toContain(board);
    expect((await app.request(`/api/canvases/${board}`, { method: "DELETE" })).status).toBe(200);
    // The rebuild runs once the delete's transaction commits.
    await expect.poll(onSite, { timeout: 5000 }).not.toContain(board);
  });

  it("a move into a publishing space shows at the next publish; undoing it takes the page off (scan #6)", async () => {
    const page = await publishedNote(priv);
    await publish();
    expect(await onSite()).not.toContain(page); // marked, but its space doesn't publish
    await moveToSpace(admin, WS, page, pub, await epoch());
    expect(await onSite()).not.toContain(page); // publishable now, not yet published
    await publish();
    expect(await onSite()).toContain(page);

    const result = await restoreEvent(await lastEvent("NODE_MOVED_SPACE", page), { actor: admin, workspaceId: WS });
    expect(result).toMatchObject({ restored: true });
    expect((await q<{ space_id: string }>(`SELECT space_id::text FROM content_nodes WHERE id = $1`, [page])).rows[0]!.space_id).toBe(priv);
    // The rebuild runs after the undo's transaction commits, not within the call.
    await expect.poll(onSite, { timeout: 5000 }).not.toContain(page);
  });
});
