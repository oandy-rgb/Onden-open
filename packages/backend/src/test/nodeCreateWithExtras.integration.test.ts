// A note can be created with its first tags and attributes in ONE request.
// They share the node's event transaction: on success the note, membership and
// values all exist (with their events); any refusal — a space the actor may
// not write in, an invalid field value, a reserved key — leaves no note behind.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";

let workspaceId = "";
let actor: ActorCtx = { id: "create-extras-editor", name: "Editor", role: "editor", type: "human" };
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/nodes", nodesRouter);

function create(body: Record<string, unknown>) {
  return app.request("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function exists(id: string) {
  return (await q("SELECT 1 FROM content_nodes WHERE id=$1", [id])).rows.length > 0;
}

describe.skipIf(!isTestDatabase())("create a note with its first tags and attributes", () => {
  let tagId = "", viewOnlySpace = "";
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('create extras',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
    tagId = (await seedClassTag(workspaceId, { name: `Task ${randomUUID()}`, nodeSlug: randomUUID(),
      fields: [{ name: "stage", type: "select", options: ["todo", "done"] }] })).tagId;
    viewOnlySpace = await makeSpace(workspaceId, `View only ${randomUUID()}`, [{ id: actor.id, role: "viewer" }]);
  });
  afterAll(async () => { await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [workspaceId]); });

  it("creates the note, its tag and its values in one transaction, events linked to the creation", async () => {
    const id = randomUUID();
    const res = await create({ id, title: "Row", tag_ids: [tagId], attributes: [{ key: "stage", value: "todo" }, { key: "sketch_data", value: "{}" }] });
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await q("SELECT tag_id FROM node_tags WHERE node_id=$1", [id])).rows).toEqual([{ tag_id: tagId }]);
    expect((await q<{ key: string; value: string }>("SELECT key,value FROM node_attributes WHERE node_id=$1 ORDER BY key", [id])).rows)
      .toEqual([{ key: "sketch_data", value: "{}" }, { key: "stage", value: "todo" }]);
    const events = (await q<{ event_type: string; id: string; triggered_by_event_id: string | null }>(
      "SELECT event_type, id::text, triggered_by_event_id::text FROM domain_events WHERE target_id=$1 ORDER BY domain_events.id", [id])).rows;
    expect(events.map((e) => e.event_type)).toEqual(["NODE_CREATED", "TAG_APPLIED", "ATTRIBUTE_SET", "ATTRIBUTE_SET"]);
  });

  it("an attribute the tag's schema refuses leaves no note (422)", async () => {
    const id = randomUUID();
    const res = await create({ id, title: "Bad row", tag_ids: [tagId], attributes: [{ key: "stage", value: "nope" }] });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("field_invalid");
    expect(await exists(id)).toBe(false);
  });

  it("a space the actor may only view leaves no note (403)", async () => {
    const id = randomUUID();
    const res = await create({ id, title: "Locked row", space_id: viewOnlySpace, tag_ids: [tagId], attributes: [{ key: "stage", value: "todo" }] });
    expect(res.status).toBe(403);
    expect(await exists(id)).toBe(false);
  });

  it("a reserved attribute key or an unknown tag leaves no note", async () => {
    const reserved = randomUUID();
    expect((await create({ id: reserved, title: "R", attributes: [{ key: "_import_path", value: "x" }] })).status).toBe(400);
    expect(await exists(reserved)).toBe(false);
    const unknown = randomUUID();
    expect((await create({ id: unknown, title: "U", tag_ids: [randomUUID()] })).status).toBe(404);
    expect(await exists(unknown)).toBe(false);
  });

  it("a plain create is unchanged", async () => {
    const id = randomUUID();
    expect((await create({ id, title: "Plain" })).status).toBe(201);
    expect((await q("SELECT 1 FROM node_attributes WHERE node_id=$1", [id])).rows).toEqual([]);
  });
});
