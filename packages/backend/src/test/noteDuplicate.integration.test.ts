import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { duplicateNote } from "../services/noteDuplicate.js";
import { withIdempotencyKey } from "../spine/idempotency.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { markAsTask } from "./helpers/taskRef.js";
import { adminOnlySpace, makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

let workspaceId = "";
let actor: ActorCtx = { id: "duplicate-admin", name: "Admin", role: "admin", type: "human" };
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/nodes", nodesRouter);
const dbName = (() => { try { return new URL(process.env.DATABASE_URL ?? "").pathname; } catch { return ""; } })();

async function node(title: string, markdown = "", parentId: string | null = null, type = "content") {
  return (await seedQ<{ id: string }>(`INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug,markdown,parent_id)
    VALUES($1,'manual',$2,$3,$4,$5,$6) RETURNING id`, [workspaceId, type, title, randomUUID(), markdown, parentId])).rows[0]!.id;
}
function copy(source: string, id = randomUUID()) {
  return app.request(`/api/nodes/${source}/duplicate`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
}
async function state(id: string) {
  const [nodes, attrs, tags, events] = await Promise.all([
    q<{ title: string; markdown: string; parent_id: string | null; node_type: string }>(
      "SELECT title,markdown,parent_id,node_type FROM content_nodes WHERE id=$1", [id]),
    q<{ key: string; value: string; source: string }>(
      "SELECT key,value,source FROM node_attributes WHERE node_id=$1 ORDER BY key", [id]),
    q<{ tag_id: string }>("SELECT tag_id FROM node_tags WHERE node_id=$1", [id]),
    q<{ event_type: string; payload: Record<string, unknown> }>(
      "SELECT event_type,payload FROM domain_events WHERE workspace_id=$1 AND target_id=$2 ORDER BY id", [workspaceId,id]),
  ]);
  return { node: nodes.rows[0], attrs: attrs.rows, tags: tags.rows, events: events.rows };
}

describe.skipIf(!/^\/[^/]*_test$/.test(dbName))("NOTE-11/PER-02 atomic note copy", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('驗收 duplicate',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });
  afterAll(async () => {
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [workspaceId]);
  });

  it("copies current parent, explicit attributes, media references and direct tags without automation or source edges", async () => {
    const parent = await node("Parent");
    const source = await node("Photo", "![photo](/media/a.png)", parent);
    const tag = await seedClassTag(workspaceId, { name: `Policy ${randomUUID()}`, nodeSlug: randomUUID(),
      behaviour: { on_apply: { type: "set_attribute", key: "auto", value: "surprise" } } });
    await seedQ("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)", [source,tag.tagId]);
    await seedQ(`INSERT INTO node_attributes(workspace_id,node_id,key,value,source) VALUES
      ($1,$2,'color','/media/b.png','ui'),($1,$2,'ink_data','{"strokes":[1]}','explicit'),
      ($1,$2,'derived-only','no','dispatcher'),($1,$2,'_import_path','source.md','derived'),
      ($1,$2,'_published','true','ui')`, [workspaceId,source]);
    const id = randomUUID();
    const response = await copy(source,id);
    expect(response.status, await response.clone().text()).toBe(201);
    const returned = await response.json();
    expect(returned).toMatchObject({ id, title: "Photo (Copy)", markdown: "![photo](/media/a.png)", parent_id: parent });
    const actual = await state(id);
    expect(actual.node).toMatchObject({ title: "Photo (Copy)", markdown: "![photo](/media/a.png)", parent_id: parent, node_type: "content" });
    expect(actual.attrs.map(row => row.key)).toEqual(["color", "ink_data"]);
    expect(actual.attrs[0]).toMatchObject({ value: "/media/b.png", source: "ui" });
    expect(actual.tags).toEqual([{ tag_id: tag.tagId }]);
    expect(actual.events.map(row => row.event_type)).toEqual(["NODE_CREATED", "TAG_APPLIED", "ATTRIBUTE_SET", "ATTRIBUTE_SET"]);
    expect(actual.events[1]!.payload.membership_change).toMatchObject({ after_state_id: expect.any(String) });
    expect((await q("SELECT 1 FROM node_edges WHERE source_node_id=$1 OR target_node_id=$1", [id])).rows).toHaveLength(0);
  });

  it("a hidden 「內容」 tab is copied with the text, in its place among the tabs; a note with no record gets none", async () => {
    const hidden = await node("Sketch only", "words that stay");
    const plain = await node("Plain", "just text");
    const view = (layout: string, name: string, pin: number, config: object) => seedQ(
      `INSERT INTO function_refs(workspace_id, holder_node_id, function_id, instance, config) VALUES($1,$2,$3,$4,$5)`,
      [workspaceId, hidden, layout, randomUUID(), JSON.stringify({ name, filters: [], sorts: [], group_by: null, visible_fields: [], layout_config: config, pin_order: pin })]);
    await view("handwriting", "Handwriting", 0, {});
    await view("content", "Content", 1, { hidden: true });
    const copiedViews = async (source: string) => {
      const response = await copy(source);
      expect(response.status, await response.clone().text()).toBe(201);
      const id = ((await response.json()) as { id: string }).id;
      return (await q<{ function_id: string; config: { pin_order: number; layout_config: object } }>(
        `SELECT function_id, config FROM function_refs WHERE holder_node_id = $1 AND instance <> '' ORDER BY function_id`, [id])).rows;
    };
    expect((await copiedViews(hidden)).map((row) => [row.function_id, row.config.pin_order, row.config.layout_config]))
      .toEqual([["content", 1, { hidden: true }], ["handwriting", 0, {}]]);
    expect(await copiedViews(plain)).toEqual([]);
  });

  it("a trashed tag is left off the copy instead of refusing it", async () => {
    const source = await node("Merged note");
    const live = await seedClassTag(workspaceId, { name: `Live ${randomUUID()}`, nodeSlug: randomUUID() });
    const gone = await seedClassTag(workspaceId, { name: `Gone ${randomUUID()}`, nodeSlug: randomUUID() });
    await seedQ("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2),($1,$3)", [source, live.tagId, gone.tagId]);
    await seedQ("UPDATE content_nodes SET deleted_at = now() WHERE id = $1", [gone.tagId]);
    const id = randomUUID();
    const response = await copy(source, id);
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await state(id)).tags).toEqual([{ tag_id: live.tagId }]);
  });

  it("a copy into a space the actor may only view rolls back whole, key included", async () => {
    const space = await makeSpace(workspaceId, `View only ${randomUUID()}`, [{ id: actor.id, permission: "view" }]);
    const parent = await node("Restrictive parent");
    const source = await node("Restricted copy", "body", parent);
    await putInSpace(parent, space);
    const id = randomUUID(), key = randomUUID();
    const refused = await withIdempotencyKey(key, () => copy(source,id));
    expect(refused.status).toBe(403);
    expect(await state(id)).toMatchObject({ node: undefined, attrs: [], tags: [], events: [] });
    expect((await q("SELECT 1 FROM idempotency_keys WHERE key=$1", [key])).rows).toHaveLength(0);
    await q("UPDATE space_members SET permission='edit' WHERE space_id=$1 AND actor_id=$2", [space, actor.id]);
    const accepted = await withIdempotencyKey(key, () => copy(source,id));
    expect(accepted.status, await accepted.clone().text()).toBe(201);
  });

  it("one idempotency key survives a lost response without another node or event", async () => {
    const source = await node("Retry source", "body");
    const id = randomUUID(), key = randomUUID();
    const first = await withIdempotencyKey(key, () => copy(source,id));
    expect(first.status).toBe(201);
    const replay = await withIdempotencyKey(key, () => copy(source,id));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ deduped: true });
    expect((await copy(source,id)).status).toBe(409);
    expect((await state(id)).events.map(row => row.event_type)).toEqual(["NODE_CREATED"]);
  });

  it("an actor outside the source's space, or a read-only token, cannot copy", async () => {
    const source = await node("Private source", "body");
    await putInSpace(source, await adminOnlySpace(workspaceId, `Private ${randomUUID()}`, [actor.id]));
    const base: ActorCtx = { id: "scope-editor", name: "Scope editor", role: "editor", type: "human" };
    const open = await node("Open source", "body");
    const cases: Array<[ActorCtx, string]> = [
      [base, source],
      [{ ...base, type: "agent", tokenScope: {
        tokenId: "copy-scope", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null } }, open],
    ];
    for (const [scoped, from] of cases) {
      const id = randomUUID();
      const identity = await persistActor(workspaceId, scoped);
      await expect(duplicateNote({ workspaceId, actor: identity, sourceId: from, newNodeId: id })).rejects.toThrow();
      expect(await state(id)).toMatchObject({ node: undefined, attrs: [], tags: [], events: [] });
    }
  });

  it("a top-level copy lands in its source's space, not the copier's personal space", async () => {
    const shared = await makeSpace(workspaceId, `Shared ${randomUUID()}`, [{ id: actor.id, permission: "edit" }]);
    const source = await node("Shared source", "body");
    await putInSpace(source, shared);
    const id = randomUUID();
    expect((await copy(source, id)).status).toBe(201);
    expect((await q<{ space_id: string }>("SELECT space_id::text FROM content_nodes WHERE id=$1", [id])).rows[0]!.space_id).toBe(shared);
  });

  it("rejects non-content and task nodes explicitly", async () => {
    const tag = await node("Tag source", "", null, "class_tag");
    expect((await copy(tag)).status).toBe(422);
    const host = await node("Task host");
    // A task references the tasks function.
    const task = await node("Task", "", host);
    await markAsTask(workspaceId, task);
    await seedQ("INSERT INTO node_attributes(workspace_id,node_id,key,value) VALUES($1,$2,'_task_status','todo')", [workspaceId,task]);
    expect((await copy(task)).status).toBe(422);
  });

  it("historical body uses the source's current parent and direct tags", async () => {
    const formerParent = await node("Former parent");
    const currentParent = await node("Current parent");
    const source = await node("Historical", "old body", formerParent);
    const updated = await app.request(`/api/nodes/${source}`, { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown: "new body" }) });
    expect(updated.status).toBe(200);
    const changed = (await q<{ id: string }>("SELECT id::text FROM domain_events WHERE target_id=$1 AND event_type='NODE_UPDATED' ORDER BY domain_events.id DESC LIMIT 1", [source])).rows[0]!.id;
    const later = await app.request(`/api/nodes/${source}`, { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown: "later body" }) });
    expect(later.status).toBe(200);
    await seedQ("UPDATE content_nodes SET parent_id=$2 WHERE id=$1", [source,currentParent]);
    const tag = await seedClassTag(workspaceId, { name: `Current ${randomUUID()}`, nodeSlug: randomUUID() });
    await seedQ("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)", [source,tag.tagId]);
    const result = await restoreEvent(changed, { actor, workspaceId, as_new_node: true });
    expect(result).toMatchObject({ restored: true, new_node_id: expect.any(String) });
    if (!("restored" in result)) throw new Error("expected restore copy");
    const actual = await state(result.new_node_id!);
    expect(actual.node).toMatchObject({ markdown: "old body", parent_id: currentParent });
    expect(actual.tags).toEqual([{ tag_id: tag.tagId }]);
    expect(actual.events.map(row => row.event_type)).toEqual(["NODE_CREATED", "TAG_APPLIED"]);
  });
});
