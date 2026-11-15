// /api/canvases after W23: the layout is written only through PATCH
// /api/boards/:id (changes, not a document). A whole-document `data` PATCH —
// an old client's save, or a stale offline queue replaying one — used to
// delete every placement and re-insert its own; it is now refused (410) and
// the layout stays as it was. GET still reconstructs {data:{nodes, sections}}
// from node_positions + the sections attribute, and DELETE tombstones.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import canvasRouter from "../routes/canvases.js";
import boardsRouter from "../routes/boards.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";
import { holderViewsSql } from "../services/functionRefSql.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/canvases", canvasRouter);
app.route("/api/boards", boardsRouter);

const patch = (id: string, body: unknown) =>
  app.request(`/api/canvases/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patchBoard = (id: string, body: unknown) =>
  app.request(`/api/boards/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const positions = async (canvasId: string) =>
  (await q<{ node_id: string; x: number; y: number; width: number | null; folded: boolean }>(
    `SELECT node_id, x, y, width, folded FROM node_positions WHERE surface = $1`, [canvasId],
  )).rows;

describe.skipIf(!isTestDb)("canvas routes over the board store (DB)", () => {
  let workspaceId: string;
  let realNodeId: string;
  let canvasId: string;

  beforeAll(async () => {
    const ws = await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Test','default')
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    );
    workspaceId = ws.rows[0]!.id;
    const n = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Pos',$2,'x') RETURNING id`,
      [workspaceId, `canvas-pos-${Date.now()}`],
    );
    realNodeId = n.rows[0]!.id;
    currentActor = { id: randomUUID(), name: "Editor", role: "editor", type: "human" };
    // Seed the injected actor as a real row: migration 071's weak FK rejects a
    // uuid-shaped actor_id that resolves to no actor when this editor writes.
    await q(
      `INSERT INTO actors (id, workspace_id, name, type) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING`,
      [currentActor.id, workspaceId, currentActor.name, currentActor.type],
    );
    await joinDefaultSpace(workspaceId, currentActor.id, currentActor.role); // membership is explicit (097)
  });
  // A canvas per test: the DELETE test's tombstone and the layout another
  // test wrote are never this test's starting point.
  beforeEach(async () => {
    canvasId = (await (await app.request("/api/canvases", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Pos" }),
    })).json()).id;
  });

  it("a whole-document layout PATCH is refused (410) and the layout stays; a title PATCH still works", async () => {
    expect((await patchBoard(canvasId, { cards: { upsert: [{ nodeId: realNodeId, x: 10, y: 20, width: 300 }] } })).status).toBe(200);
    // The old whole-document shape, in both card forms a stale queue could hold.
    for (const nodes of [
      [{ id: "rf1", type: "note", position: { x: 1, y: 1 }, data: { nodeId: realNodeId } }],
      [{ nodeId: realNodeId, x: 2, y: 2 }],
      [],
    ]) {
      const res = await patch(canvasId, { data: { nodes } });
      expect(res.status).toBe(410);
      expect((await res.json()).detail).toContain("/api/boards");
    }
    const rows = await positions(canvasId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ node_id: realNodeId, x: 10, y: 20, width: 300 });
    expect((await patch(canvasId, { title: "Pos" })).status).toBe(200);
  });

  it("GET reconstructs {data:{nodes, sections}} from node_positions + the sections attribute", async () => {
    const sections = [{ id: "s1", x: 0, y: 0, width: 500, height: 400, title: "Zone" }];
    expect((await patchBoard(canvasId, {
      cards: { upsert: [{ nodeId: realNodeId, x: 9, y: 8, height: 120, subCanvasId: canvasId }] },
      sections: { upsert: sections },
    })).status).toBe(200);
    const res = await app.request(`/api/canvases/${canvasId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Pos");
    expect(body.data.nodes).toEqual([
      { nodeId: realNodeId, x: 9, y: 8, height: 120, subCanvasId: canvasId },
    ]);
    expect(body.data.sections).toEqual(sections);
  });

  it("scan 08 #4: a frame is patched by field: a rename and a resize from two devices both stay", async () => {
    const frame = { id: "sec-fields", x: 0, y: 0, width: 400, height: 300, title: "Group" };
    expect((await patchBoard(canvasId, { sections: { upsert: [frame] } })).status).toBe(200);
    // Device A (stale: it still thinks the frame is 400 wide) only renames; device B resizes.
    expect((await patchBoard(canvasId, { sections: { upsert: [{ id: frame.id, width: 700, height: 500 }] } })).status).toBe(200);
    expect((await patchBoard(canvasId, { sections: { upsert: [{ id: frame.id, title: "Renamed" }] } })).status).toBe(200);
    const body = await (await app.request(`/api/canvases/${canvasId}`)).json();
    expect(body.data.sections.find((x: { id: string }) => x.id === frame.id)).toEqual({ ...frame, width: 700, height: 500, title: "Renamed" });
    // A patch for a frame that is gone is dropped, not revived without a size.
    expect((await patchBoard(canvasId, { sections: { remove: [frame.id] } })).status).toBe(200);
    expect((await patchBoard(canvasId, { sections: { upsert: [{ id: frame.id, title: "Late rename" }] } })).status).toBe(200);
    const after = await (await app.request(`/api/canvases/${canvasId}`)).json();
    expect((after.data.sections ?? []).some((x: { id: string }) => x.id === frame.id)).toBe(false);
  });

  it("DELETE soft-deletes the canvas node; the list and GET stop serving it", async () => {
    expect((await patchBoard(canvasId, { cards: { upsert: [{ nodeId: realNodeId, x: 3, y: 4 }] } })).status).toBe(200);
    const del = await app.request(`/api/canvases/${canvasId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await app.request(`/api/canvases/${canvasId}`)).status).toBe(404);
    const list = await (await app.request("/api/canvases")).json();
    expect((list as Array<{ id: string }>).some((row) => row.id === canvasId)).toBe(false);
    // The tombstone (not a hard delete) keeps layout for a future undelete.
    const tomb = await q<{ deleted_at: string | null; node_type: string; collection_views: Array<{ layout: string }> }>(
      `SELECT deleted_at, node_type, ${holderViewsSql("content_nodes")} AS collection_views FROM content_nodes WHERE id = $1`, [canvasId],
    );
    // A canvas is a note with a whiteboard tab (migration 138); the tab goes to the trash with it.
    expect(tomb.rows[0]!.node_type).toBe("content");
    expect(tomb.rows[0]!.collection_views.map((view) => view.layout)).toEqual(["canvas"]);
    expect(tomb.rows[0]!.deleted_at).not.toBeNull();
    expect((await positions(canvasId)).length).toBe(1);
  });
});
