// Security audit 2026-06-12 #1: saved-view exec leaked read-restricted nodes
// (titles/slugs/attributes) to callers who could not read them — executeView
// had no read bound. Pinned here: the SAME view returns a node in an
// admin-only space to the admin and HIDES it from an editor, on both the route and the shape
// the agent tool shares (executeView).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { q, getWorkspaceId } from "../db.js";
import type { ActorCtx } from "../types.js";
import tagsRouter from "../routes/tags.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { seedView } from "./helpers/seedView.js";
import { adminOnlySpace, joinDefaultSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/tags", tagsRouter);

describe.skipIf(!isTestDb)("saved-view read policy (audit #1)", () => {
  const STAMP = Date.now();
  let WS = "", viewTagId = "", viewId = "", openId = "", restrictedId = "";
  let adminId = "", editorId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    adminId = (await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type) VALUES ($1,$2,'human') RETURNING id`,
      [WS, `vrp admin ${STAMP}`])).rows[0]!.id;
    // The view's reader who sees the owner-only space is the workspace owner.
    await setWorkspaceOwner(WS, adminId);
    editorId = (await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type) VALUES ($1,$2,'human') RETURNING id`,
      [WS, `vrp editor ${STAMP}`])).rows[0]!.id;

    // membership is explicit since 097: both read 共用 (where the open note lives)
    await joinDefaultSpace(WS, adminId, "admin");
    await joinDefaultSpace(WS, editorId, "editor");

    // the view's tag (no policy) + a saved view on it
    viewTagId = (await seedClassTag(WS, {
      name: "VRP",
      slug: `vrp-${STAMP}`,
      title: `vrp-tag-${STAMP}`,
      nodeSlug: `vrp-tag-${STAMP}`,
    })).tagId;
    viewId = await seedView(viewTagId, { name: "All", layout: "list" });

    // two members of the VIEW tag; one lives in an admin-only space
    openId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'open body') RETURNING id`,
      [WS, `vrp open ${STAMP}`, `vrp-open-${STAMP}`])).rows[0]!.id;
    restrictedId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'SECRET body') RETURNING id`,
      [WS, `vrp secret note ${STAMP}`, `vrp-secret-note-${STAMP}`])).rows[0]!.id;
    for (const n of [openId, restrictedId]) {
      await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [n, viewTagId]);
    }
    await putInSpace(restrictedId, await adminOnlySpace(WS, `vrp-secret-${STAMP}`, [adminId]));
  });

  async function execAs(actor: ActorCtx): Promise<string[]> {
    currentActor = actor;
    const res = await app.request(`/api/tags/${viewTagId}/views/${viewId}/exec`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    return body.rows.map((r) => r.id);
  }

  it("admin sees both members; editor never receives the read-restricted node", async () => {
    const adminRows = await execAs({ id: adminId, name: "A", role: "admin", type: "human" });
    expect(adminRows).toContain(openId);
    expect(adminRows).toContain(restrictedId);

    const editorRows = await execAs({ id: editorId, name: "E", role: "editor", type: "human" });
    expect(editorRows).toContain(openId);
    expect(editorRows).not.toContain(restrictedId); // the leak (audit #1)
  });

  it("unauthenticated exec is refused", async () => {
    currentActor = null;
    const res = await app.request(`/api/tags/${viewTagId}/views/${viewId}/exec`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
