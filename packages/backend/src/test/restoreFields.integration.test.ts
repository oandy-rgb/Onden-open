import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { event, q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import tagsRouter from "../routes/tags.js";
import reviewRouter from "../modules/review/routes.js";
import inboxRouter from "../routes/inbox.js";
import { previewEventRestore, restoreEvent, type EventRow } from "../services/eventRestore/index.js";
import type { AttributeState } from "../services/eventLog/attributeSnapshot.js";
import type { ActorCtx } from "../types.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "fields-admin", name: "Fields admin", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter).route("/tasks", tasksRouter).route("/tags", tagsRouter).route("/review", reviewRouter).route("/inbox", inboxRouter);
app.post("/nodes/:id/tasks", addTaskUnderNote);
const write = (url: string, method: string, body: unknown = {}) => app.request(url, {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
async function node(title = "Field restore") {
  return (await seedQ<{ id: string }>(`INSERT INTO content_nodes (workspace_id,title,slug,markdown,node_type,source_type)
    VALUES ($1,$2,$3,'','content','manual') RETURNING id`, [workspaceId, title, randomUUID()])).rows[0]!.id;
}
async function setAttribute(id: string, key: string, state: AttributeState) {
  await seedQ(`INSERT INTO node_attributes (workspace_id,node_id,key,value,value_type,is_inheritable,source)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(node_id,key) DO UPDATE SET value=$4,value_type=$5,is_inheritable=$6,source=$7`,
  [workspaceId, id, key, state.value, state.value_type, state.is_inheritable, state.source]);
}
async function attribute(id: string, key: string) {
  return (await q<AttributeState>(`SELECT value,value_type,is_inheritable,source FROM node_attributes WHERE node_id=$1 AND key=$2`, [id, key])).rows[0] ?? null;
}
async function latest(id: string, type?: string): Promise<EventRow> {
  return (await q<EventRow>(`SELECT id::text,workspace_id,event_type,target_type,target_id,payload,tx_meta,external
    FROM domain_events WHERE target_id=$1 AND ($2::text IS NULL OR event_type=$2) ORDER BY domain_events.id DESC LIMIT 1`, [id, type ?? null])).rows[0]!;
}
const restore = (id: string, extra = {}) => restoreEvent(id, { actor, workspaceId, ...extra });

describe.skipIf(!isTestDb)("attribute and tag restore through real writers", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Restore fields',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    await setModulesOn(workspaceId, null);
    actor = await persistActor(workspaceId, actor);
  });

  it("serializes concurrent attribute overwrites into a truthful before/after chain", async () => {
    const id = await node();
    const initial: AttributeState = { value: "1", value_type: "number", is_inheritable: true, source: "frontmatter" };
    await setAttribute(id, "score", initial);
    const responses = await Promise.all(["2", "3"].map((value) => write(`/nodes/${id}/attributes/score`, "PUT", { value })));
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const events = (await q<EventRow>(`SELECT id::text,payload,tx_meta FROM domain_events WHERE target_id=$1 AND event_type='ATTRIBUTE_SET' ORDER BY domain_events.id`, [id])).rows;
    expect(events).toHaveLength(2);
    expect(events[0].tx_meta.prev_field_values).toEqual(initial);
    // No value_type and no is_inheritable sent: the row's own type and flag stay (D21: the sent type is only a hint; scan 06 M1).
    const firstAfter = { value: events[0].payload.value, value_type: "number", is_inheritable: true, source: "ui" };
    expect(events[1].tx_meta.prev_field_values).toEqual(firstAfter);
    expect(await restore(events[1].id)).toMatchObject({ restored: true });
    expect(await attribute(id, "score")).toEqual(firstAfter);
    expect(await restore(events[0].id)).toMatchObject({ restored: true });
    expect(await attribute(id, "score")).toEqual(initial);
  });

  it("round-trips ink deletion with metadata and hash references", async () => {
    const id = await node();
    const initial: AttributeState = { value: '{"strokes":[1,2]}', value_type: "text", is_inheritable: true, source: "explicit" };
    await setAttribute(id, "ink_data", initial);
    expect((await write(`/nodes/${id}/attributes/ink_data`, "DELETE")).status).toBe(200);
    const removed = await latest(id, "ATTRIBUTE_DELETED");
    expect(removed.tx_meta.prev_field_values).toMatchObject({ source: "explicit", is_inheritable: true, value_ref: expect.any(String) });
    expect(await restore(removed.id)).toMatchObject({ restored: true });
    expect(await attribute(id, "ink_data")).toEqual(initial);
    const undone = await latest(id, "ATTRIBUTE_SET");
    expect(undone.payload).not.toHaveProperty("value");
    expect(await restore(undone.id)).toMatchObject({ restored: true });
    expect(await attribute(id, "ink_data")).toBeNull();
  });

  it("does not force over a later attribute metadata change", async () => {
    const id = await node();
    await write(`/nodes/${id}/attributes/score`, "PUT", { value: "2" });
    const original = await latest(id, "ATTRIBUTE_SET");
    await seedQ(`UPDATE node_attributes SET is_inheritable=true WHERE node_id=$1 AND key='score'`, [id]);
    expect(await restore(original.id, { force: true })).toMatchObject({ code: "state_conflict", status: 409, force_available: false });
    expect(await attribute(id, "score")).toMatchObject({ value: "2", is_inheritable: true });
  });

  it("records the actual retained task metadata and supports undo/redo", async () => {
    const host = await node();
    const created = await write(`/nodes/${host}/tasks`, "POST", { title: "Study", due_date: "2026-10-01" });
    expect(created.status).toBeLessThan(300);
    const { id } = await created.json() as { id: string };
    const initial: AttributeState = { value: "2026-10-01", value_type: "date", is_inheritable: true, source: "markdown" };
    await setAttribute(id, "_task_when", initial);
    expect((await write(`/tasks/${id}`, "PATCH", { due_date: "2026-10-02" })).status).toBe(200);
    const changed = await latest(id, "ATTRIBUTE_SET");
    expect(changed.payload).toMatchObject({ ...initial, value: "2026-10-02" });
    expect(changed.tx_meta.prev_field_values).toEqual(initial);
    expect(await restore(changed.id)).toMatchObject({ restored: true });
    expect(await attribute(id, "_task_when")).toEqual(initial);
    expect(await restore((await latest(id)).id)).toMatchObject({ restored: true });
    expect(await attribute(id, "_task_when")).toEqual({ ...initial, value: "2026-10-02" });
  });

  it("serializes two grades from the actual preceding review state", async () => {
    const id = await node();
    await seedQ(`INSERT INTO function_refs(workspace_id,function_id,holder_node_id) VALUES($1,'review',$2)`, [workspaceId, id]);
    const grades = await Promise.all([3, 4].map((rating) => write(`/review/${id}/grade`, "POST", { rating, now: "2026-09-08T00:00:00.000Z" })));
    expect(grades.map((r) => r.status)).toEqual([200, 200]);
    // Personal progress (review_states): the second grade saw the first's state.
    const row = (await q<{ state: string; previous_state: string }>(
      `SELECT state, previous_state FROM review_states WHERE node_id=$1`, [id])).rows;
    expect(row).toHaveLength(1);
    expect(JSON.parse(row[0]!.state).reps).toBe(2);
    expect(JSON.parse(row[0]!.previous_state).reps).toBe(1);
  });

  it("a child with incomplete history rolls back siblings and cannot clear an inbox rejection", async () => {
    const id = await node();
    const sibling = await node();
    const root = await event(workspaceId, "NODE_CREATED", "node", id, {}, "ai_agent", "agent");
    await setAttribute(id, "legacy", { value: "later", value_type: "text", is_inheritable: false, source: "ui" });
    await event(workspaceId, "ATTRIBUTE_SET", "node", id, { key: "legacy", value: "then" }, "ai_agent", "agent", {
      triggeredBy: root, txMeta: { inverse_op: "attribute.set", prev_field_values: { value: "before" } },
    });
    await event(workspaceId, "NODE_CREATED", "node", sibling, {}, "ai_agent", "agent", { triggeredBy: root });
    const result = await write(`/inbox/${root}/reject`, "POST");
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: "history_incomplete" });
    expect((await q(`SELECT id FROM content_nodes WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL`, [[id, sibling]])).rows).toHaveLength(2);
    expect((await q(`SELECT id FROM domain_events WHERE workspace_id=$1 AND tx_meta ? 'restored_from' AND target_id=ANY($2::text[])`, [workspaceId, [id, sibling]])).rows).toHaveLength(0);
    expect((await q(`SELECT event_id FROM event_reviews WHERE event_id=$1::bigint`, [root])).rows).toHaveLength(0);
  });

  it("restores nullable tag color without overwriting a later rename or schema identity", async () => {
    const { tagId: id } = await seedClassTag(workspaceId, { name: "Pack name", title: "Visible name", slug: "pack-identity", nodeSlug: randomUUID() });
    await seedQ(`UPDATE content_nodes SET tag_color=NULL WHERE id=$1`, [id]);
    expect((await write(`/tags/${id}`, "PATCH", { color: "#aabbcc" })).status).toBe(200);
    const colorEvent = await latest(id, "TAG_UPDATED");
    expect(colorEvent.tx_meta.prev_field_values).toEqual({ color: null });
    await write(`/tags/${id}`, "PATCH", { name: "Later visible name" });
    expect(await restore(colorEvent.id)).toMatchObject({ restored: true });
    const tag = (await q<{ title: string; tag_color: string | null; tag_schema: { name: string; slug: string } }>(`SELECT title,tag_color,tag_schema FROM content_nodes WHERE id=$1`, [id])).rows[0];
    expect(tag).toMatchObject({ title: "Later visible name", tag_color: null, tag_schema: { name: "Pack name", slug: "pack-identity" } });
    expect(await restore((await latest(id)).id)).toMatchObject({ restored: true });
    expect((await q<{ tag_color: string }>(`SELECT tag_color FROM content_nodes WHERE id=$1`, [id])).rows[0].tag_color).toBe("#aabbcc");
  });

  it("undoing a tag rename into a name another tag took now is a state_conflict, not a unique-key 500", async () => {
    const taken = `Taken ${randomUUID()}`;
    const { tagId: id } = await seedClassTag(workspaceId, { name: `Renamed ${randomUUID()}`, nodeSlug: randomUUID() });
    const { tagId: other } = await seedClassTag(workspaceId, { name: taken, nodeSlug: randomUUID() });
    const title = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [id])).rows[0]!.title;
    // The rename that history holds: the tag was called `taken`, then `title`.
    const renameEvent = await event(workspaceId, "NODE_UPDATED", "node", id, { title }, "user", actor.id,
      { txMeta: { prev_field_values: { title: taken }, inverse_patch: "" } });
    expect(other).not.toBe(id);
    expect(await restore(String(renameEvent))).toMatchObject({ code: "state_conflict", reason: "tag_name_conflict", force_available: false });
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id=$1`, [id])).rows[0]!.title).toBe(title);
  });

  it("refuses a later schema edit and an occupied historical tag slug", async () => {
    const { tagId: id } = await seedClassTag(workspaceId, { name: "Before name", nodeSlug: "before-slug" });
    await write(`/tags/${id}`, "PATCH", { name: "After name" });
    const renamed = await latest(id);
    await seedClassTag(workspaceId, { name: "Occupied", nodeSlug: "before-slug" });
    expect(await restore(renamed.id)).toMatchObject({ code: "state_conflict", force_available: false });
    await write(`/tags/${id}/schema`, "PATCH", { views: { list: { type: "list" } } });
    const first = await latest(id);
    await write(`/tags/${id}/schema`, "PATCH", { views: { table: { type: "table" } } });
    expect(await restore(first.id, { force: true })).toMatchObject({ code: "state_conflict", force_available: false });
    expect(await previewEventRestore(first.id, { actor, workspaceId })).toMatchObject({ preview: { kind: "tag_schema_update", can_apply_cleanly: false, conflict_code: "state_conflict" } });
  });
});
