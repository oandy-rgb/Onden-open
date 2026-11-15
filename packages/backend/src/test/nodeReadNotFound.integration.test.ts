// Real PostgreSQL: GET /api/nodes/:id answers an unreadable node exactly like
// a missing one. It used to answer 403 for a live restricted node and 404 for
// a missing id, so any reader could test whether an id exists.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let viewer: ActorCtx = { id: "nf-viewer", name: "Viewer", role: "viewer", type: "human" };

async function get(id: string) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", viewer); await next(); });
  app.route("/api/nodes", nodesRouter);
  const res = await app.request(`/api/nodes/${id}`);
  return { status: res.status, body: await res.json() as unknown };
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("single node read without an existence oracle", () => {
  let secret = "";
  beforeAll(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Oracle',$1) RETURNING id", [randomUUID()])).rows[0].id;
    viewer = await persistActor(ws, viewer);
    const hiddenSpace = await adminOnlySpace(ws, "hidden", []);
    secret = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug,markdown) VALUES($1,'manual','content','Secret',$2,'b') RETURNING id`,
      [ws, randomUUID()])).rows[0].id;
    await putInSpace(secret, hiddenSpace);
  });

  it("an unreadable live node and a missing id get the same answer", async () => {
    const hidden = await get(secret);
    const missing = await get(randomUUID());
    expect(hidden).toEqual(missing);
    expect(hidden.status).toBe(404);
  });
});
