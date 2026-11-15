// T2: one "create a tag" intent. The +Tag row and the sidebar's "Create #name"
// (frontend tagWriter.create → POST /api/tags) make the same tag as a `#name`
// typed in a note (POST /api/tags/resolve-path): any writer may, the row has
// no tag_schema, and the record is TAG_CREATED. Before T2 the writer rode the
// owner-only pack import, so an editor saw the tag appear and then roll back
// on 403, and the owner got a TAG_IMPORTED collection schema instead.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import { withIdempotencyKey } from "../spine/idempotency.js";
import tags from "../routes/tags.js";
import { persistActor } from "./helpers/persistActor.js";
import { createTaskNode } from "../services/tasksStore.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let ws = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));

function send(actor: ActorCtx, path: string, body: unknown, key: string = randomUUID()) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await withIdempotencyKey(c.req.header("Idempotency-Key") ?? randomUUID(), next);
  });
  app.route("/api/tags", tags);
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

async function tagRow(id: string) {
  return (await q<{ node_type: string; parent_id: string | null; tag_color: string | null; tag_schema: unknown }>(
    `SELECT node_type, parent_id, tag_color, tag_schema FROM content_nodes WHERE id = $1`, [id],
  )).rows[0];
}

async function eventsFor(id: string) {
  return (await q<{ event_type: string; actor_id: string; payload: Record<string, unknown>; inverse_op: string | null }>(
    `SELECT event_type, actor_id, payload, tx_meta->>'inverse_op' AS inverse_op
       FROM domain_events WHERE target_id = $1 ORDER BY id`, [id],
  )).rows;
}

const name = (label: string) => `t2-${label}-${randomUUID().slice(0, 8)}`;

describe.skipIf(!isTestDb)("POST /api/tags: the writer's create is the hashtag's create (T2)", () => {
  let owner: ActorCtx = { id: "", name: "Owner", role: "admin", type: "human" };
  let editor: ActorCtx = { id: "", name: "Editor", role: "editor", type: "human" };
  let readOnlyToken: ActorCtx = { id: "", name: "Read-only token", role: "editor", type: "agent" };

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('T2 tag create', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(ws, owner);
    editor = await persistActor(ws, editor);
    readOnlyToken = await persistActor(ws, {
      ...readOnlyToken,
      tokenScope: { tokenId: "", allowedTools: null, access: "read", expiresAt: null },
    } as ActorCtx);
  });

  it("an editor of the shared space creates a tag with the client's id, shaped like a #name tag", async () => {
    const id = randomUUID();
    const tagName = name("reading");
    const res = await send(editor, "/api/tags", { id, name: tagName }, id);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id, name: tagName, parent_id: null, color: "#888888" });

    // The same tag a `#name` in a note makes.
    const viaHashtag = await send(editor, "/api/tags/resolve-path", { path: name("hashtag") });
    expect(viaHashtag.status).toBe(200);
    const { leaf_id: hashtagId } = await viaHashtag.json() as { leaf_id: string };
    const created = await tagRow(id);
    expect(created).toEqual({ node_type: "class_tag", parent_id: null, tag_color: "#888888", tag_schema: null });
    expect(created).toEqual(await tagRow(hashtagId));

    const events = await eventsFor(id);
    expect(events).toEqual([{
      event_type: "TAG_CREATED", actor_id: editor.id,
      payload: { name: tagName, parent_id: null }, inverse_op: "tag.deleted",
    }]);
    expect((await eventsFor(hashtagId)).map((e) => [e.event_type, e.inverse_op])).toEqual([["TAG_CREATED", "tag.deleted"]]);
  });

  it("the owner gets the same plain tag (no TAG_IMPORTED, no collection schema)", async () => {
    const id = randomUUID();
    expect((await send(owner, "/api/tags", { id, name: name("owner") }, id)).status).toBe(201);
    expect((await tagRow(id))!.tag_schema).toBeNull();
    expect((await eventsFor(id)).map((e) => e.event_type)).toEqual(["TAG_CREATED"]);
  });

  it("a replay of the committed create (same Idempotency-Key) answers the same tag, not a second one", async () => {
    const id = randomUUID();
    const body = { id, name: name("replay") };
    expect((await send(editor, "/api/tags", body, id)).status).toBe(201);
    // The id lookup under the event lock answers before the key's claim would.
    const replay = await send(editor, "/api/tags", body, id);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ id, name: body.name, parent_id: null, color: "#888888" });
    expect(await eventsFor(id)).toHaveLength(1);
  });

  it("a read-only token is refused and nothing is written", async () => {
    const id = randomUUID();
    const res = await send(readOnlyToken, "/api/tags", { id, name: name("token") }, id);
    expect(res.status).toBe(403);
    expect(await tagRow(id)).toBeUndefined();
    expect(await eventsFor(id)).toEqual([]);
  });

  it("a root sibling of the same name is a 409 tag_name_conflict, not adopted", async () => {
    const taken = name("taken");
    expect((await send(editor, "/api/tags/resolve-path", { path: taken })).status).toBe(200);
    const id = randomUUID();
    const res = await send(editor, "/api/tags", { id, name: taken }, id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "tag_name_conflict" });
    expect(await tagRow(id)).toBeUndefined();
    expect(await eventsFor(id)).toEqual([]);
  });

  it("a malformed id, an empty name or a name with \"/\" is a 400", async () => {
    expect((await send(editor, "/api/tags", { id: "not-a-uuid", name: name("bad") })).status).toBe(400);
    expect((await send(editor, "/api/tags", { name: "   " })).status).toBe(400);
    // A "/" is a path (#a/b makes two levels), never one tag named "a/b".
    const slashed = name("a/b");
    expect((await send(editor, "/api/tags", { name: slashed })).status).toBe(400);
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND title = $2`, [ws, slashed])).rows).toEqual([]);
  });

  it("an id that belongs to a note is a 409 id_conflict, not a 500 the queue would retry forever", async () => {
    const noteId = randomUUID();
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown)
             VALUES ($1, $2, 'manual', 'content', 'T2 note', $3, '')`, [noteId, ws, `t2-note-${noteId}`]);
    const res = await send(editor, "/api/tags", { id: noteId, name: name("onnote") });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "id_conflict" });
    expect((await tagRow(noteId))!.node_type).toBe("content");
    expect(await eventsFor(noteId)).toEqual([]);
  });

  it("the same id under a new Idempotency-Key (the old one pruned) answers the same tag; another name is id_conflict", async () => {
    const id = randomUUID();
    const body = { id, name: name("rekeyed") };
    expect((await send(editor, "/api/tags", body, randomUUID())).status).toBe(201);
    const again = await send(editor, "/api/tags", body, randomUUID());
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ id, name: body.name, parent_id: null, color: "#888888" });
    expect(await eventsFor(id)).toHaveLength(1);

    const renamed = await send(editor, "/api/tags", { id, name: name("other") }, randomUUID());
    expect(renamed.status).toBe(409);
    expect(await renamed.json()).toMatchObject({ error: "id_conflict" });
    expect(await eventsFor(id)).toHaveLength(1);
  });

  it("a member cannot create a root tag with a system tag's title, by either route; nested is fine", async () => {
    for (const title of ["page", "workspace-config"]) {
      const id = randomUUID();
      const res = await send(editor, "/api/tags", { id, name: title }, id);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "reserved_name" });
      expect(await tagRow(id)).toBeUndefined();
    }
    const typed = await send(editor, "/api/tags/resolve-path", { path: "page" });
    expect(typed.status).toBe(409);
    expect(await typed.json()).toMatchObject({ error: "reserved_name" });
    // Only a root tag can be adopted as the system tag.
    expect((await send(editor, "/api/tags/resolve-path", { path: `${name("site")}/page` })).status).toBe(200);
  });

  it("the owner's root #task is created and stays a plain tag; a member's first task makes no tag", async () => {
    const id = randomUUID();
    const res = await send(owner, "/api/tags", { id, name: "task" }, id);
    expect(res.status).toBe(201);
    // A task references the tasks function (migration 191); it never makes or takes a tag.
    const tagsBefore = (await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag'`, [ws])).rowCount;
    const host = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1,'manual','content','host',$2,'') RETURNING id::text`,
      [ws, `tag-route-host-${id}`])).rows[0]!.id;
    const taskId = await createTaskNode({ workspaceId: ws, actor: owner, hostId: host, title: "first task" });
    expect((await q(`SELECT 1 FROM function_refs WHERE holder_node_id = $1 AND function_id = 'tasks'`, [taskId])).rowCount).toBe(1);
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag'`, [ws])).rowCount).toBe(tagsBefore);
    expect((await q(`SELECT reserved_key FROM content_nodes WHERE id = $1`, [id])).rows[0]).toEqual({ reserved_key: null });
  });

  it("the pack import stays the owner's", async () => {
    const res = await send(editor, "/api/tags/import", { name: name("pack"), fields: [] });
    expect(res.status).toBe(403);
  });
});
