// Real PostgreSQL: a node's slug is chosen under the event lock. Picking it
// before the lock let two creates with the same title pick the same slug, and
// the second one failed on the unique index.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import bookmarkRouter from "../routes/bookmark.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let editor: ActorCtx = { id: "slug-editor", name: "Editor", role: "editor", type: "human" };

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("slug choice under the event lock", () => {
  beforeAll(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Slugs',$1) RETURNING id", [randomUUID()])).rows[0].id;
    editor = await persistActor(ws, editor);
  });

  it("concurrent bookmarks with the same title all succeed with distinct slugs", async () => {
    const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
    app.onError(apiOnError);
    app.use("*", async (c, next) => { c.set("actor", editor); await next(); });
    app.route("/api/bookmark", bookmarkRouter);
    // An unresolvable host: the fetch fails and every title is the hostname.
    const url = `http://same-title-${Date.now()}.invalid/`;
    const statuses = await Promise.all(Array.from({ length: 6 }, async () =>
      (await app.request("/api/bookmark", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) })).status));
    expect(statuses.every((s) => s === 201 || s === 200)).toBe(true);
    const slugs = (await db.q<{ slug: string }>(
      `SELECT slug FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content'`, [ws])).rows.map((r) => r.slug);
    expect(slugs).toHaveLength(6);
    expect(new Set(slugs).size).toBe(6);
  });
});
