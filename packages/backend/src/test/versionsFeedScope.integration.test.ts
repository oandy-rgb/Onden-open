// Real PostgreSQL: the recent-versions feed applies read policy before its
// LIMIT. Filtering a fetched page in JS let newer restricted versions use up the
// page, so a reader got a short or empty list while readable versions existed.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import versionsRouter from "../routes/versions.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";
import { seedVersion } from "./helpers/versionFixtures.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let admin: ActorCtx = { id: "vf-admin", name: "Admin", role: "admin", type: "human" };
let viewer: ActorCtx = { id: "vf-viewer", name: "Viewer", role: "viewer", type: "human" };

async function feed(actor: ActorCtx, limit: number): Promise<Array<{ node_id: string }>> {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/versions", versionsRouter);
  const res = await app.request(`/api/versions/recent?limit=${limit}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { rows: Array<{ node_id: string }> }).rows;
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("recent versions feed scope", () => {
  const open: string[] = [];
  const restricted: string[] = [];
  beforeAll(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Versions',$1) RETURNING id", [randomUUID()])).rows[0].id;
    admin = await persistActor(ws, admin);
    viewer = await persistActor(ws, viewer);
    const secret = await adminOnlySpace(ws, "secret", [admin.id]);
    const note = async (space?: string) => {
      const id = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug,markdown) VALUES($1,'manual','content',$2,$3,'b') RETURNING id`,
        [ws, `n-${randomUUID()}`, randomUUID()])).rows[0].id;
      if (space) await putInSpace(id, space);
      return id;
    };
    // Older readable versions, then a newer wall of restricted ones.
    for (let i = 0; i < 3; i++) open.push(await note());
    for (let i = 0; i < 8; i++) restricted.push(await note(secret));
    for (const id of [...open, ...restricted]) {
      await db.event(ws, "NODE_UPDATED", "node", id, { body_hash: "h" }, "user", admin.id);
      await seedVersion({ ws, noteId: id, title: "n", markdown: `text of ${id}` }); // History reads versions
    }
  });
  afterAll(async () => { await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]); });

  it("fills a reader's page with readable versions behind newer restricted ones", async () => {
    const rows = await feed(viewer, 5);
    expect(rows.map((r) => r.node_id).sort()).toEqual([...open].sort());
  });

  it("still lists everything for a reader who may see it", async () => {
    const rows = await feed(admin, 20);
    expect(rows).toHaveLength(11);
  });
});
