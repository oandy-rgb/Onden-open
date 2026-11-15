// A note's 「手寫」 tab (modules/handwriting): a stored view of layout "handwriting"; its strokes are the note's own
// attribute `note_ink`, so the tab can come and go without touching them. Through the routes, like noteViews.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { encodeInk, type InkDocument } from "@onden/markdown/ink";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import { inkEventSql } from "../services/history/bodyEvents.js";
import { getNodeTool } from "../services/agentTools/getNode.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));

let owner: ActorCtx = { id: "hw-owner", name: "Owner", role: "admin", type: "human" };
let viewer: ActorCtx = { id: "hw-viewer", name: "Viewer", role: "editor", type: "human" };
let current: ActorCtx = owner;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", current); await next(); });
app.route("/api/nodes", nodesRouter);

const json = { "content-type": "application/json" };
const as = (actor: ActorCtx) => { current = actor; };
type View = { id: string; name: string; layout: string };
const views = async (id: string) => ((await (await app.request(`/api/nodes/${id}/views`)).json()) as { views: View[] }).views;
const addTab = (id: string) => app.request(`/api/nodes/${id}/views`, { method: "POST", headers: json, body: JSON.stringify({ name: "Handwriting", layout: "handwriting" }) });
const removeTab = (id: string, viewId: string) => app.request(`/api/nodes/${id}/views/${viewId}`, { method: "DELETE" });
const putAttr = (id: string, key: string, value: string) =>
  app.request(`/api/nodes/${id}/attributes/${key}`, { method: "PUT", headers: json, body: JSON.stringify({ value, value_type: "text" }) });
const attr = async (id: string, key: string) =>
  (await seedQ<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [id, key])).rows[0]?.value ?? null;

const drawing = (...strokeIds: string[]): string => encodeInk({
  version: 1, erased: {}, page: { width: 1000 },
  strokes: strokeIds.map((id) => ({ id, points: [[0, 0], [10, 10]], color: "#112233", size: 2, toolId: "pen" })),
} as InkDocument);

describe.skipIf(!isTestDb)("a note's 手寫 tab (DB)", () => {
  let space = "";
  async function note(markdown = "Some text"): Promise<string> {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Lecture',$2,$3) RETURNING id::text`, [workspaceId, `hw-${randomUUID().slice(0, 8)}`, markdown])).rows[0]!.id;
    await putInSpace(id, space);
    return id;
  }

  beforeAll(async () => {
    registerShippedModules();
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Handwriting tab',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    viewer = await persistActor(workspaceId, viewer);
    owner = await persistActor(workspaceId, owner);
    space = await makeSpace(workspaceId, `hw-${randomUUID()}`, [{ id: owner.id, role: "manager" }, { id: viewer.id, role: "viewer" }]);
  });

  it("any note takes the tab; the strokes are the note's attribute and the text stays its content", async () => {
    const id = await note("Plain words");
    as(owner);
    expect((await addTab(id)).status).toBe(201);
    expect((await views(id)).map((v) => v.layout)).toEqual(["handwriting"]);
    expect((await putAttr(id, "note_ink", drawing("a", "b"))).status).toBeLessThan(300);
    expect(await attr(id, "note_ink")).toContain("\"a\"");
    // Neither side touched the other: the text is as it was and the content tab is not turned into a handwriting page.
    const row = (await seedQ<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!;
    expect(row.markdown).toBe("Plain words");
    expect(await attr(id, "ink_data")).toBeNull();
  });

  it("taking the tab off leaves the strokes; adding it again shows them", async () => {
    const id = await note();
    as(owner);
    const tab = (await ((await addTab(id)).json()) as { id: string }).id;
    await putAttr(id, "note_ink", drawing("kept"));
    expect((await removeTab(id, tab)).status).toBeLessThan(300);
    expect(await views(id)).toEqual([]);
    expect(await attr(id, "note_ink")).toContain("kept");
    expect((await addTab(id)).status).toBe(201);
    expect(await attr(id, "note_ink")).toContain("kept");
  });

  it("a copy carries the tab with the strokes", async () => {
    const id = await note();
    as(owner);
    await addTab(id);
    await putAttr(id, "note_ink", drawing("copied"));
    const copy = (await ((await app.request(`/api/nodes/${id}/duplicate`, { method: "POST", headers: json, body: "{}" })).json()) as { id: string }).id;
    expect(await attr(copy, "note_ink")).toContain("copied");
    expect((await views(copy)).map((v) => v.layout)).toEqual(["handwriting"]);
  });

  it("a viewer of the space sees the strokes but cannot write them or change the tab", async () => {
    const id = await note();
    as(owner);
    const tab = (await ((await addTab(id)).json()) as { id: string }).id;
    await putAttr(id, "note_ink", drawing("mine"));
    as(viewer);
    expect((await views(id)).map((v) => v.layout)).toEqual(["handwriting"]);
    const read = await app.request(`/api/nodes/${id}/attributes?keys=note_ink`);
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).toContain("mine");
    expect((await putAttr(id, "note_ink", drawing("theirs"))).status).toBeGreaterThanOrEqual(400);
    expect((await removeTab(id, tab)).status).toBeGreaterThanOrEqual(400);
    expect(await attr(id, "note_ink")).not.toContain("theirs");
  });

  it("a save is history of kind 'note', not of the handwriting page or the board", async () => {
    const id = await note();
    as(owner);
    await putAttr(id, "note_ink", drawing("h1"));
    const count = async (kind: "note" | "handwriting" | "board") => Number((await seedQ<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_events e WHERE e.target_id = $1 AND ${inkEventSql("e", kind)}`, [id])).rows[0]!.n);
    expect(await count("note")).toBe(1);
    expect(await count("handwriting")).toBe(0);
    expect(await count("board")).toBe(0);
  });

  it("an agent's getNode never carries the strokes (megabytes of JSON) of a note's 手寫 tab", async () => {
    const id = await note("Words");
    as(owner);
    await putAttr(id, "note_ink", drawing("big"));
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1,$2,'topic','math','text')`, [workspaceId, id]);
    const result = await getNodeTool.handler({ id }, { workspaceId, actor: owner } as never);
    expect(result?.attributes.map((a) => a.key)).toEqual(["topic"]);
    expect(getNodeTool.description).toMatch(/Drawing data/);
  });
});
