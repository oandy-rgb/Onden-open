import { persistActor } from "./helpers/persistActor.js";
// 「隱藏」 is for tags only (the user's decision, D104):
//   - PATCH /api/nodes/:id { hidden: true } on a note answers 400
//     only_tags_can_be_hidden, and POST /api/nodes refuses a hidden note;
//     showing a note again stays allowed;
//   - a tag is hidden and shown through the same node update: a NODE_UPDATED
//     event each way, the tag catalog carries the flag, and undo puts it back;
//   - the published site never shows a hidden tag: the snapshot leaves its
//     chip out, and hiding a tag after a Publish takes its chip off the served
//     site at once (the takedown) — the note itself stays on the site.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import publishRouter from "../modules/website/routes.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import { readTagCatalog } from "../services/tagCatalog.js";
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
app.route("/api", publishRouter);
registerShippedModules();

const admin: ActorCtx = { id: "admin-hidden-tags", name: "Admin", role: "admin", type: "human" };
const json = (method: string, body: unknown = {}) =>
  ({ method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

// Its own workspace: the shared 'default' one holds other files' notes.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
let pub = "";

const hiddenOf = async (id: string) =>
  (await q<{ hidden: boolean }>(`SELECT hidden FROM content_nodes WHERE id = $1`, [id])).rows[0]!.hidden;
const lastEvent = async (type: string, target: string) =>
  (await q<{ id: string; payload: Record<string, unknown> }>(
    `SELECT id::text, payload FROM domain_events WHERE event_type = $1 AND target_id = $2 ORDER BY domain_events.id DESC LIMIT 1`, [type, target],
  )).rows[0];
const servedTags = async (nodeId: string): Promise<string[] | undefined> =>
  (((await loadServedSite(WS)).payload.nodes ?? []) as Array<{ id: string; tags?: string[] }>).find((n) => n.id === nodeId)?.tags;
const snapshotTags = async (nodeId: string): Promise<string[] | undefined> => {
  const row = (await q<{ payload: { nodes?: Array<{ id: string; tags?: string[] }> } }>(
    `SELECT payload FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [WS])).rows[0];
  return row?.payload.nodes?.find((n) => n.id === nodeId)?.tags;
};

async function note(title = `Note ${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,'body') RETURNING id::text`, [WS, title, randomUUID()])).rows[0]!.id;
  await putInSpace(id, pub);
  return id;
}

/** A plain label tag (no schema) — the kind the site lists as a chip. */
async function labelTag(name: string): Promise<string> {
  return (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
     VALUES ($1,'manual','class_tag',$2,$3) RETURNING id::text`, [WS, name, `tag-${randomUUID()}`])).rows[0]!.id;
}

async function tagNote(nodeId: string, tagId: string): Promise<void> {
  await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [nodeId, tagId]);
}

describe.skipIf(!isTestDb)("hiding is for tags only (D104, DB)", () => {
  afterAll(async () => { await disarmSiteRebuild(); });
  beforeAll(async () => {
    armSiteRebuild(() => WS);
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Hidden tags', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    Object.assign(admin, await persistActor(WS, admin));
    currentActor = admin;
    pub = await makeSpace(WS, `pub-${randomUUID()}`, [{ id: admin.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
  });

  it("refuses to hide a note (400 only_tags_can_be_hidden) and changes nothing", async () => {
    const id = await note();
    const res = await app.request(`/api/nodes/${id}`, json("PATCH", { hidden: true }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "only_tags_can_be_hidden" });
    expect(await hiddenOf(id)).toBe(false);
    expect(await lastEvent("NODE_UPDATED", id)).toBeUndefined();
  });

  it("refuses to create a hidden note", async () => {
    const res = await app.request("/api/nodes", json("POST", { title: `Born hidden ${randomUUID().slice(0, 6)}`, hidden: true }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "only_tags_can_be_hidden" });
  });

  it("still shows a note hidden before the change (unhide is allowed)", async () => {
    const id = await note();
    await seedQ(`UPDATE content_nodes SET hidden = true WHERE id = $1`, [id]);
    const res = await app.request(`/api/nodes/${id}`, json("PATCH", { hidden: false }));
    expect(res.status).toBe(200);
    expect(await hiddenOf(id)).toBe(false);
  });

  it("hides and shows a tag through the node update: an event each way, the catalog flag, and undo", async () => {
    const tag = await labelTag(`secret-${randomUUID().slice(0, 6)}`);
    const catalogHidden = async () => (await readTagCatalog(admin, WS) as unknown as Array<{ id: string; hidden: boolean }>).find((t) => t.id === tag)?.hidden;
    expect(await catalogHidden()).toBe(false);

    const hide = await app.request(`/api/nodes/${tag}`, json("PATCH", { hidden: true }));
    expect(hide.status, await hide.clone().text()).toBe(200);
    expect(await hiddenOf(tag)).toBe(true);
    expect(await catalogHidden()).toBe(true);
    const hidEvent = await lastEvent("NODE_UPDATED", tag);
    expect(hidEvent?.payload).toMatchObject({ hidden: true });

    // Undo the hide: the tag is listed again.
    expect(await restoreEvent(hidEvent!.id, { actor: admin, workspaceId: WS })).toMatchObject({ restored: true });
    expect(await hiddenOf(tag)).toBe(false);

    // Hide again, then show it with a second update.
    expect((await app.request(`/api/nodes/${tag}`, json("PATCH", { hidden: true }))).status).toBe(200);
    expect((await app.request(`/api/nodes/${tag}`, json("PATCH", { hidden: false }))).status).toBe(200);
    expect(await hiddenOf(tag)).toBe(false);
    expect((await lastEvent("NODE_UPDATED", tag))?.payload).toMatchObject({ hidden: false });
  });

  it("the published payload leaves a hidden tag out; hiding after a Publish takes the chip off at once", async () => {
    const page = await note();
    const shown = await labelTag(`shown-${randomUUID().slice(0, 6)}`);
    const secret = await labelTag(`secret-${randomUUID().slice(0, 6)}`);
    const later = await labelTag(`later-${randomUUID().slice(0, 6)}`);
    for (const tag of [shown, secret, later]) await tagNote(page, tag);
    const name = async (id: string) => (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [id])).rows[0]!.title;
    expect((await app.request(`/api/nodes/${secret}`, json("PATCH", { hidden: true }))).status).toBe(200);
    expect((await app.request(`/api/nodes/${page}/attributes/_published`, json("PUT", { value: "true", value_type: "bool" }))).status).toBe(200);

    expect((await publishWithPreview(postVia(app))).status).toBe(201);
    // The snapshot is born without the hidden tag; the note is on the site.
    expect(await snapshotTags(page)).toEqual([await name(shown), await name(later)]);
    expect(await servedTags(page)).toEqual([await name(shown), await name(later)]);

    // Hidden after the Publish: the served site drops its chip before any
    // new Publish; the note stays.
    expect((await app.request(`/api/nodes/${later}`, json("PATCH", { hidden: true }))).status).toBe(200);
    expect(await servedTags(page)).toEqual([await name(shown)]);
    // Shown again: the snapshot froze its chip, so the chip comes back (the
    // secret tag, hidden at the Publish, stays off until the next one).
    expect((await app.request(`/api/nodes/${later}`, json("PATCH", { hidden: false }))).status).toBe(200);
    expect(await servedTags(page)).toEqual([await name(shown), await name(later)]);
  });
});
