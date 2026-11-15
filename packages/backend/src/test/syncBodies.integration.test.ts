// POST /sync/bodies — background download of note bodies into a large
// workspace's local database (offline copy). It is a node read: read policy,
// deletion and task exclusion apply exactly like every other node endpoint.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";

// This router harness injects identity; database snapshot/policy remain real.
vi.mock("../services/actorReadSnapshot.js", () => import("./helpers/injectedActorReadSnapshot.js"));
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import syncRouter from "../routes/sync.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let WS = "";
// The default workspace accumulates other suites' fixtures. With two ids per
// page the 100-page guard silently truncated that unrelated dataset. Keep this
// policy/pagination scenario isolated, including the router's workspace lookup.
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/sync", syncRouter);

let admin: ActorCtx = { id: "sb-admin", name: "Admin", role: "admin", type: "human" };
let viewer: ActorCtx = { id: "sb-viewer", name: "Viewer", role: "viewer", type: "human" };

async function bodies(ids: unknown): Promise<{ status: number; rows: Array<{ id: string; markdown: string }> }> {
  const res = await app.request("/api/sync/bodies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
  return { status: res.status, rows: res.status === 200 ? ((await res.json()) as { bodies: Array<{ id: string; markdown: string }> }).bodies : [] };
}

describe.skipIf(!isTestDb)("POST /sync/bodies (DB)", () => {
  const stamp = Date.now();
  let openId = "", restrictedId = "", deletedId = "";
  const mkNode = async (title: string, markdown: string): Promise<string> =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,$4) RETURNING id`, [WS, title, `${title}-${randomUUID()}`, markdown])).rows[0]!.id;

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Sync bodies',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    // Persisted actors join the workspace's default space (spaces model).
    admin = await persistActor(WS, admin);
    viewer = await persistActor(WS, viewer);
    openId = await mkNode(`sb open ${stamp}`, "open body");
    deletedId = await mkNode(`sb deleted ${stamp}`, "gone body");
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [deletedId]);
    // Restricted = in an admin-only space the viewer is not a member of.
    const secretSpace = await adminOnlySpace(WS, `sb-r-${stamp}`, [admin.id]);
    restrictedId = await mkNode(`sb restricted ${stamp}`, "secret body");
    await putInSpace(restrictedId, secretSpace);
  });

  it("returns readable bodies only: a viewer never receives a restricted or deleted note", async () => {
    currentActor = viewer;
    const { status, rows } = await bodies([openId, restrictedId, deletedId]);
    expect(status).toBe(200);
    expect(rows.map((r) => [r.id, r.markdown])).toEqual([[openId, "open body"]]);
  });

  it("an admin receives the restricted body too", async () => {
    currentActor = admin;
    const { rows } = await bodies([openId, restrictedId]);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([openId, restrictedId]));
  });

  it("rejects an oversized batch and malformed ids (400, never a cast 500)", async () => {
    currentActor = admin;
    expect((await bodies(Array.from({ length: 201 }, () => randomUUID()))).status).toBe(413);
    expect((await bodies(["not-a-uuid", 7])).status).toBe(400);
    expect((await bodies(["-".repeat(36)])).status).toBe(400);
    expect((await bodies("nope")).status).toBe(400);
    expect((await bodies([])).status).toBe(200);
  });
});
