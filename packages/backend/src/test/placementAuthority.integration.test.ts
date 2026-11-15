// Real PostgreSQL. Two tightened rules:
//   • placing a note under a parent (create, move) needs the parent readable AND
//     writable for the current actor — an unreadable parent stays a 404;
//   • a tag's schema is owner-only (PATCH /api/tags/:id/schema).
// (Spaces model: a parent is unwritable when the actor is only a viewer of its
// space, unreadable when they are not a member. The matter-scope saved-view
// case was removed with matter scope.)
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import tagsRouter from "../routes/tags.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let owner: ActorCtx = { id: "pl-owner", name: "Owner", role: "admin", type: "human" };
let editor: ActorCtx = { id: "pl-editor", name: "Editor", role: "editor", type: "human" };

function call(actor: ActorCtx, method: string, path: string, body?: unknown) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/nodes", nodesRouter);
  app.route("/api/tags", tagsRouter);
  return app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function note(title: string, spaceId?: string): Promise<string> {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug,markdown) VALUES($1,'manual','content',$2,$3,'') RETURNING id`,
    [ws, title, randomUUID()])).rows[0].id;
  if (spaceId) await putInSpace(id, spaceId);
  return id;
}
async function exists(title: string): Promise<boolean> {
  return (await db.q("SELECT 1 FROM content_nodes WHERE workspace_id=$1 AND title=$2", [ws, title])).rows.length > 0;
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("placement and tag-schema authority", () => {
  let readOnlyParent: string, hiddenParent: string, openParent: string, plainTag: string;

  beforeAll(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Placement',$1) RETURNING id", [randomUUID()])).rows[0].id;
    owner = await persistActor(ws, owner);
    editor = await persistActor(ws, editor);
    // The editor only views this space, and is not in the owner-only one.
    const ownerWrites = await makeSpace(ws, `owner-writes-${randomUUID()}`, [{ id: owner.id, role: "manager" }, { id: editor.id, role: "viewer" }]);
    const ownerOnly = await adminOnlySpace(ws, `owner-reads-${randomUUID()}`, [owner.id]);
    plainTag = (await seedClassTag(ws, { name: `plain-${randomUUID()}` })).tagId;
    readOnlyParent = await note("read-only parent", ownerWrites);
    hiddenParent = await note("hidden parent", ownerOnly);
    openParent = await note("open parent");
  });
  afterAll(async () => { await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]); });

  it("creating under a readable but unwritable parent is refused, and nothing is created", async () => {
    const title = `child-${randomUUID()}`;
    const res = await call(editor, "POST", "/api/nodes", { title, parent_id: readOnlyParent });
    expect(res.status).toBe(403);
    expect(await exists(title)).toBe(false);
  });

  it("an unreadable parent stays indistinguishable from a missing one", async () => {
    const hidden = await call(editor, "POST", "/api/nodes", { title: `x-${randomUUID()}`, parent_id: hiddenParent });
    const missing = await call(editor, "POST", "/api/nodes", { title: `y-${randomUUID()}`, parent_id: randomUUID() });
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it("creating under a writable parent still works", async () => {
    const res = await call(editor, "POST", "/api/nodes", { title: `ok-${randomUUID()}`, parent_id: openParent });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { parent_id: string }).parent_id).toBe(openParent);
  });

  it("moving a note under a readable but unwritable parent is refused", async () => {
    const child = await note(`movable-${randomUUID()}`);
    const res = await call(editor, "PATCH", `/api/nodes/${child}`, { parent_id: readOnlyParent });
    expect(res.status).toBe(403);
    const row = await db.q<{ parent_id: string | null }>("SELECT parent_id FROM content_nodes WHERE id=$1", [child]);
    expect(row.rows[0].parent_id).toBeNull();
  });

  it("only the owner may change a tag schema", async () => {
    const byEditor = await call(editor, "PATCH", `/api/tags/${plainTag}/schema`, { fields: [] });
    expect(byEditor.status).toBe(403);
    const byOwner = await call(owner, "PATCH", `/api/tags/${plainTag}/schema`, { fields: [] });
    expect(byOwner.status).toBe(200);
  });
});
