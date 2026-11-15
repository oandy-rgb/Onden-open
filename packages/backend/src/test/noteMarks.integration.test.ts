import { persistActor } from "./helpers/persistActor.js";
// The note menu's 釘選 and 顏色 (unification audit R6): `_pinned` and
// `_color` were rejected as reserved keys by both PUT and DELETE, so the
// menu silently did nothing. They are now writable — with checked values —
// and every other `_` key stays reserved, on both routes.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
registerShippedModules();

const admin: ActorCtx = { id: "admin-1", name: "Admin", role: "admin", type: "human" };
const put = (id: string, key: string, value: string, value_type = "text") =>
  app.request(`/api/nodes/${id}/attributes/${key}`, {
    method: "PUT", body: JSON.stringify({ value, value_type }), headers: { "Content-Type": "application/json" },
  });
const del = (id: string, key: string) => app.request(`/api/nodes/${id}/attributes/${key}`, { method: "DELETE" });
const valueOf = async (id: string, key: string) =>
  (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [id, key])).rows[0]?.value ?? null;

let WS = "";
describe.skipIf(!isTestDb)("note pin and colour attributes (DB)", () => {
  let node = "";
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default')
             ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
    node = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Marked','marked-${Date.now()}','body') RETURNING id`,
      [WS],
    )).rows[0]!.id;
    currentActor = admin;
  });

  it("pins and unpins a note", async () => {
    expect((await put(node, "_pinned", "true", "bool")).status).toBe(200);
    expect(await valueOf(node, "_pinned")).toBe("true");
    expect((await del(node, "_pinned")).status).toBe(200);
    expect(await valueOf(node, "_pinned")).toBeNull();
  });

  it("sets and clears a colour, and only accepts a #rrggbb swatch", async () => {
    expect((await put(node, "_color", "#ef4444")).status).toBe(200);
    expect(await valueOf(node, "_color")).toBe("#ef4444");
    expect((await put(node, "_color", "red; background:url(x)")).status).toBe(400);
    expect((await put(node, "_pinned", "yes")).status).toBe(400);
    // "false" is accepted for a flag (older clients unpublish that way).
    expect((await put(node, "_pinned", "false", "bool")).status).toBe(200);
    expect(await valueOf(node, "_color")).toBe("#ef4444");
    expect((await del(node, "_color")).status).toBe(200);
    expect(await valueOf(node, "_color")).toBeNull();
  });

  it("keeps every other `_` key reserved on both routes", async () => {
    expect((await put(node, "_status", "x")).status).toBe(400);
    expect((await del(node, "_status")).status).toBe(400);
  });
});
