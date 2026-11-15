// The published site never keeps what it should no longer show (W34):
//   * undoing 「發布」 from history (back to 「不發布」) takes the page off;
//   * a note can't be hidden (D104); one hidden before that is off the
//     site, and showing it again puts it back;
//   * moving it out of a publishing space takes it off (tags carry no read
//     permission under spaces: a space is what restricts reading);
//   * trashing a published note takes it off;
//   * the static export (the whole site) is the owner's: another member gets 403;
//   * a module-owned reserved key is never undone on its own.
// The site is the latest snapshot minus takedowns (W38a): a page joins it at
// the next Publish, and leaves it as soon as the change commits. The static
// host's re-push rides the outbox, so the checks poll.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi, afterAll } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { trashNode } from "../services/nodeTrash.js";
import { disarmSiteRebuild as pauseRebuild } from "./helpers/siteRebuild.js";
import publishRouter from "../modules/website/routes.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { recordAttributeChange } from "../services/attributeChange.js";
import { moveToSpace } from "../services/spaces.js";
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { startFakeRenderer } from "./helpers/fakeRenderer.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { armSiteRebuild, disarmSiteRebuild } from "./helpers/siteRebuild.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishWithPreview } from "./helpers/publishWithPreview.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let renderer: Awaited<ReturnType<typeof startFakeRenderer>> | null = null;
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

let owner: ActorCtx = { id: "site-owner", name: "Owner", role: "admin", type: "human" };
let member: ActorCtx = { id: "site-member", name: "Member", role: "editor", type: "human" };
let pub = "";
let priv = "";

type SitePayload = { nodes?: Array<{ id: string }> };
const served = async () => (await loadServedSite(workspaceId)).payload as SitePayload;
const onSite = async (): Promise<string[]> => {
  return ((await served()).nodes ?? []).map((n) => n.id);
};
const publish = async () => { expect((await publishWithPreview((p, b) => send(p, "POST", b))).status).toBe(201); };
const lastEvent = async (type: string, target: string, key?: string) => (await q<{ id: string }>(
  `SELECT id::text FROM domain_events WHERE event_type = $1 AND target_id = $2 ${key ? "AND payload->>'key' = $3" : ""}
    ORDER BY domain_events.id DESC LIMIT 1`, key ? [type, target, key] : [type, target])).rows[0]!.id;

async function publishedNote(): Promise<string> {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,'body') RETURNING id::text`, [workspaceId, `Page ${randomUUID().slice(0, 6)}`, randomUUID()])).rows[0]!.id;
  await putInSpace(id, pub);
  expect((await send(`/api/nodes/${id}/attributes/_published`, "PUT", { value: "true", value_type: "bool" })).status).toBe(200);
  expect(await onSite()).not.toContain(id); // marked, not yet published
  await publish();
  expect(await onSite()).toContain(id);
  return id;
}

describe.skipIf(!isTestDb)("the published site drops what it should no longer show (DB)", () => {
  afterAll(async () => { await disarmSiteRebuild(); });
  beforeAll(async () => {
    armSiteRebuild(() => workspaceId); // rebuilds ride the outbox (site_rebuild)
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Site leaks',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    await setModulesOn(workspaceId, null);
    member = await persistActor(workspaceId, member);
    owner = await persistActor(workspaceId, owner); // the last human admin persisted is the owner
    currentActor = owner;
    pub = await makeSpace(workspaceId, `pub-${randomUUID()}`, [{ id: owner.id, role: "manager" }, { id: member.id, role: "editor" }],
      { publish: true, external_ai: false, backup: true });
    priv = await makeSpace(workspaceId, `priv-${randomUUID()}`, [{ id: owner.id, role: "manager" }], { publish: false, external_ai: false, backup: true });
    expect((await publishWithPreview((p, b) => send(p, "POST", b))).status).toBe(201);
    // The static export asks the frontend for each page; a stand-in answers.
    renderer = await startFakeRenderer(() => workspaceId);
  });
  afterAll(async () => { await renderer?.close(); });

  it("undoing 「發布」 from history brings 「不發布」 back and takes the page off", async () => {
    const page = await publishedNote();
    const flag = (value: string) => send(`/api/nodes/${page}/attributes/_published`, "PUT", { value, value_type: "bool" });
    expect((await flag("false")).status).toBe(200);
    expect((await flag("true")).status).toBe(200);
    await publish();
    expect(await onSite()).toContain(page);
    // Undone, the flag is 「不發布」 again (in a space that publishes, no flag would keep it on).
    expect(await restoreEvent(await lastEvent("ATTRIBUTE_SET", page, "_published"), { actor: owner, workspaceId }))
      .toMatchObject({ restored: true });
    await expect.poll(onSite, { timeout: 4000 }).not.toContain(page);
  });

  it("a note can't be hidden; one hidden before that is off the site, and showing it puts it back", async () => {
    const page = await publishedNote();
    expect((await send(`/api/nodes/${page}`, "PATCH", { hidden: true })).status).toBe(400); // only tags (D104)
    expect(await onSite()).toContain(page);
    await seedQ(`UPDATE content_nodes SET hidden = true WHERE id = $1`, [page]); // hidden before D104
    await expect.poll(onSite, { timeout: 5000 }).not.toContain(page);
    expect((await send(`/api/nodes/${page}`, "PATCH", { hidden: false })).status).toBe(200);
    await expect.poll(onSite, { timeout: 5000 }).toContain(page);
  });

  it("moving a published note out of a publishing space takes it off", async () => {
    const page = await publishedNote();
    const epoch = (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [workspaceId])).rows[0]!.e;
    await moveToSpace(owner, workspaceId, page, priv, epoch);
    await expect.poll(onSite, { timeout: 5000 }).not.toContain(page);
  });

  it("trashing a published note takes it off", async () => {
    const page = await publishedNote();
    await trashNode(owner, workspaceId, page);
    await expect.poll(onSite, { timeout: 5000 }).not.toContain(page);
  });

  it("the rebuild is recorded with the change, so a crash after commit cannot lose it", async () => {
    const page = await publishedNote();
    await pauseRebuild(); // as if the process died right after the commit
    try {
      expect((await send(`/api/nodes/${page}/attributes/_published`, "PUT", { value: "false", value_type: "bool" })).status).toBe(200);
      const intent = await q<{ status: string }>(
        `SELECT status FROM outbox WHERE dedup_key = $1 AND status = 'pending'`, [`site_rebuild:${workspaceId}`]);
      expect(intent.rows).toHaveLength(1); // committed with the unpublish, waiting for the reconciler
    } finally { armSiteRebuild(() => workspaceId); }
  });

  it("the static export is the owner's: another member gets 403", async () => {
    currentActor = member;
    try {
      expect((await app.request("/api/export-static")).status).toBe(403);
      expect((await send("/api/publish", "POST")).status).toBe(403);
    } finally { currentActor = owner; }
    const res = await app.request("/api/export-static");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
  });

  it("a module-owned reserved key is not undone on its own", async () => {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Feed',$2,'') RETURNING id::text`, [workspaceId, randomUUID()])).rows[0]!.id;
    await putInSpace(id, pub);
    await recordAttributeChange({
      workspaceId, nodeId: id, key: "_rss_url", actor: owner, next: { value: "https://feed.test/x.xml", source: "ui" },
      rule: "always", authority: { kind: "node", nodeId: id, op: "write_node" }, uiContext: "test.module_key",
    });
    expect(await restoreEvent(await lastEvent("ATTRIBUTE_SET", id, "_rss_url"), { actor: owner, workspaceId }))
      .toMatchObject({ code: "unsupported", status: 422 });
    expect((await q(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_rss_url'`, [id])).rows).toHaveLength(1);
  });
});
