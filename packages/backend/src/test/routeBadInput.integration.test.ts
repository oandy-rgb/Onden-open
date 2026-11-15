// A malformed id or body is a 400 and never runs the operation (routes/params.ts):
// not a 500 from Postgres, not a body swallowed into `{}` that then ran with defaults.
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import { persistActor } from "./helpers/persistActor.js";
import nodesRouter from "../routes/nodes.js";
import syncRouter from "../routes/sync.js";
import rssRouter from "../modules/rss/routes.js";
import tasksRouter from "../modules/tasks/routes.js";
import type { ActorCtx } from "../types.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const admin: ActorCtx = { id: "bad-input-admin", name: "Admin", role: "admin", type: "human" };
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", admin); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api/sync", syncRouter);
app.route("/api/rss", rssRouter);
app.route("/api/tasks", tasksRouter);

const J = { "content-type": "application/json" };
const NOT_A_UUID = "not-a-uuid";
const SOME_UUID = "00000000-0000-4000-8000-000000000001";

describe.skipIf(!isTestDb)("routes answer malformed input with a 400 (DB)", () => {
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    Object.assign(admin, await persistActor(await getWorkspaceId(), admin));
  });

  it("duplicate: a broken body does not become a copy with a server-made id", async () => {
    const before = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes`)).rows[0].n;
    const res = await app.request(`/api/nodes/${SOME_UUID}/duplicate`, { method: "POST", headers: J, body: '{"id": "' });
    expect(res.status).toBe(400);
    const after = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes`)).rows[0].n;
    expect(after).toBe(before);
  });

  it("duplicate: a source id that is not a uuid is a 400", async () => {
    const res = await app.request(`/api/nodes/${NOT_A_UUID}/duplicate`, { method: "POST", headers: J, body: "{}" });
    expect(res.status).toBe(400);
  });

  it("update: a markdown_patch that is not a patch is refused and the note keeps its text", async () => {
    const made = await app.request("/api/nodes", { method: "POST", headers: J, body: JSON.stringify({ title: "patched", markdown: "keep me" }) });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const res = await app.request(`/api/nodes/${id}`, { method: "PATCH", headers: J, body: JSON.stringify({ markdown_patch: "oops" }) });
    expect(res.status).toBe(400);
    const stored = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0];
    expect(stored.markdown).toBe("keep me");
  });

  for (const path of ["/api/sync/nodes", "/api/sync/bodies", "/api/sync/drawings"]) {
    it(`${path}: ids that are not uuids are a 400`, async () => {
      const res = await app.request(path, { method: "POST", headers: J, body: JSON.stringify({ ids: [NOT_A_UUID] }) });
      expect(res.status).toBe(400);
    });
    it(`${path}: a broken body is a 400, not "no ids"`, async () => {
      const res = await app.request(path, { method: "POST", headers: J, body: '{"ids": [' });
      expect(res.status).toBe(400);
    });
  }

  it("sync: a broken body is a 400, not a delta from the start", async () => {
    const res = await app.request("/api/sync", { method: "POST", headers: J, body: '{"since": ' });
    expect(res.status).toBe(400);
  });

  it("sync/nodes: an empty body still means no ids", async () => {
    const res = await app.request("/api/sync/nodes", { method: "POST", headers: J });
    expect(res.status).toBe(200);
  });

  // Each carries a body that is valid for its route, so the bad id is the only thing wrong.
  for (const [method, path, body] of [
    ["GET", `/api/rss/items/${NOT_A_UUID}`, undefined],
    ["POST", `/api/rss/items/${NOT_A_UUID}/seen`, "{}"],
    ["POST", `/api/rss/items/${NOT_A_UUID}/save`, "{}"],
    ["POST", `/api/rss/items/${NOT_A_UUID}/fulltext`, "{}"],
    ["PATCH", `/api/rss/sources/${NOT_A_UUID}`, '{"always_fulltext":true}'],
    ["POST", `/api/rss/sources/${NOT_A_UUID}/refresh`, undefined],
    ["POST", `/api/rss/sources/${NOT_A_UUID}/unsubscribe`, undefined],
    ["PATCH", `/api/tasks/${NOT_A_UUID}`, '{"title":"a real change"}'],
    ["POST", `/api/tasks/focus/${NOT_A_UUID}/end`, "{}"],
    ["PATCH", `/api/tasks/focus/${NOT_A_UUID}`, '{"note":"a real change"}'],
    ["POST", `/api/tasks/${NOT_A_UUID}/place`, JSON.stringify({ note_id: SOME_UUID })],
    ["POST", `/api/tasks/${NOT_A_UUID}/unplace`, undefined],
  ] as const) {
    it(`${method} ${path}: an id that is not a uuid is a 400`, async () => {
      const res = await app.request(path, { method, headers: J, body });
      expect(res.status).toBe(400);
    });
  }

  // Unchanged behaviour (these were already 400 before the shared readers): kept so the shared
  // reader cannot loosen them.
  describe("kept as they were", () => {
    it("update: a broken body is a 400", async () => {
      const res = await app.request(`/api/nodes/${SOME_UUID}`, { method: "PATCH", headers: J, body: '{"title":' });
      expect(res.status).toBe(400);
    });

    it("tasks: a broken body is a 400", async () => {
      const res = await app.request("/api/tasks", { method: "POST", headers: J, body: '{"title":' });
      expect(res.status).toBe(400);
    });
  });
});
