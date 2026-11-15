// Canvas authorization regression (HIGH bug 2026-06-13) — a canvas IS a node
// (migration 057), so every canvas surface must obey the node read-policy and
// node write authority, NOT a global editor-role check:
//
//   • GET /api/canvases             — listing bounded by the caller's read set
//   • GET /api/canvases/:id         — per-node read gate (canReadNode → 404)
//   • PATCH/DELETE /api/canvases/:id — node write/delete authority (its space)
//   • PUT /api/nodes/:id/position    — moving a card is a write on the node
//
// Before the fix: list/detail returned ALL canvases with no read filter;
// patch/delete used {kind:"role",min:"editor"} (ignored the canvas's tag
// policy); position only called requireActor() (a viewer could move any card).
//
// Seed (spaces model, docs/architecture/spaces.md): a restricted canvas + a
// restricted card in an admin-only space; a public canvas/card in the default
// space. Pin: viewer/editor are blocked on the restricted ones; admin is not.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import { adminOnlySpace, joinDefaultSpace, putInSpace } from "./helpers/spaceFixtures.js";
import canvasRouter from "../routes/canvases.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";
import { holderViewsSql } from "../services/functionRefSql.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the same
// way src/index.ts does (AuthorityError/ScopeError → 403, not Hono's 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/canvases", canvasRouter);
app.route("/api/nodes", nodesRouter);

// Fresh uuids per run, so spine actor lookups never collide across roles or
// with a previous run's rows in the shared database.
const viewer: ActorCtx = { id: randomUUID(), name: "Viewer", role: "viewer", type: "human" };
const editor: ActorCtx = { id: randomUUID(), name: "Editor", role: "editor", type: "human" };
const admin: ActorCtx = { id: randomUUID(), name: "Admin", role: "admin", type: "human" };

const list = async () =>
  (await (await app.request("/api/canvases")).json()) as Array<{ id: string }>;
const detail = (id: string) => app.request(`/api/canvases/${id}`);
const del = (id: string) => app.request(`/api/canvases/${id}`, { method: "DELETE" });
// PUT /position is the global graph's (surface 'graph'); board placements go
// through PATCH /api/boards (W23). The node write authority is the same.
const movePosition = (nodeId: string, surface = "graph") =>
  app.request(`/api/nodes/${nodeId}/position`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surface, x: 42, y: 99 }),
  });

describe.skipIf(!isTestDb)("canvas authorization — surfaces obey node read/write policy (DB)", () => {
  let WS = "";
  let restrictedCanvasId = "";
  let publicCanvasId = "";
  let restrictedCardId = "";
  let publicCardId = "";
  // A canvas in the admin-only space; (d) deletes its own.
  let restrictedCanvas: () => Promise<string>;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    // Seed the injected actors as real rows: migration 071's weak FK rejects a
    // uuid-shaped actor_id that resolves to no actor when these write events.
    // Admin first: on a workspace with no owner (a database this file runs
    // against alone) the first human inserted becomes the owner and edits the
    // default space (actors_sync_spaces), which would make the "viewer" an
    // editor before joinDefaultSpace's DO NOTHING could give it 'view'.
    for (const a of [admin, viewer, editor]) {
      await q(
        `INSERT INTO actors (id, workspace_id, name, type) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO NOTHING`,
        [a.id, WS, a.name, a.type],
      );
      if (a === admin) await setWorkspaceOwner(WS, a.id);
      await joinDefaultSpace(WS, a.id, a.role); // membership is explicit (097)
    }
    const stamp = Date.now();

    // An admin-only space: only the admin may read or write what is in it.
    const secretSpace = await adminOnlySpace(WS, `ca-secret-${stamp}`, [admin.id]);

    const mkCanvas = async (suffix: string) => (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','canvas','Canvas ${suffix} ${stamp}','canvas-${suffix}-${stamp}','') RETURNING id`,
      [WS])).rows[0]!.id;
    const mkCard = async (suffix: string) => (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Card ${suffix} ${stamp}','card-${suffix}-${stamp}','body') RETURNING id`,
      [WS])).rows[0]!.id;

    restrictedCanvasId = await mkCanvas("restricted");
    publicCanvasId = await mkCanvas("public");
    restrictedCardId = await mkCard("restricted");
    publicCardId = await mkCard("public");

    let canvases = 0;
    restrictedCanvas = async () => {
      const id = await mkCanvas(`restricted${++canvases}`);
      await putInSpace(id, secretSpace);
      return id;
    };

    // Only the restricted pair goes into the admin-only space.
    await putInSpace(restrictedCanvasId, secretSpace);
    await putInSpace(restrictedCardId, secretSpace);
  });

  it("offline-parity: POST /api/canvases honors a client-supplied canvas id", async () => {
    currentActor = admin;
    const clientId = randomUUID(); // a fresh v4 id, as an offline client mints
    const res = await app.request("/api/canvases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: clientId, title: "Offline board" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string };
    // The server used the client's id verbatim → an offline-created canvas
    // reconciles by id on reconnect, no server-minted duplicate.
    expect(body.id).toBe(clientId);
    // The whiteboard is a view of a note (migration 138): a plain note that
    // opens on its whiteboard tab, written with the note itself.
    const row = await q<{ node_type: string; collection_views: Array<{ layout: string; layout_config: Record<string, unknown> }> }>(
      `SELECT node_type, ${holderViewsSql("content_nodes")} AS collection_views FROM content_nodes WHERE id = $1 AND workspace_id = $2`, [clientId, WS]);
    expect(row.rows[0]?.node_type).toBe("content");
    expect(row.rows[0]?.collection_views).toMatchObject([{ layout: "canvas", layout_config: { opens_first: true } }]);
  });

  it("(a) a viewer cannot move a restricted card via PUT /position → 403; the public card is fine", async () => {
    currentActor = viewer;
    // The restricted card is in a space the viewer is not in → write_node
    // denies the viewer. This was the hole that mattered: the position route used to take
    // ZERO authority, so a viewer could move ANY card incl. policy-restricted
    // ones. It now flows through node write_node authority.
    expect((await movePosition(restrictedCardId)).status).toBe(403);
    // A default-space viewer is read-only there: even a public card is not
    // movable by one. An editor moves it.
    expect((await movePosition(publicCardId)).status).toBe(403);
    currentActor = editor;
    expect((await movePosition(publicCardId)).status).toBe(200);
    // A board surface is not this route's: it would skip the board's check.
    expect((await movePosition(publicCardId, publicCanvasId)).status).toBe(400);
  });

  it("(b) a restricted canvas is absent from GET /api/canvases and 404s on detail for a non-admin", async () => {
    currentActor = editor;
    const rows = await list();
    expect(rows.some((r) => r.id === publicCanvasId)).toBe(true);
    expect(rows.some((r) => r.id === restrictedCanvasId)).toBe(false);
    expect((await detail(restrictedCanvasId)).status).toBe(404);
    // The editor CAN read the public canvas.
    expect((await detail(publicCanvasId)).status).toBe(200);
  });

  it("(c) a non-admin editor cannot DELETE a policy-restricted canvas → 403", async () => {
    currentActor = editor;
    expect((await del(restrictedCanvasId)).status).toBe(403);
    // Still present (not soft-deleted) after the rejected delete.
    const row = await q<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM content_nodes WHERE id = $1`, [restrictedCanvasId]);
    expect(row.rows[0]!.deleted_at).toBeNull();
  });

  it("(d) sanity: an admin lists/reads/moves/deletes the restricted canvas", async () => {
    // Its own canvas: the delete would otherwise take (b)'s and (c)'s.
    const restrictedCanvasId = await restrictedCanvas();
    currentActor = admin;
    // Lists + detail.
    expect((await list()).some((r) => r.id === restrictedCanvasId)).toBe(true);
    expect((await detail(restrictedCanvasId)).status).toBe(200);
    // Moves the restricted card.
    expect((await movePosition(restrictedCardId)).status).toBe(200);
    // Deletes the restricted canvas (soft-delete tombstone).
    expect((await del(restrictedCanvasId)).status).toBe(200);
    const row = await q<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM content_nodes WHERE id = $1`, [restrictedCanvasId]);
    expect(row.rows[0]!.deleted_at).not.toBeNull();
  });
});
