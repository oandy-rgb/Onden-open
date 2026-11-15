// Every way of making a note goes through services/noteCreate.ts, so a
// bookmark, a canvas or a database import row now gets what a note from the editor
// gets: the creator's personal space by default, a named space only where the
// creator may write, and the backup and search-index intents in the creation
// transaction (before, these paths got neither and could not name a space).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import bookmarkRouter from "../routes/bookmark.js";
import canvasesRouter from "../routes/canvases.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import type { ActorCtx } from "../types.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";
import { holderViewsSql } from "../services/functionRefSql.js";

let workspaceId = "";
let actor: ActorCtx = { id: "note-create-editor", name: "Editor", role: "editor", type: "human" };
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/bookmark", bookmarkRouter);
app.route("/api/canvases", canvasesRouter);
// The search embedding is the semantic module's content hook.
registerShippedModules();

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
// A loopback address: safeFetch refuses it at once, so the title falls back to
// the host name without a network call.
const URL_ = "http://127.0.0.1:9/article";

const spaceOf = async (id: string) =>
  (await q<{ space_id: string }>("SELECT space_id::text FROM content_nodes WHERE id=$1", [id])).rows[0]?.space_id;
/** The outbox intents the note's creation event enqueued. */
const intents = async (id: string) =>
  (await q<{ effect_kind: string }>(
    `SELECT o.effect_kind FROM outbox o JOIN domain_events e ON e.id = o.triggered_by_event_id
      WHERE e.target_id = $1 ORDER BY o.effect_kind`, [id])).rows.map((r) => r.effect_kind);

describe.skipIf(!isTestDatabase())("notes made by any path get the create contract", () => {
  let personal = "", shared = "", viewOnly = "";
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('note create',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    await setModulesOn(workspaceId, null);
    actor = await persistActor(workspaceId, actor);
    personal = (await q<{ id: string }>(
      "SELECT id::text FROM spaces WHERE workspace_id=$1 AND kind='personal' AND owner_actor_id=$2", [workspaceId, actor.id])).rows[0]!.id;
    shared = await makeSpace(workspaceId, `Lab ${randomUUID()}`, [{ id: actor.id, role: "editor" }]);
    viewOnly = await makeSpace(workspaceId, `Read only ${randomUUID()}`, [{ id: actor.id, role: "viewer" }]);
  });
  afterAll(async () => { await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [workspaceId]); });

  it("a bookmark lands in the creator's space with its backup and index intents", async () => {
    const res = await post("/api/bookmark", { url: URL_ });
    expect(res.status, await res.clone().text()).toBe(201);
    const { id } = await res.json() as { id: string };
    expect(await spaceOf(id)).toBe(personal);
    expect(await intents(id)).toEqual(expect.arrayContaining(["embed", "git_commit"]));
    expect((await q("SELECT value FROM node_attributes WHERE node_id=$1 AND key='bookmark_url'", [id])).rows).toEqual([{ value: URL_ }]);
    // The creation, and its bookmark_url as an attribute change chained to it.
    expect((await q("SELECT event_type, payload->>'key' AS key FROM domain_events WHERE target_id=$1 ORDER BY id", [id])).rows)
      .toEqual([{ event_type: "BOOKMARK_CREATED", key: null }, { event_type: "ATTRIBUTE_SET", key: "bookmark_url" }]);
  });

  it("a bookmark or canvas goes to a named space only where the creator may write", async () => {
    const bookmark = await post("/api/bookmark", { url: URL_, space_id: shared });
    expect(bookmark.status).toBe(201);
    expect(await spaceOf(((await bookmark.json()) as { id: string }).id)).toBe(shared);

    const canvasId = randomUUID();
    expect((await post("/api/canvases", { id: canvasId, title: "Board", space_id: shared })).status).toBe(201);
    expect(await spaceOf(canvasId)).toBe(shared);

    const refusedId = randomUUID();
    expect((await post("/api/canvases", { id: refusedId, title: "Nope", space_id: viewOnly })).status).toBe(403);
    expect(await spaceOf(refusedId)).toBeUndefined();
  });

  it("a canvas is a plain note with its whiteboard tab and gets the backup intent", async () => {
    const id = randomUUID();
    const res = await post("/api/canvases", { id, title: "Plan" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id, title: "Plan" });
    const made = (await q(`SELECT node_type, ${holderViewsSql("content_nodes")} AS collection_views FROM content_nodes WHERE id=$1`, [id])).rows;
    expect(made).toMatchObject([{ node_type: "content", collection_views: [{ layout: "canvas", layout_config: { opens_first: true } }] }]);
    expect(await spaceOf(id)).toBe(personal);
    expect(await intents(id)).toContain("git_commit");
  });
});
