// A bookmark or a canvas is a note, so its history undoes like a note's:
//   * undoing BOOKMARK_CREATED or CANVAS_CREATED moves it to the trash (both
//     answered 422 "unsupported" before);
//   * deleting a canvas is a NODE_DELETED from the one trash path, so undoing
//     it brings the board back; an older CANVAS_DELETED undoes the same way.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { q, event } from "../db.js";
import { apiOnError } from "../httpError.js";
import bookmarkRouter from "../routes/bookmark.js";
import canvasesRouter from "../routes/canvases.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { persistActor } from "./helpers/persistActor.js";
import { eventActorType, type ActorCtx } from "../types.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";

let workspaceId = "";
let actor: ActorCtx = { id: "history-editor", name: "Editor", role: "editor", type: "human" };
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/bookmark", bookmarkRouter);
app.route("/api/canvases", canvasesRouter);

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const trashed = async (id: string) =>
  (await q<{ deleted_at: string | null }>("SELECT deleted_at FROM content_nodes WHERE id=$1", [id])).rows[0]!.deleted_at !== null;
const lastEvent = async (target: string) =>
  (await q<{ id: string; event_type: string; ui: string | null }>(
    `SELECT id::text, event_type, tx_meta->>'ui_context' AS ui FROM domain_events WHERE target_id=$1 ORDER BY domain_events.id DESC LIMIT 1`, [target])).rows[0]!;
const undo = (eventId: string) => restoreEvent(eventId, { actor, workspaceId });

describe.skipIf(!isTestDatabase())("bookmark and canvas history undoes like a note's", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('history',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  it("undoing a bookmark's creation moves it to the trash", async () => {
    const res = await post("/api/bookmark", { url: "http://127.0.0.1:9/a" });
    expect(res.status).toBe(201);
    const { id } = await res.json() as { id: string };
    // Its bookmark_url is an ATTRIBUTE_SET chained to the creation since W28.
    const created = (await q<{ id: string; event_type: string }>(
      `SELECT id::text, event_type FROM domain_events WHERE target_id=$1 AND event_type='BOOKMARK_CREATED'`, [id])).rows[0]!;
    expect(created.event_type).toBe("BOOKMARK_CREATED");
    expect(await undo(created.id)).toMatchObject({ restored: true });
    expect(await trashed(id)).toBe(true);
  });

  it("undoing a canvas's creation moves it to the trash", async () => {
    const id = randomUUID();
    expect((await post("/api/canvases", { id, title: "Board" })).status).toBe(201);
    const created = await lastEvent(id);
    expect(created.event_type).toBe("CANVAS_CREATED");
    expect(await undo(created.id)).toMatchObject({ restored: true });
    expect(await trashed(id)).toBe(true);
  });

  it("a deleted canvas is a NODE_DELETED that undoes", async () => {
    const id = randomUUID();
    expect((await post("/api/canvases", { id, title: "Plan" })).status).toBe(201);
    expect((await app.request(`/api/canvases/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await trashed(id)).toBe(true);
    const deleted = await lastEvent(id);
    expect(deleted).toMatchObject({ event_type: "NODE_DELETED", ui: "canvas.delete" });
    expect(await undo(deleted.id)).toMatchObject({ restored: true });
    expect(await trashed(id)).toBe(false);
    // Deleting it again stays idempotent once it is gone.
    expect((await app.request(`/api/canvases/${randomUUID()}`, { method: "DELETE" })).status).toBe(200);
  });

  it("an older CANVAS_DELETED undoes the same way", async () => {
    const id = randomUUID();
    expect((await post("/api/canvases", { id, title: "Old" })).status).toBe(201);
    // As the canvas route recorded deletes before it used the trash path.
    const eventId = await event(workspaceId, "CANVAS_DELETED", "canvas", id, { title: "Old" }, eventActorType(actor.type), actor.id,
      { txMeta: { ui_context: "canvas.delete" } });
    await seedQ(`UPDATE content_nodes SET deleted_at = now(), deleted_by_event_id = $2 WHERE id = $1`, [id, eventId]);
    expect(await undo(eventId)).toMatchObject({ restored: true });
    expect(await trashed(id)).toBe(false);
  });
});
