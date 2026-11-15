// T3: the bootstrap payload's `tags` IS the tag catalog GET /api/tags returns
// (services/tagCatalog.ts readTagCatalog), for the same actor. The client
// replaces its offline catalog with the bootstrap list on every refresh, so a
// thinner bootstrap copy (it once lacked parent_id, reserved_key, usage_count,
// schema_slug, views, description…) made every tag a root offline and lost
// child tags from module/base membership.
//
// Real actor row, spaces and tags; only the authenticated identity is injected.
// SAFETY: only runs against a *_test database; skips otherwise.
import { giveFunction } from "./helpers/seedClassTag.js";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { reservedTagFixture } from "./helpers/reservedTag.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

let ws = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
const { default: tagsRouter } = await import("../routes/tags.js");
const { default: bootstrapRouter } = await import("../routes/bootstrap.js");

function appFor(actor: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/tags", tagsRouter);
  app.route("/api/bootstrap", bootstrapRouter);
  return app;
}

type CatalogTag = { id: string; name: string; parent_id: string | null; reserved_key: string | null; usage_count: number;
  schema_slug: string | null; schema_views: unknown; schema_description: string | null; effective_modules: string[] };

describe.skipIf(!isTestDatabase())("bootstrap tags = GET /api/tags (T3)", () => {
  let viewer: ActorCtx;
  let parentTag = "", childTag = "", reservedTag = "";

  async function tagNode(title: string, parentId: string | null, schema: unknown): Promise<string> {
    return (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, tag_schema)
       VALUES ($1,'manual','class_tag',$2,$3,'about the tag',$4,$5) RETURNING id::text`,
      [ws, title, `t3-${randomUUID().slice(0, 8)}`, parentId, schema === null ? null : JSON.stringify(schema)])).rows[0]!.id;
  }
  async function taggedNote(spaceId: string, tagIds: string[]): Promise<void> {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
       VALUES ($1,'manual','content','note',$2,'x',$3) RETURNING id::text`,
      [ws, `t3-note-${randomUUID().slice(0, 8)}`, spaceId])).rows[0]!.id;
    for (const tagId of tagIds) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [id, tagId]);
  }

  beforeAll(async () => {
    ws = (await db.q<{ id: string }>(
      "INSERT INTO workspaces (name, slug) VALUES ('T3 tag catalog', $1) RETURNING id::text", [randomUUID()])).rows[0]!.id;
    const owner = await persistActor(ws, { id: "", name: "Owner", role: "admin", type: "human" });
    viewer = await persistActor(ws, { id: "", name: "Viewer", role: "viewer", type: "human" });
    const defaultSpace = (await db.q<{ id: string }>(
      "SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default", [ws])).rows[0]!.id;
    const ownerOnly = await makeSpace(ws, `t3-owner-only-${randomUUID()}`, [{ id: owner.id, role: "manager" }]);

    parentTag = await tagNode("課程", null, {
      slug: "course", description: "A course", version: "1",
      fields: [{ name: "term", type: "text" }],
      views: [{ id: "v1", name: "Table", type: "table" }],
      module: "review",
    });
    childTag = await tagNode("作業", parentTag, { extends: [parentTag] });
    // What migration 166 makes of the module tag and of the tag extending it.
    await giveFunction(ws, parentTag, "review");
    await giveFunction(ws, childTag, "review", parentTag);
    reservedTag = await reservedTagFixture(ws, "page");

    // usage_count counts only notes the actor can read: one visible note per
    // tag, plus one the viewer cannot read (an owner-only space).
    await taggedNote(defaultSpace, [childTag, parentTag]);
    await taggedNote(ownerOnly, [childTag]);

    // A workspace's first bootstrap creates its Site Config note (and the
    // #workspace-config tag) after its read snapshot, so that payload predates
    // the tag (bootstrap.ts buildBootstrap). Start from a workspace that has it.
    expect((await appFor(owner).request("/api/bootstrap?bodies=none")).status).toBe(200);
  });

  it("deep-equals the catalog, child and reserved tags included", async () => {
    const app = appFor(viewer);
    const catalogRes = await app.request("/api/tags");
    expect(catalogRes.status).toBe(200);
    const catalog = await catalogRes.json() as CatalogTag[];

    for (const path of ["/api/bootstrap", "/api/bootstrap?bodies=none"]) {
      const bootRes = await app.request(path);
      expect(bootRes.status).toBe(200);
      const boot = await bootRes.json() as { tags: CatalogTag[] };
      expect(boot.tags).toEqual(catalog);
    }

    // The fixtures are really there, with the fields the thin copy lacked.
    const byId = new Map(catalog.map((tag) => [tag.id, tag]));
    expect(byId.get(childTag)).toMatchObject({ parent_id: parentTag, usage_count: 1, effective_modules: ["review"] });
    expect(byId.get(parentTag)).toMatchObject({
      parent_id: null, usage_count: 1, schema_slug: "course", schema_description: "A course",
      schema_views: [{ id: "v1", name: "Table", type: "table" }],
    });
    expect(byId.get(reservedTag)).toMatchObject({ reserved_key: "page" });
    expect(Object.keys(byId.get(parentTag)!)).not.toContain("required_role");
  });
});
