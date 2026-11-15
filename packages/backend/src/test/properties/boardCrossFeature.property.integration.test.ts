// A board where it meets trash, purge and spaces: random sequences against a model
// (whiteboard review 2026-11-11, docs/archive/deep-review-board-2026-11-11.md).
//
// Two boards and four notes. Operations: place a card, take a card off, trash / undelete / purge a note,
// trash / undelete a board, move a note into a space the editor is not in and back. After every operation,
// reading as the editor (who cannot read a hidden note) and as the admin (who can read all):
//   1 GET /api/boards/:id answers 404 for a trashed board, else lists exactly the placed cards whose note is
//     live and readable by that reader (a trashed or hidden note's placement is kept, not shown)
//   2 the "appears on canvases" list (services/canvasMemberships getCanvasMemberships, over what the reader
//     may see) is exactly those cards of live, listed boards
//   3 a placement never points at a purged note (node_positions cascades)
//   4 a placement the editor named for a note they cannot read is not made; one they try to remove stays
//   5 undelete / move back brings every placement back where it was
// Purging a board is left out on purpose: its cards' placements stay behind (pinned in boardReview.integration.test.ts).
//
//   PROPS_SEED=123 PROPS_RUNS=200 npx vitest run src/test/properties/boardCrossFeature.property.integration.test.ts
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../../httpError.js";
import { q, getWorkspaceId } from "../../db.js";
import boardsRouter from "../../routes/boards.js";
import canvasRouter from "../../routes/canvases.js";
import nodesRouter from "../../routes/nodes.js";
import { purgeDeleted } from "../../services/nodeTrash.js";
import { getCanvasMemberships } from "../../services/canvasMemberships.js";
import { joinDefaultSpace, putInSpace, adminOnlySpace } from "../helpers/spaceFixtures.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { checkAsync, PROPS_RUNS } from "../helpers/propsConfig.js";
import { seedQ } from "../helpers/seedQ.js";
import { setWorkspaceOwner } from "../helpers/setOwner.js";
import type { ActorCtx } from "../../types.js";

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/boards", boardsRouter);
app.route("/api/canvases", canvasRouter);
app.route("/api/nodes", nodesRouter);

const editor: ActorCtx = { id: randomUUID(), name: "Editor", role: "editor", type: "human" };
const admin: ActorCtx = { id: randomUUID(), name: "Admin", role: "admin", type: "human" };
const json = { "content-type": "application/json" };
const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 25;
const TIMEOUT = 120_000 + PROPS_RUNS * 600;

const BOARDS = 2, NOTES = 4;
type Op =
  | { kind: "place"; board: number; note: number }
  | { kind: "unplace"; board: number; note: number }
  | { kind: "trashNote"; note: number }
  | { kind: "undeleteNote"; note: number }
  | { kind: "purgeNote"; note: number }
  | { kind: "trashBoard"; board: number }
  | { kind: "undeleteBoard"; board: number }
  | { kind: "hide"; note: number }
  | { kind: "unhide"; note: number };
const board = fc.nat(BOARDS - 1), note = fc.nat(NOTES - 1);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant("place" as const), board, note }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("unplace" as const), board, note }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("trashNote" as const), note }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("undeleteNote" as const), note }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("purgeNote" as const), note }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("trashBoard" as const), board }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("undeleteBoard" as const), board }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("hide" as const), note }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("unhide" as const), note }) },
);

describe.skipIf(!isTestDatabase())("board × trash × purge × spaces (random sequences)", () => {
  let WS = "";
  let defaultSpace = "";
  let lock = "";
  const stamp = Date.now();
  let seq = 0;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    for (const actor of [editor, admin]) {
      await q(`INSERT INTO actors (id, workspace_id, name, type) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [actor.id, WS, actor.name, actor.type]);
      await joinDefaultSpace(WS, actor.id, actor.role);
    }
    await setWorkspaceOwner(WS, admin.id);
    defaultSpace = (await q<{ id: string }>(`SELECT id FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    lock = await adminOnlySpace(WS, `cross-lock-${stamp}`, [admin.id]);
  });
  afterAll(() => { currentActor = null; });

  async function run(ops: Op[]): Promise<void> {
    currentActor = editor;
    const boards: string[] = [];
    for (let i = 0; i < BOARDS; i++) {
      const res = await app.request("/api/canvases", { method: "POST", headers: json, body: JSON.stringify({ title: `Cross ${stamp} ${++seq}` }) });
      const id = ((await res.json()) as { id: string }).id;
      await putInSpace(id, defaultSpace);
      boards.push(id);
    }
    const notes: string[] = [];
    for (let i = 0; i < NOTES; i++) {
      notes.push((await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
         VALUES ($1,'manual','content',$2,$2,'',$3) RETURNING id`, [WS, `cross-n-${stamp}-${++seq}`, defaultSpace])).rows[0]!.id);
    }
    // model
    const placed = new Set<string>(); // `${b}:${n}`
    const noteTrashed = new Set<number>(), purged = new Set<number>(), hidden = new Set<number>(), boardTrashed = new Set<number>();
    const log: string[] = [];

    const check = async (reader: ActorCtx, canSeeHidden: boolean) => {
      currentActor = reader;
      const readable = (n: number) => !purged.has(n) && !noteTrashed.has(n) && (canSeeHidden || !hidden.has(n));
      for (let b = 0; b < BOARDS; b++) {
        const res = await app.request(`/api/boards/${boards[b]}`);
        if (boardTrashed.has(b)) { expect(res.status, `board ${b} trashed`).toBe(404); continue; }
        expect(res.status).toBe(200);
        const got = ((await res.json()) as { cards: Array<{ nodeId: string }> }).cards.map((c) => c.nodeId).sort();
        const want = [...placed].filter((k) => k.startsWith(`${b}:`)).map((k) => Number(k.split(":")[1])).filter(readable).map((n) => notes[n]!).sort();
        expect(got, `cards of board ${b}`).toEqual(want);
      }
      const visible = [
        ...boards.filter((_, b) => !boardTrashed.has(b)),
        ...notes.filter((_, n) => readable(n)),
      ];
      const memberships = (await getCanvasMemberships(WS, visible)).filter((m) => boards.includes(m.canvas_id) && notes.includes(m.node_id));
      const wantMemberships = [...placed].map((k) => k.split(":").map(Number) as [number, number])
        .filter(([b, n]) => !boardTrashed.has(b) && readable(n)).map(([b, n]) => `${boards[b]}>${notes[n]}`).sort();
      expect(memberships.map((m) => `${m.canvas_id}>${m.node_id}`).sort(), "memberships").toEqual(wantMemberships);
    };

    for (const op of ops) {
      log.push(JSON.stringify(op));
      currentActor = editor;
      switch (op.kind) {
        case "place": {
          const res = await app.request(`/api/boards/${boards[op.board]}`, { method: "PATCH", headers: json, body: JSON.stringify({ cards: { upsert: [{ nodeId: notes[op.note], x: 1, y: 2 }] } }) });
          if (boardTrashed.has(op.board)) { expect(res.status).toBe(404); break; }
          expect(res.status, "place").toBe(200);
          // A trashed note's card is placed (it returns with the note); a note the editor cannot read is not, and a purged one is gone.
          if (!purged.has(op.note) && !hidden.has(op.note)) placed.add(`${op.board}:${op.note}`);
          break;
        }
        case "unplace": {
          const res = await app.request(`/api/boards/${boards[op.board]}`, { method: "PATCH", headers: json, body: JSON.stringify({ cards: { remove: [notes[op.note]] } }) });
          if (boardTrashed.has(op.board)) { expect(res.status).toBe(404); break; }
          expect(res.status, "unplace").toBe(200);
          if (!hidden.has(op.note) && !purged.has(op.note)) placed.delete(`${op.board}:${op.note}`);
          break;
        }
        case "trashNote":
          if (!purged.has(op.note) && !noteTrashed.has(op.note) && !hidden.has(op.note)) {
            expect((await app.request(`/api/nodes/${notes[op.note]}`, { method: "DELETE" })).status).toBe(200);
            noteTrashed.add(op.note);
          }
          break;
        case "undeleteNote":
          if (noteTrashed.has(op.note) && !purged.has(op.note) && !hidden.has(op.note)) { // the editor cannot undelete what sits in a space they are not in
            expect((await app.request(`/api/nodes/${notes[op.note]}/undelete`, { method: "POST" })).status).toBe(200);
            noteTrashed.delete(op.note);
          }
          break;
        case "purgeNote":
          if (noteTrashed.has(op.note) && !purged.has(op.note) && !hidden.has(op.note)) {
            await purgeDeleted(admin, WS, notes[op.note]!);
            purged.add(op.note); noteTrashed.delete(op.note);
            for (const k of [...placed]) if (k.endsWith(`:${op.note}`)) placed.delete(k);
          }
          break;
        case "trashBoard":
          if (!boardTrashed.has(op.board)) {
            expect((await app.request(`/api/canvases/${boards[op.board]}`, { method: "DELETE" })).status).toBe(200);
            boardTrashed.add(op.board);
          }
          break;
        case "undeleteBoard":
          if (boardTrashed.has(op.board)) {
            expect((await app.request(`/api/nodes/${boards[op.board]}/undelete`, { method: "POST" })).status).toBe(200);
            boardTrashed.delete(op.board);
          }
          break;
        case "hide":
          if (!purged.has(op.note) && !hidden.has(op.note)) { await putInSpace(notes[op.note]!, lock); hidden.add(op.note); }
          break;
        case "unhide":
          if (hidden.has(op.note)) { await putInSpace(notes[op.note]!, defaultSpace); hidden.delete(op.note); }
          break;
      }
      try {
        await check(editor, false);
        await check(admin, true);
        const orphans = (await q(`SELECT 1 FROM node_positions np WHERE np.workspace_id = $1 AND np.surface = ANY($2::text[]) AND NOT EXISTS (SELECT 1 FROM content_nodes n WHERE n.id = np.node_id)`, [WS, boards])).rowCount;
        expect(orphans, "placements of a purged note").toBe(0);
      } catch (error) {
        throw new Error(`after ${log.join(" → ")}\n${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
  }

  it("cards, memberships and placements agree with the model after every operation", async () => {
    await checkAsync(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 25 }), run), RUN_CAP);
  }, TIMEOUT);
});
