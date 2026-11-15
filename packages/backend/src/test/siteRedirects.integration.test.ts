// GAP-240 end to end against a real Postgres: publish, rename, publish again —
// the old address reaches the note; taken down, neither address names it.
// The pure rules are in siteRedirects.test.ts.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, pool, q, withTransaction } from "../db.js";
import { buildAndEnqueueSnapshot } from "../modules/website/publishing/snapshot.js";
import { forgetNodesInSnapshots } from "../services/purgedContent.js";
import nodeRouter from "../routes/nodes.js";
import publishRouter from "../modules/website/routes.js";
import type { ActorCtx } from "../types.js";
import { joinDefaultSpace, publishDefaultSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodeRouter);
app.route("/api", publishRouter);

const J = { "content-type": "application/json" };
const publish = async () => { await buildAndEnqueueSnapshot(await getWorkspaceId(), { id: currentActor!.id, type: "human" }, { title: "Garden" }); };
let defaultSpaceId = "";
const createNote = async (title: string) => {
  const res = await app.request("/api/nodes", { method: "POST", headers: J, body: JSON.stringify({ title, markdown: "body", space_id: defaultSpaceId }) });
  expect(res.status, `create "${title}"`).toBe(201);
  return (await res.json()) as { id: string; slug: string };
};
const rename = async (id: string, title: string) => {
  expect((await app.request(`/api/nodes/${id}`, { method: "PATCH", headers: J, body: JSON.stringify({ title }) })).status).toBe(200);
};
const setPublished = (id: string) => app.request(`/api/nodes/${id}/attributes/_published`, {
  method: "PUT", headers: J, body: JSON.stringify({ value: "true", value_type: "text", is_inheritable: false }),
});
type Served = { payload: { nodes: Array<{ id: string; slug: string }>; site_redirects?: Array<{ from: string; to: string }>; redirects?: unknown } };
const served = async (): Promise<Served> => {
  const res = await app.request("/api/site");
  expect(res.status).toBe(200);
  return (await res.json()) as Served;
};

describe.skipIf(!isTestDb)("old site addresses after a rename (GAP-240, DB)", () => {
  let workspaceId = "";

  beforeAll(async () => {
    workspaceId = ownWorkspace = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Redirect test', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    await publishDefaultSpace(ownWorkspace);
    const actor = (await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'Author', 'human') RETURNING id`, [workspaceId])).rows[0]!.id;
    currentActor = { id: actor, name: "Author", role: "admin", type: "human" };
    await joinDefaultSpace(workspaceId, actor, "admin");
    defaultSpaceId = (await q<{ id: string }>(
      `SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
  });

  afterAll(async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [workspaceId]);
    await q(`DELETE FROM publish_snapshots WHERE workspace_id = $1`, [workspaceId]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [workspaceId]);
    await pool.end();
  });

  it("a renamed note's old address goes to its new one, through later publishes, and is gone once it is taken down", async () => {
    const stamp = randomUUID().slice(0, 6);
    const note = await createNote(`Plan ${stamp}`);
    expect((await setPublished(note.id)).status).toBe(200);
    await publish();
    const first = (await served()).payload.nodes.find((n) => n.id === note.id)!.slug;
    expect(first).toBe(`plan-${stamp}`);

    await rename(note.id, `Roadmap ${stamp}`);
    // Not published yet: the site still serves the old address as the page.
    expect((await served()).payload.site_redirects ?? []).toEqual([]);
    await publish();
    let site = await served();
    expect(site.payload.nodes.find((n) => n.id === note.id)!.slug).toBe(`roadmap-${stamp}`);
    expect(site.payload.site_redirects).toEqual([{ from: `/site/plan-${stamp}/`, to: `/site/roadmap-${stamp}/` }]);
    expect(site.payload.redirects, "the stored pairs never leave the server").toBeUndefined();

    // A later publish with nothing renamed carries the redirect on.
    await publish();
    expect((await served()).payload.site_redirects).toEqual([{ from: `/site/plan-${stamp}/`, to: `/site/roadmap-${stamp}/` }]);

    // Taken down (「不發布」): the old address names nothing (no redirect to the title-bearing new one).
    expect((await app.request(`/api/nodes/${note.id}/attributes/_published`, {
      method: "PUT", headers: J, body: JSON.stringify({ value: "false", value_type: "text", is_inheritable: false }),
    })).status).toBe(200);
    site = await served();
    expect(site.payload.nodes.some((n) => n.id === note.id)).toBe(false);
    expect(JSON.stringify(site.payload)).not.toContain(`roadmap-${stamp}`);

    // The next Publish (without it) does not name it at all, so published again
    // later it starts from its current address: the old ones are gone for good.
    await publish();
    expect(JSON.stringify((await q<{ payload: unknown }>(
      `SELECT payload FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [workspaceId])).rows[0]!.payload)).not.toContain(note.id);
    expect((await setPublished(note.id)).status).toBe(200);
    await publish();
    expect((await served()).payload.site_redirects ?? []).toEqual([]);
  });

  it("a new note that takes an old address gets the page, not the redirect", async () => {
    const stamp = randomUUID().slice(0, 6);
    const a = await createNote(`Alpha ${stamp}`);
    expect((await setPublished(a.id)).status).toBe(200);
    await publish();
    await rename(a.id, `Beta ${stamp}`);
    await publish();
    const b = await createNote(`Alpha ${stamp}`);
    expect((await setPublished(b.id)).status).toBe(200);
    await publish();
    const site = await served();
    expect(site.payload.nodes.find((n) => n.id === b.id)!.slug).toBe(`alpha-${stamp}`);
    expect((site.payload.site_redirects ?? []).some((r) => r.from === `/site/alpha-${stamp}/`)).toBe(false);
  });

  it("purging a note removes its old addresses from every stored snapshot", async () => {
    const stamp = randomUUID().slice(0, 6);
    const note = await createNote(`Secret ${stamp}`);
    expect((await setPublished(note.id)).status).toBe(200);
    await publish();
    await rename(note.id, `Public ${stamp}`);
    await publish();
    await withTransaction(() => forgetNodesInSnapshots(workspaceId, [note.id]));
    const left = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM publish_snapshots WHERE workspace_id = $1 AND payload::text LIKE $2`,
      [workspaceId, `%secret-${stamp}%`],
    );
    expect(left.rows[0]!.n).toBe("0");
  });
});
