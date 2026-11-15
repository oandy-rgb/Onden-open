// The workspace owner and global tag definitions (docs/architecture/spaces.md,
// docs/archive/research/integration-audit-2026-10-13.md section 4 items 2 and 4):
//   * one owner (workspaces.owner_actor_id) administers the workspace; no other
//     member does (there is no second admin);
//   * every member may apply a tag to a note they can write, but only the owner
//     changes the tag definition itself, and nobody deletes the reserved
//     workspace-config tag or the Site Config node;
//   * a pointer is content placed under its parent: adding or removing one
//     needs write in the parent's space;
//   * content cannot be nested under a tag by a member.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import pointersRouter from "../routes/pointers.js";
import actorsRouter from "../routes/actors.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { seedQ } from "./helpers/seedQ.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodeRouter);
app.route("/api/pointers", pointersRouter);
app.route("/api/actors", actorsRouter);

const send = (as: ActorCtx, method: string, path: string, body?: unknown) => {
  currentActor = as;
  return app.request(path, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

describe.skipIf(!isTestDb)("workspace owner and tag definitions", () => {
  let ws = "";
  let defaultSpace = "";
  const stamp = Date.now();
  const owner: ActorCtx = { id: "", name: "Owner", role: "admin", type: "human" };
  const otherMember: ActorCtx = { id: "", name: "Other member", role: "editor", type: "human" };
  const member: ActorCtx = { id: "", name: "Member", role: "editor", type: "human" };
  const viewer: ActorCtx = { id: "", name: "Viewer", role: "viewer", type: "human" };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    Object.assign(otherMember, await persistActor(ws, otherMember));
    Object.assign(member, await persistActor(ws, member));
    Object.assign(viewer, await persistActor(ws, viewer));
    // Persisted last: the admin shorthand makes this actor the workspace owner.
    Object.assign(owner, await persistActor(ws, owner));
    defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
  });

  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND (title LIKE $2 OR title LIKE $3)`, [ws, `%${stamp}%`, "OTD %"]);
    await pool.end();
  });

  it("only the owner administers members; another member cannot", async () => {
    expect((await send(otherMember, "POST", "/api/actors", { name: `OTD bot ${stamp}`, type: "agent" })).status).toBe(403);
    expect((await send(owner, "POST", "/api/actors", { name: `OTD bot ${stamp}`, type: "agent" })).status).toBe(201);
  });

  it("a member tags their own note but cannot rename, delete or nest under the tag; the owner can rename", async () => {
    const { tagId } = await seedClassTag(ws, { name: `otd-topic-${stamp}` });
    const note = await (await send(member, "POST", "/api/nodes", { title: `OTD note ${stamp}`, markdown: "" })).json() as { id: string };

    expect((await send(member, "PUT", `/api/nodes/${note.id}/tags/${tagId}`, {})).status).toBe(200);
    expect((await send(member, "PATCH", `/api/nodes/${tagId}`, { title: `renamed by member ${stamp}` })).status).toBe(403);
    expect((await send(member, "DELETE", `/api/nodes/${tagId}`)).status).toBe(403);
    expect((await send(member, "POST", "/api/nodes", { title: `OTD under tag ${stamp}`, markdown: "", parent_id: tagId })).status).toBe(403);
    expect((await q(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!.deleted_at).toBeNull();

    expect((await send(owner, "PATCH", `/api/nodes/${tagId}`, { title: `renamed by owner ${stamp}` })).status).toBe(200);
    expect((await send(member, "DELETE", `/api/nodes/${note.id}/tags/${tagId}`)).status).toBe(200);
  });

  it("nobody deletes the workspace-config tag or the Site Config node, not even the owner", async () => {
    const configNode = await ensureConfigNode(ws);
    const configTag = (await q<{ id: string }>(
      `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND title = 'workspace-config' AND deleted_at IS NULL`,
      [ws],
    )).rows[0]!.id;
    for (const id of [configNode, configTag]) {
      expect((await send(owner, "DELETE", `/api/nodes/${id}`)).status).toBe(403);
      expect((await q(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [id])).rows[0]!.deleted_at).toBeNull();
    }
  });

  it("a pointer needs write in its parent's space: a viewer cannot add one, a member removed from the space cannot delete one", async () => {
    const parent = await (await send(owner, "POST", "/api/nodes", { title: `OTD parent ${stamp}`, markdown: "", space_id: defaultSpace })).json() as { id: string };
    const target = await (await send(owner, "POST", "/api/nodes", { title: `OTD target ${stamp}`, markdown: "", space_id: defaultSpace })).json() as { id: string };

    expect((await send(viewer, "POST", "/api/pointers", { target_id: target.id, parent_id: parent.id })).status).toBe(403);
    const created = await send(member, "POST", "/api/pointers", { target_id: target.id, parent_id: parent.id });
    expect(created.status).toBe(201);
    const pointerId = ((await created.json()) as { id: string }).id;

    await q(`DELETE FROM space_members WHERE space_id = $1 AND actor_id = $2::uuid`, [defaultSpace, member.id]);
    try {
      expect((await send(member, "DELETE", `/api/pointers/${pointerId}`)).status).toBe(403);
      expect((await send(owner, "DELETE", `/api/pointers/${pointerId}`)).status).toBe(200);
    } finally {
      await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'edit') ON CONFLICT DO NOTHING`, [defaultSpace, member.id]);
    }
  });
});
