// /api/boards — board layouts saved as changes (routes/boards.ts).
//
//   • GAP-178: a PATCH that names card B must leave card A (added by another
//     device) where it is; the old whole-document save erased it.
//   • sections merge by id the same way.
//   • GAP-256: a card whose note the caller cannot read is neither listed
//     (by /api/boards or /api/canvases) nor movable/removable by them.
//   • a tag (class_tag node) is a board too — its canvas lens — and laying it
//     out does not touch the tag's own row.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { adminOnlySpace, joinDefaultSpace, putInSpace } from "./helpers/spaceFixtures.js";
import boardsRouter from "../routes/boards.js";
import canvasRouter from "../routes/canvases.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/boards", boardsRouter);
app.route("/api/canvases", canvasRouter);

// Fresh ids per run: the shared test database keeps earlier runs' actors.
const editor: ActorCtx = { id: randomUUID(), name: "Editor", role: "editor", type: "human" };
const admin: ActorCtx = { id: randomUUID(), name: "Admin", role: "admin", type: "human" };

const json = { "content-type": "application/json" };
const patch = (id: string, body: unknown) =>
  app.request(`/api/boards/${id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });
const board = async (id: string) =>
  (await (await app.request(`/api/boards/${id}`)).json()) as {
    kind: string;
    cards: Array<{ nodeId: string; x: number; y: number; color?: string }>;
    sections: Array<{ id: string; title?: string; x: number }>;
  };

describe.skipIf(!isTestDb)("board layout saved as changes (DB)", () => {
  let WS = "";
  const stamp = Date.now();
  let defaultSpace = "";
  let a = "", b = "", hidden = "";

  const note = async (title: string) => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$2,'') RETURNING id`, [WS, `${title}-${stamp}`])).rows[0]!.id;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    for (const actor of [editor, admin]) {
      await q(`INSERT INTO actors (id, workspace_id, name, type) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [actor.id, WS, actor.name, actor.type]);
      await joinDefaultSpace(WS, actor.id, actor.role); // membership is explicit (097)
    }
    a = await note("board-a");
    b = await note("board-b");
    hidden = await note("board-hidden");
    // The hidden note lives in a space only the admin belongs to.
    await putInSpace(hidden, await adminOnlySpace(WS, `board-lock-${stamp}`, [admin.id]));
    defaultSpace = (await q<{ id: string }>(`SELECT id FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
  });

  // Each test lays out a board of its own, so none sees another's cards.
  let boards = 0;
  async function newBoard(): Promise<string> {
    currentActor = editor;
    const id = (await (await app.request("/api/canvases", {
      method: "POST", headers: json, body: JSON.stringify({ title: `Board ${stamp} ${++boards}` }),
    })).json()).id as string;
    // A top-level create lands in the editor's personal space; share the board
    // through the default space so the admin can lay it out too.
    await putInSpace(id, defaultSpace);
    return id;
  }

  it("a change to one card leaves the cards it does not name alone (GAP-178)", async () => {
    const canvasId = await newBoard();
    expect((await patch(canvasId, { cards: { upsert: [{ nodeId: a, x: 10, y: 10 }] } })).status).toBe(200);
    // Another device, whose copy never saw A, adds B.
    expect((await patch(canvasId, { cards: { upsert: [{ nodeId: b, x: 400, y: 10 }] } })).status).toBe(200);
    // The first device moves A from its old copy.
    expect((await patch(canvasId, { cards: { upsert: [{ nodeId: a, x: 50, y: 60, color: "red" }] } })).status).toBe(200);
    const cards = (await board(canvasId)).cards;
    expect(cards.find((c) => c.nodeId === a)).toMatchObject({ x: 50, y: 60, color: "red" });
    expect(cards.find((c) => c.nodeId === b)).toMatchObject({ x: 400, y: 10 });
  });

  it("remove takes off only the named card", async () => {
    const canvasId = await newBoard();
    expect((await patch(canvasId, { cards: { upsert: [{ nodeId: a, x: 10, y: 10 }, { nodeId: b, x: 400, y: 10 }] } })).status).toBe(200);
    expect((await patch(canvasId, { cards: { remove: [b] } })).status).toBe(200);
    expect((await board(canvasId)).cards.map((c) => c.nodeId)).toEqual([a]);
  });

  it("sections merge by id", async () => {
    const canvasId = await newBoard();
    await patch(canvasId, { sections: { upsert: [{ id: "s1", title: "One", x: 0, y: 0, width: 100, height: 100 }] } });
    await patch(canvasId, { sections: { upsert: [{ id: "s2", title: "Two", x: 200, y: 0, width: 100, height: 100 }] } });
    await patch(canvasId, { sections: { upsert: [{ id: "s1", title: "Renamed", x: 5, y: 0, width: 100, height: 100 }] } });
    let sections = (await board(canvasId)).sections;
    expect(sections.map((s) => [s.id, s.title])).toEqual([["s1", "Renamed"], ["s2", "Two"]]);
    await patch(canvasId, { sections: { remove: ["s1"] } });
    sections = (await board(canvasId)).sections;
    expect(sections.map((s) => s.id)).toEqual(["s2"]);
  });

  it("a hidden card is not listed, and a non-reader cannot move or remove it (GAP-256)", async () => {
    const canvasId = await newBoard();
    currentActor = admin;
    expect((await patch(canvasId, { cards: { upsert: [{ nodeId: hidden, x: 1, y: 2 }] } })).status).toBe(200);
    expect((await board(canvasId)).cards.some((c) => c.nodeId === hidden)).toBe(true);

    currentActor = editor;
    expect((await board(canvasId)).cards.some((c) => c.nodeId === hidden)).toBe(false);
    const legacy = (await (await app.request(`/api/canvases/${canvasId}`)).json()) as { data: { nodes: Array<{ nodeId: string }> } };
    expect(legacy.data.nodes.some((c) => c.nodeId === hidden)).toBe(false);

    await patch(canvasId, { cards: { upsert: [{ nodeId: hidden, x: 999, y: 999 }], remove: [hidden] } });
    const row = await q<{ x: number }>(`SELECT x FROM node_positions WHERE surface = $1 AND node_id = $2`, [canvasId, hidden]);
    expect(row.rows[0]?.x).toBe(1);

    // An older client's whole-board save lists only what it could read; it is
    // refused outright now (410, W23), so the hidden card survives it.
    expect((await app.request(`/api/canvases/${canvasId}`, {
      method: "PATCH", headers: json, body: JSON.stringify({ data: { nodes: legacy.data.nodes } }),
    })).status).toBe(410);
    const kept = await q<{ x: number }>(`SELECT x FROM node_positions WHERE surface = $1 AND node_id = $2`, [canvasId, hidden]);
    expect(kept.rows[0]?.x).toBe(1);
  });

  it("a tag is a board; laying it out leaves the tag row untouched", async () => {
    const tag = await seedClassTag(WS, { name: `board-tag-${stamp}` });
    const before = (await q<{ updated_at: string }>(`SELECT updated_at FROM content_nodes WHERE id = $1`, [tag.tagId])).rows[0]!.updated_at;
    currentActor = editor;
    expect((await patch(tag.tagId, { cards: { upsert: [{ nodeId: a, x: 7, y: 8 }] } })).status).toBe(200);
    const read = await board(tag.tagId);
    expect(read.kind).toBe("tag");
    expect(read.cards).toEqual([{ nodeId: a, x: 7, y: 8 }]);
    const after = (await q<{ updated_at: string }>(`SELECT updated_at FROM content_nodes WHERE id = $1`, [tag.tagId])).rows[0]!.updated_at;
    expect(String(after)).toBe(String(before));
    const events = await q<{ event_type: string }>(`SELECT event_type FROM domain_events WHERE target_id = $1`, [tag.tagId]);
    expect(events.rows.map((e) => e.event_type)).toContain("BOARD_UPDATED");
  });

  it("any readable note can hold a board (the whiteboard is a view of a note); one the actor cannot read answers 404", async () => {
    currentActor = editor;
    expect(await board(a)).toMatchObject({ kind: "canvas", cards: [], sections: [] });
    expect((await patch(a, { cards: { upsert: [{ nodeId: b, x: 0, y: 0 }] } })).status).toBe(200);
    expect((await board(a)).cards).toEqual([{ nodeId: b, x: 0, y: 0 }]);
    // The board is the note's own: it does not make the note a "canvas" of /api/canvases.
    const listed = (await (await app.request("/api/canvases")).json()) as Array<{ id: string }>;
    expect(listed.map((row) => row.id)).not.toContain(a);
    expect((await app.request(`/api/boards/${hidden}`)).status).toBe(404);
    expect((await patch(hidden, { cards: { upsert: [{ nodeId: b, x: 0, y: 0 }] } })).status).toBe(404);
  });
});
