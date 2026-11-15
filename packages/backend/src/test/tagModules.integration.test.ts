import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import tagsRouter from "../routes/tags.js";
import nodesRouter from "../routes/nodes.js";
import syncRouter from "../routes/sync.js";
import { patchTagModules as setTagModules } from "../services/legacyTagFunctionWrites.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { installTagPackApproved } from "../services/tagPacks.js";
import type { ActorCtx } from "../types.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { registerStandInFunction } from "./helpers/registerStandInFunction.js";
import { deleteWorkspaceActors, setWorkspaceOwner } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();
registerStandInFunction();

let workspaceId: string;
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const dbName = (() => { try { return new URL(process.env.DATABASE_URL ?? "").pathname; } catch { return ""; } })();
let owner: ActorCtx;

function app(actor = owner) {
  const result = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  result.onError(apiOnError);
  result.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  result.route("/api/tags", tagsRouter);
  result.route("/api/nodes", nodesRouter);
  result.route("/api/sync", syncRouter);
  return result;
}
function patch(tagId: string, modules: unknown, actor = owner) {
  return app(actor).request(`/api/tags/${tagId}/modules`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(modules),
  });
}
async function plainTag(title = `module-${randomUUID()}`) {
  return (await seedQ<{ id: string }>(`INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug,markdown)
    VALUES($1,'manual','class_tag',$2,$3,'') RETURNING id`, [workspaceId,title,randomUUID()])).rows[0].id;
}
async function note(tags: string[]) {
  const id = (await seedQ<{ id: string }>(`INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug,markdown)
    VALUES($1,'manual','content','Module member',$2,'body') RETURNING id`, [workspaceId,randomUUID()])).rows[0].id;
  for (const tag of tags) await seedQ("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)", [id,tag]);
  return id;
}
async function schema(tag: string) {
  return (await db.q<{ tag_schema: Record<string, unknown> | null }>("SELECT tag_schema FROM content_nodes WHERE id=$1", [tag])).rows[0].tag_schema;
}
// The functions a tag holds itself: its function_refs rows (a tag's switch is a reference now, not behaviour.modules).
async function refIds(tag: string) {
  return (await db.q<{ function_id: string }>("SELECT function_id FROM function_refs WHERE holder_node_id=$1 ORDER BY function_id", [tag])).rows.map((r) => r.function_id);
}
// What migration 083 wrote (it predates function references; 166 reads this shape).
const legacyEnabled = (behaviour: unknown, id: string) => ((behaviour as { modules?: Record<string, { enabled?: unknown }> } | null)?.modules?.[id]?.enabled) === true;
async function events(tag: string) {
  return (await db.q<{ id: string; event_type: string; actor_id: string; payload: Record<string, unknown>; tx_meta: Record<string, unknown> }>(
    "SELECT id::text,event_type,actor_id,payload,tx_meta FROM domain_events WHERE workspace_id=$1 AND target_id=$2 ORDER BY domain_events.id", [workspaceId,tag])).rows;
}
// Backed off 256 ids: /api/sync parses `since` as a JS number, lossy once the
// shared test DB's event ids pass 2^53. Re-shipping a few older rows is harmless.
async function cursor() {
  return Number((await db.q<{ id: string }>("SELECT GREATEST(COALESCE(MAX(id),0) - 256, 0)::text AS id FROM domain_events WHERE workspace_id=$1", [workspaceId])).rows[0].id);
}
type Delta = { tags?: Array<{ id: string; schema_behaviour: unknown }>; nodes: { upsert: Array<{ id: string; class_tag_ids: string[]; label_tag_ids: string[]; tag_schema?: { behaviour: unknown } }>; delete: string[] } };
async function delta(since: number, actor = owner): Promise<Delta> {
  const response = await app(actor).request(`/api/sync?since=${since}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<Delta>;
}

describe.skipIf(!/^\/[^/]*_test$/.test(dbName))("explicit tag module configuration (real DB)", () => {
  beforeAll(async () => {
    workspaceId = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Module configuration',$1) RETURNING id", [randomUUID()])).rows[0].id;
    owner = await persistActor(workspaceId, { id: "owner", name: "Owner", role: "admin", type: "human" });
  });
  afterAll(async () => {
    if (!workspaceId) return;
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [workspaceId]);
    await deleteWorkspaceActors(workspaceId);
  });

  it("atomically merges only supplied module switches, records complete behaviour and skips authorized repeats", async () => {
    const before = { review: { new_per_day: 7 }, on_apply: [{ kind: "set_attribute", key: "unchanged", value: "keep" }] };
    const { tagId } = await seedClassTag(workspaceId, { name: randomUUID(), behaviour: before, fields: [{ name: "topic", type: "text" }] });
    const existingMember = await note([tagId]);
    expect((await patch(tagId, { review: true })).status).toBe(200);
    expect((await patch(tagId, { skills: true })).status).toBe(200);
    const stored = await schema(tagId);
    // The switches are function references now: the schema's behaviour is left exactly as it was.
    expect(stored?.behaviour).toEqual(before);
    expect(await refIds(tagId)).toEqual(["review", "skills"]);
    expect(stored?.fields).toEqual([{ name: "topic", type: "text" }]);
    expect((await db.q("SELECT 1 FROM node_attributes WHERE node_id=$1", [existingMember])).rows).toHaveLength(0);
    const history = await events(tagId);
    expect(history).toHaveLength(2);
    expect(history.map((e) => e.event_type)).toEqual(["FUNCTION_REF_ADDED", "FUNCTION_REF_ADDED"]);
    expect(history[0]).toMatchObject({ actor_id: owner.id, payload: { function_id: "review" } });
    expect((await patch(tagId, { review: true, skills: true })).status).toBe(200);
    expect(await events(tagId)).toHaveLength(2);
    expect((await patch(tagId, { review: "yes" })).status).toBe(400);
    expect((await patch(tagId, { unsupported: true })).status).toBe(400);
    expect((await patch("not-a-tag-id", { review: true })).status).toBe(400);
  });

  it("checks current ownership and delegated token before no-op/existence decisions", async () => {
    const tagId = await plainTag();
    const editor = await persistActor(workspaceId, { id: "editor", name: "Editor", role: "editor", type: "human" });
    const token = await persistActor(workspaceId, { ...owner, tokenScope: { tokenId: "new", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null } });
    for (const actor of [editor,token]) {
      expect((await patch(tagId, { review: false }, actor)).status).toBe(403);
      expect((await patch(randomUUID(), {}, actor)).status).toBe(403);
    }
    // A second person who was the workspace owner when its context was
    // captured (persistActor makes an admin fixture the owner) and no longer is
    // once ownership goes back to the first owner.
    const stale = await persistActor(workspaceId, owner);
    await setWorkspaceOwner(workspaceId, owner.id);
    expect((await patch(tagId, { review: false }, stale)).status).toBe(403);
    // (The matter-scoped 404 case was removed with matter scope.)
    expect(await schema(tagId)).toBeNull();
    expect(await events(tagId)).toHaveLength(0);
  });

  it("keeps module identity on rename and does not enable newly named review/toread tags", async () => {
    const tagId = await plainTag();
    await patch(tagId, { review: true });
    const renamed = await app().request(`/api/tags/${tagId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `Renamed ${randomUUID()}` }) });
    expect(renamed.status).toBe(200);
    expect(await refIds(tagId)).toEqual(["review"]);
    for (const name of ["review", "toread"]) {
      const response = await app().request("/api/tags/resolve-path", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: name }) });
      expect(response.status).toBe(200);
      const body = await response.json() as { leaf_id: string };
      expect(await schema(body.leaf_id)).toBeNull();
    }
  });

  it("disabling preserves membership and progress; restoring the switch uses the existing behaviour conflict contract", async () => {
    const { tagId } = await seedClassTag(workspaceId, { name: randomUUID(), behaviour: { modules: { review: { enabled: true } } } });
    const nodeId = await note([tagId]);
    await seedQ("INSERT INTO node_attributes(workspace_id,node_id,key,value,value_type,source) VALUES($1,$2,'_review_state',$3,'text','ui')", [workspaceId,nodeId,JSON.stringify({ reps: 3 })]);
    await patch(tagId, { review: false });
    const eventId = (await events(tagId)).at(-1)!.id;
    expect((await db.q("SELECT 1 FROM node_tags WHERE node_id=$1 AND tag_id=$2", [nodeId,tagId])).rows).toHaveLength(1);
    expect((await db.q<{ value: string }>("SELECT value FROM node_attributes WHERE node_id=$1 AND key='_review_state'", [nodeId])).rows[0].value).toBe(JSON.stringify({ reps: 3 }));
    expect(await restoreEvent(eventId, { actor: owner, workspaceId })).toMatchObject({ restored: true });
    expect(await refIds(tagId)).toEqual(["review"]);
    await patch(tagId, { review: false });
    const conflictId = (await events(tagId)).at(-1)!.id;
    // The switch was turned back on by hand since: undoing the earlier removal is a no-op the contract names, not a second row.
    await patch(tagId, { review: true });
    expect(await restoreEvent(conflictId, { actor: owner, workspaceId })).toMatchObject({ code: expect.stringMatching(/state_conflict|already_in_state/) });
    expect(await refIds(tagId)).toEqual(["review"]);
  });

  it("preserves current module switches when an older schema form replaces automation", async () => {
    const tagId = await plainTag();
    await patch(tagId, { review: true });
    const response = await app().request(`/api/tags/${tagId}/schema`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ behaviour: { review: { new_per_day: 9 }, modules: { review: { enabled: false } } } }) });
    expect(response.status).toBe(200);
    // An older client's modules switch inside behaviour no longer means anything: the reference is the switch and stays on.
    expect((await schema(tagId))?.behaviour).toEqual({ review: { new_per_day: 9 } });
    expect(await refIds(tagId)).toEqual(["review"]);
  });

  it("module-only schemas get a private slug, and enabling a module leaves a tag's own slug alone", async () => {
    const { tagId: publicCollection } = await seedClassTag(workspaceId, { name: randomUUID(), fields: [{ name: "topic", type: "text" }] });
    const privateTag = await plainTag();
    const member = await note([publicCollection, privateTag]);
    const oldSchema = await schema(publicCollection);
    await patch(privateTag, { skills: true });
    expect(await schema(privateTag)).toMatchObject({ publish_collection: false, slug: `module-${privateTag}` });
    await patch(publicCollection, { review: true });
    expect((await schema(publicCollection))?.publish_collection).toBeUndefined();
    expect((await schema(publicCollection))?.slug).toBe(oldSchema?.slug);
    for (const enabled of [false, true]) {
      await patch(privateTag, { skills: enabled });
      expect(await schema(privateTag)).toMatchObject({ publish_collection: false, slug: `module-${privateTag}` });
    }
    const exported = await (await app().request(`/api/tags/${privateTag}/export`)).json() as Record<string, unknown>;
    expect(exported.publish_collection).toBe(false);
    const response = await app().request("/api/tags/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...exported, name: `private-copy-${randomUUID()}` }) });
    expect(response.status).toBe(201);
    const direct = await response.json() as { id: string };
    const approved = await installTagPackApproved(workspaceId, { actorId: owner.id, actorType: "user" }, {
      ...exported, name: `private-approved-${randomUUID()}`, publish_collection: false,
    });
    for (const { id } of [direct,approved]) {
      expect(await schema(id)).toMatchObject({ publish_collection: false, slug: `module-${id}` });
      await seedQ("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)", [member,id]);
    }
  });

  it("syncs tag configuration and member reclassification, including tag trash/undelete, without leaking restricted members", async () => {
    const tagId = await plainTag();
    const visible = await note([tagId]);
    const hidden = await note([tagId]);
    await putInSpace(hidden, await adminOnlySpace(workspaceId, `hidden-${randomUUID()}`, [owner.id]));
    const viewer = await persistActor(workspaceId, { id: "viewer", name: "Viewer", role: "viewer", type: "human" });
    let since = await cursor();
    await patch(tagId, { skills: true });
    let result = await delta(since, viewer);
    expect((result as unknown as { tags?: Array<{ id: string; effective_modules: string[] }> }).tags?.find(t => t.id === tagId)?.effective_modules).toEqual(["skills"]);
    expect(result.nodes.upsert.find(n => n.id === visible)?.class_tag_ids).toContain(tagId);
    expect(result.nodes.upsert.find(n => n.id === visible)?.label_tag_ids).not.toContain(tagId);
    expect(result.nodes.upsert.some(n => n.id === hidden)).toBe(false);
    since = await cursor();
    expect((await app().request(`/api/nodes/${tagId}`, { method: "DELETE" })).status).toBe(200);
    result = await delta(since, viewer);
    expect(result.nodes.delete).toContain(tagId);
    expect(result.nodes.upsert.find(n => n.id === visible)?.class_tag_ids).not.toContain(tagId);
    since = await cursor();
    expect((await app().request(`/api/nodes/${tagId}/undelete`, { method: "POST" })).status).toBe(200);
    result = await delta(since, viewer);
    expect(result.nodes.upsert.find(n => n.id === visible)?.class_tag_ids).toContain(tagId);
  });

  // ("human/token-scoped sync keeps the independent tag catalog …" was removed:
  // matter scope and token tag scope no longer exist, and tag definitions are
  // global under spaces.)

  it("migration binds only previously active names, preserves settings, and creates a resumable sync baseline", async () => {
    // Run the real SQL in a rollback-only transaction: existing test workspaces
    // also contain legacy capability fixtures and must not be altered here.
    const rollback = new Error("migration test rollback");
    await expect(db.withTransaction(async () => {
      await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1 AND title IN ('review','toread')", [workspaceId]);
      const { tagId: review } = await seedClassTag(workspaceId, { name: "review", behaviour: { review: { new_per_day: 6 } } });
      const reading = await plainTag("toread");
      const member = await note([reading]);
      await seedQ("UPDATE content_nodes SET parent_id=$2 WHERE id=$1", [reading,member]);
      const { tagId: inactiveReading } = await seedClassTag(workspaceId, { name: "toread" });
      await db.q(readFileSync(new URL("../../db/migrations/083_tag_module_bindings.sql", import.meta.url), "utf8"));
      expect((await schema(review))?.behaviour).toEqual({ review: { new_per_day: 6 }, modules: { review: { enabled: true } } });
      expect(legacyEnabled((await schema(reading))?.behaviour, "read_later")).toBe(true);
      expect(await schema(reading)).toMatchObject({ publish_collection: false, slug: `module-${reading}` });
      expect((await schema(review))?.publish_collection).toBeUndefined();
      expect(legacyEnabled((await schema(inactiveReading))?.behaviour, "read_later")).toBe(false);
      expect((await events(reading)).at(-1)).toMatchObject({ event_type: "TAG_MODULES_MIGRATED" });
      expect((await db.q("SELECT 1 FROM node_tags WHERE node_id=$1 AND tag_id=$2", [member,reading])).rows).toHaveLength(1);
      const eventCount = (await events(reading)).length;
      await db.q(readFileSync(new URL("../../db/migrations/083_tag_module_bindings.sql", import.meta.url), "utf8"));
      expect(await events(reading)).toHaveLength(eventCount);
      throw rollback;
    })).rejects.toBe(rollback);
  });

  it("rolls back schema and success history when the encompassing operation fails", async () => {
    const tagId = await plainTag();
    const failure = new Error("injected outer failure");
    await expect(db.withTransaction(async () => {
      await setTagModules({ actor: owner, workspaceId, tagId, modules: { review: true } });
      throw failure;
    })).rejects.toBe(failure);
    expect(await schema(tagId)).toBeNull();
    expect(await events(tagId)).toHaveLength(0);
  });
});
