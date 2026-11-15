// Whiteboard review 2026-11-11 (docs/archive/deep-review-board-2026-11-11.md): the places where a board
// meets another feature (trash, purge, move to another space, retry after a lost reply, two devices).
// Each `it.fails` pins a confirmed defect; its name states the behaviour that is right.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { BOARD_CARDS_PER_REQUEST_MAX } from "@onden/markdown";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import boardsRouter from "../routes/boards.js";
import canvasRouter from "../routes/canvases.js";
import nodesRouter from "../routes/nodes.js";
import { purgeDeleted } from "../services/nodeTrash.js";
import { getCanvasMemberships } from "../services/canvasMemberships.js";
import { withIdempotencyKey } from "../spine/mutate.js";
import { joinDefaultSpace, putInSpace, adminOnlySpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import type { ActorCtx } from "../types.js";

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/boards", boardsRouter);
app.route("/api/canvases", canvasRouter);
app.route("/api/nodes", nodesRouter);

const editor: ActorCtx = { id: randomUUID(), name: "Editor", role: "editor", type: "human" };
const viewer: ActorCtx = { id: randomUUID(), name: "Viewer", role: "viewer", type: "human" };
const admin: ActorCtx = { id: randomUUID(), name: "Admin", role: "admin", type: "human" };

const json = { "content-type": "application/json" };
const patch = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`/api/boards/${id}`, { method: "PATCH", headers: { ...json, ...headers }, body: JSON.stringify(body) });
type Card = { nodeId: string; x: number; y: number; width?: number; height?: number; color?: string; folded?: boolean; subCanvasId?: string };
const cardsOf = async (id: string): Promise<Card[]> =>
  ((await (await app.request(`/api/boards/${id}`)).json()) as { cards: Card[] }).cards;

describe.skipIf(!isTestDatabase())("whiteboard × other features (DB)", () => {
  let WS = "";
  let defaultSpace = "";
  const stamp = Date.now();
  let seq = 0;

  const note = async (title = "n") => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$2,'') RETURNING id`, [WS, `${title}-${stamp}-${++seq}`])).rows[0]!.id;
  async function newBoard(): Promise<string> {
    currentActor = editor;
    const res = await app.request("/api/canvases", { method: "POST", headers: json, body: JSON.stringify({ title: `Review ${stamp} ${++seq}` }) });
    const id = ((await res.json()) as { id: string }).id;
    await putInSpace(id, defaultSpace);
    return id;
  }
  const trash = (id: string) => app.request(`/api/nodes/${id}`, { method: "DELETE" });
  const undelete = (id: string) => app.request(`/api/nodes/${id}/undelete`, { method: "POST" });
  const placementRows = async (surface: string) =>
    (await q(`SELECT 1 FROM node_positions WHERE surface = $1`, [surface])).rowCount ?? 0;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    for (const actor of [editor, viewer, admin]) {
      await q(`INSERT INTO actors (id, workspace_id, name, type) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [actor.id, WS, actor.name, actor.type]);
      await joinDefaultSpace(WS, actor.id, actor.role);
    }
    defaultSpace = (await q<{ id: string }>(`SELECT id FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    await setWorkspaceOwner(WS, admin.id); // only an owner purges
  });

  // ── B1 two devices ──────────────────────────────────────────────────────────
  it("a stale device that only moves a card keeps the colour and size another device just gave it", async () => {
    // A card on the wire is the fields that changed: absent ones are left as stored, null clears.
    const board = await newBoard();
    const a = await note();
    await patch(board, { cards: { upsert: [{ nodeId: a, x: 10, y: 10 }] } });
    await patch(board, { cards: { upsert: [{ nodeId: a, x: 10, y: 10, width: 400, height: 300, color: "#ef4444" }] } }); // device B
    await patch(board, { cards: { upsert: [{ nodeId: a, x: 50, y: 60 }] } }); // device A, from the copy it had before
    expect((await cardsOf(board))[0]).toMatchObject({ x: 50, y: 60, width: 400, color: "#ef4444" });
  });

  it("null clears one field and leaves the others; a whole card still sets every field it carries", async () => {
    const board = await newBoard();
    const a = await note();
    await patch(board, { cards: { upsert: [{ nodeId: a, x: 1, y: 2, width: 400, height: 300, color: "#ef4444", folded: true }] } });
    await patch(board, { cards: { upsert: [{ nodeId: a, color: null, folded: false }] } });
    expect((await cardsOf(board))[0]).toMatchObject({ x: 1, y: 2, width: 400, height: 300 });
    expect((await cardsOf(board))[0]!.color ?? null).toBeNull();
    expect((await cardsOf(board))[0]!.folded ?? false).toBe(false);
  });
  it("a change without a position creates no card; a card with both coordinates is created with the fields it names", async () => {
    const board = await newBoard();
    const a = await note();
    const b = await note();
    expect((await patch(board, { cards: { upsert: [{ nodeId: a, color: "#ef4444" }, { nodeId: b, x: 5 }] } })).status).toBe(200);
    expect(await cardsOf(board)).toEqual([]);
    await patch(board, { cards: { upsert: [{ nodeId: a, x: 5, y: 6, color: "#ef4444" }] } });
    expect(await cardsOf(board)).toMatchObject([{ nodeId: a, x: 5, y: 6, color: "#ef4444" }]);
  });
  it("two entries for the same card in one change apply in order, field by field", async () => {
    const board = await newBoard();
    const a = await note();
    await patch(board, { cards: { upsert: [{ nodeId: a, x: 1, y: 1, color: "#111111" }, { nodeId: a, x: 9, y: 9 }] } });
    expect((await cardsOf(board))[0]).toMatchObject({ x: 9, y: 9, color: "#111111" });
  });

  it("property: two devices writing different fields of one card in any order leave each field as its last writer set it", async () => {
    const fields = fc.constantFrom("position", "size", "color", "folded");
    const write = fc.record({ field: fields, n: fc.integer({ min: 1, max: 900 }) });
    await fc.assert(fc.asyncProperty(fc.array(write, { minLength: 2, maxLength: 12 }), async (writes) => {
      const board = await newBoard();
      const a = await note();
      await patch(board, { cards: { upsert: [{ nodeId: a, x: 0, y: 0 }] } });
      const expected: Record<string, unknown> = { x: 0, y: 0 };
      for (const { field, n } of writes) {
        // Each device only names the field it changed, whatever copy it started from.
        const card = field === "position" ? { x: n, y: n + 1 }
          : field === "size" ? { width: n, height: n + 1 }
          : field === "color" ? { color: `#${String(n).padStart(6, "0")}` }
          : { folded: n % 2 === 0 };
        await patch(board, { cards: { upsert: [{ nodeId: a, ...card }] } });
        Object.assign(expected, card);
      }
      const got = (await cardsOf(board))[0]!;
      expect(got).toMatchObject(Object.fromEntries(Object.entries(expected).filter(([, v]) => v !== false)));
      if (expected.folded === false || expected.folded === undefined) expect(got.folded ?? false).toBe(false);
    }), { numRuns: 25 });
  }, 120_000);

  // ── B2 purge ────────────────────────────────────────────────────────────────
  it("purging a note takes its placements on every board with it", async () => {
    const board = await newBoard();
    const a = await note();
    await patch(board, { cards: { upsert: [{ nodeId: a, x: 1, y: 1 }] } });
    await trash(a);
    await purgeDeleted(admin, WS, a);
    expect(await placementRows(board)).toBe(0);
  });
  it("purging a board for good takes the placements of its cards with it", async () => {
    const board = await newBoard();
    const a = await note();
    await patch(board, { cards: { upsert: [{ nodeId: a, x: 1, y: 1 }] } });
    await trash(board);
    await purgeDeleted(admin, WS, board);
    expect(await placementRows(board)).toBe(0);
  });
  it("purging a board clears the sub-board link on cards of other boards that pointed at it", async () => {
    const parent = await newBoard();
    const child = await newBoard();
    const a = await note();
    await patch(parent, { cards: { upsert: [{ nodeId: a, x: 1, y: 1, subCanvasId: child }] } });
    await trash(child);
    await purgeDeleted(admin, WS, child);
    expect((await cardsOf(parent))[0]?.subCanvasId).toBeUndefined();
  });

  // ── trash, undelete, move space ─────────────────────────────────────────────
  it("trash → undelete of a card's note brings the card back where it was; the memberships follow", async () => {
    const board = await newBoard();
    const a = await note();
    await patch(board, { cards: { upsert: [{ nodeId: a, x: 7, y: 9, color: "#22c55e" }] } });
    await trash(a);
    expect(await cardsOf(board)).toEqual([]);
    expect(await getCanvasMemberships(WS, [board])).toEqual([]);
    await undelete(a);
    expect(await cardsOf(board)).toEqual([{ nodeId: a, x: 7, y: 9, color: "#22c55e" }]);
    expect(await getCanvasMemberships(WS, [board, a])).toEqual([expect.objectContaining({ canvas_id: board, node_id: a })]);
  });
  it("trash → undelete of the board keeps its cards and sections", async () => {
    const board = await newBoard();
    const a = await note();
    await patch(board, { cards: { upsert: [{ nodeId: a, x: 7, y: 9 }] }, sections: { upsert: [{ id: "s", title: "S", x: 0, y: 0, width: 5, height: 5 }] } });
    await trash(board);
    expect((await app.request(`/api/boards/${board}`)).status).toBe(404);
    await undelete(board);
    expect(await cardsOf(board)).toHaveLength(1);
    expect(((await (await app.request(`/api/boards/${board}`)).json()) as { sections: unknown[] }).sections).toHaveLength(1);
  });
  it("a card whose note moved into a space the reader is not in is not listed, and not in the memberships", async () => {
    const board = await newBoard();
    const a = await note();
    await patch(board, { cards: { upsert: [{ nodeId: a, x: 1, y: 1 }] } });
    await putInSpace(a, await adminOnlySpace(WS, `review-lock-${stamp}-${++seq}`, [admin.id]));
    currentActor = editor;
    expect(await cardsOf(board)).toEqual([]);
    expect(await getCanvasMemberships(WS, [board])).toEqual([]);
    currentActor = admin;
    expect(await cardsOf(board)).toHaveLength(1); // the placement itself is kept
  });

  // ── retry after a lost reply ────────────────────────────────────────────────
  it("a retry of a board change with the same Idempotency-Key does not put an old position over a newer one", async () => {
    const board = await newBoard();
    const a = await note();
    const key = randomUUID();
    const send = (x: number, headers: Record<string, string> = {}) =>
      withIdempotencyKey(key, () => patch(board, { cards: { upsert: [{ nodeId: a, x, y: x }] } }, headers));
    expect((await send(1) as Response).status).toBe(200);
    await patch(board, { cards: { upsert: [{ nodeId: a, x: 99, y: 99 }] } }); // another device, meanwhile
    await Promise.resolve(send(1)).catch(() => null); // the retry
    expect((await cardsOf(board))[0]).toMatchObject({ x: 99, y: 99 });
  });

  // ── who may write ───────────────────────────────────────────────────────────
  it("a viewer can read a board but not lay it out", async () => {
    const board = await newBoard();
    const a = await note();
    currentActor = viewer;
    expect((await app.request(`/api/boards/${board}`)).status).toBe(200);
    expect((await patch(board, { cards: { upsert: [{ nodeId: a, x: 1, y: 1 }] } })).status).toBe(403);
    currentActor = editor;
    expect(await cardsOf(board)).toEqual([]);
  });
  it("a note with no whiteboard tab is not served by /api/canvases", async () => {
    const plain = await note();
    currentActor = editor;
    expect((await app.request(`/api/canvases/${plain}`)).status).toBe(404);
  });

  // ── a big board ─────────────────────────────────────────────────────────────
  it("a change to 500 cards is stored whole; one the schema refuses changes nothing", async () => {
    const board = await newBoard();
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) ids.push(await note("big"));
    const res = await patch(board, { cards: { upsert: ids.map((nodeId, i) => ({ nodeId, x: i, y: i })) } });
    expect(res.status).toBe(200);
    expect(await placementRows(board)).toBe(500);
    // A change with one unusable entry (a non-finite position) is refused before anything is written.
    const bad = await patch(board, { cards: { upsert: [{ nodeId: ids[0], x: 9, y: 9 }, { nodeId: ids[1], x: Number.NaN, y: 9 }] } });
    expect(bad.status).toBe(400);
    expect((await cardsOf(board)).find((c) => c.nodeId === ids[0])).toMatchObject({ x: 0, y: 0 });
  }, 120_000);
  it("one request takes up to the shared cap of cards and refuses more (the app splits a larger change)", async () => {
    const board = await newBoard();
    const upsert = (n: number) => Array.from({ length: n }, (_, i) => ({ nodeId: randomUUID(), x: i, y: i }));
    expect((await patch(board, { cards: { upsert: upsert(BOARD_CARDS_PER_REQUEST_MAX) } })).status).toBe(200);
    expect((await patch(board, { cards: { upsert: upsert(BOARD_CARDS_PER_REQUEST_MAX + 1) } })).status).toBe(400);
  }, 120_000);
});
