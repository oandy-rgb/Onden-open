// A whiteboard's pen layer (`board_ink`) in History, next to the handwriting page (`ink_data`):
// the same queries run for both with a `kind` (services/history/bodyEvents.ts inkEventSql), so a board's
// saves are edits of the day, have versions and counts, and can be put back — each only into its own attribute.
// Saves from before migration 172 (they say `ink_data`) belong to a board that migration moved (board_ink_moves).
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.hoisted(() => { process.env.ONDEN_TIMEZONE = "Asia/Taipei"; });

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

import { encodeInk, type InkDocument, type InkStroke } from "@onden/markdown/ink";
import { apiOnError } from "../httpError.js";
import { allowUnstampedWrite, pool, q, withTransaction } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";
import { ALIGN_VERSION_TIMES_SQL } from "./helpers/alignVersionTimes.js";
import { versionKeyOf } from "./helpers/versionFixtures.js";
import historyRouter from "../routes/history.js";
import nodesRouter from "../routes/nodes.js";
import { localDayId } from "../localDay.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import type { ActorCtx } from "../types.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

function appFor(actor: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/history", historyRouter);
  app.route("/api/nodes", nodesRouter);
  return app;
}
const call = async (actor: ActorCtx, path: string, method = "GET") => {
  const r = await appFor(actor).request(path, { method });
  return { status: r.status, body: (await r.json()) as any };
};

afterAll(async () => { await pool.end(); });

const stroke = (id: string): InkStroke => ({ id, points: [[0, 0], [10, 10], [-400, 5], [3000, 30]], color: "#112233", size: 2, toolId: "pen" });
const drawing = (ids: string[]): string => encodeInk({ version: 1, strokes: ids.map(stroke), erased: {}, page: { width: 1000 } } as InkDocument);
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `s${from + i}`);

async function stamp(eventIds: string[], at: Date) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`UPDATE domain_events SET created_at = $2 WHERE id = ANY($1::bigint[])`, [eventIds, at]);
    await client.query(ALIGN_VERSION_TIMES_SQL); // History reads the versions the saves recorded
    await client.query("COMMIT");
  } finally { client.release(); }
}
const eventsOf = async (nodeId: string, key: string) =>
  (await seedQ<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND payload->>'key' = $2 ORDER BY domain_events.id`, [nodeId, key])).rows.map((r) => r.id);
const valueOf = async (nodeId: string, key: string) =>
  (await seedQ<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [nodeId, key])).rows[0]?.value ?? null;

describe.skipIf(!isTestDb)("History carries a whiteboard's pen layer", () => {
  let w: Awaited<ReturnType<typeof agentWorld>>;
  const daysAgo = (n: number) => localDayId(new Date(Date.now() - n * 86_400_000));
  const at = (hhmm: string, day: string) => new Date(`${day}T${hhmm}:00+08:00`);
  const save = (nodeId: string, key: string, value: string) =>
    setNodeAttribute({ workspaceId: w.ws, actor: w.owner, nodeId, attribute: { key, value } });
  /** Saves each drawing in turn into `key`, stamped at the given times. */
  async function drawn(nodeId: string, key: string, saves: Array<[string, Date]>) {
    const before = (await eventsOf(nodeId, key)).length;
    for (const [value] of saves) await save(nodeId, key, value);
    const events = (await eventsOf(nodeId, key)).slice(before);
    for (const [i, [, when]] of saves.entries()) await stamp([events[i]!], when);
    // History names a drawing's version by its key: the keys, in save order
    return Promise.all(events.map(async (id) => (await versionKeyOf(id))!));
  }

  beforeAll(async () => { w = await agentWorld("boardinkhist", { ownWorkspace: { modules: [] } }); WS = w.ws; });

  it("lists two board saves as two versions with their counts, and the note among the day's edits", async () => {
    const day = daysAgo(9);
    const note = await w.note("");
    const [first, second] = await drawn(note, "board_ink", [[drawing(ids(3)), at("10:00", day)], [drawing(ids(5)), at("12:00", day)]]);
    const edits = await call(w.owner, `/api/nodes/${note}/ink-edits?kind=board`);
    expect(edits.status).toBe(200);
    expect(edits.body.map((e: { added: number; erased: number; after_event: string }) => [e.added, e.erased, e.after_event])).toEqual([[2, 0, second], [3, 0, first]]);
    const versions = await call(w.owner, `/api/nodes/${note}/ink-versions?kind=board`);
    expect(versions.body.map((v: { id: string }) => v.id)).toEqual([second, first]);
    const feed = (await call(w.owner, `/api/history/feed?until=${day}&days=1`)).body;
    const row = feed.days[0].notes.find((n: { id: string }) => n.id === note);
    expect(row).toMatchObject({ id: note, edits: 2, board_ink: { added: 5, erased: 0, before_event: null, after_event: second }, ink: null });
    const change = await call(w.owner, `/api/nodes/${note}/ink-change?kind=board&before=${first}&after=${second}`);
    expect(change.body).toEqual({ before: drawing(ids(3)), after: drawing(ids(5)) });
  });

  it("keeps the handwriting page's history free of board saves, and the board's free of handwriting", async () => {
    const day = daysAgo(8);
    const note = await w.note("");
    const [hand] = await drawn(note, "ink_data", [[drawing(ids(2)), at("09:00", day)]]);
    const [board] = await drawn(note, "board_ink", [[drawing(ids(4)), at("15:00", day)]]);
    expect((await call(w.owner, `/api/nodes/${note}/ink-edits`)).body.map((e: { after_event: string }) => e.after_event)).toEqual([hand]);
    expect((await call(w.owner, `/api/nodes/${note}/ink-edits?kind=board`)).body.map((e: { after_event: string }) => e.after_event)).toEqual([board]);
    // A save of the other drawing is no save of this kind: its picture and its restore are refused.
    expect((await call(w.owner, `/api/nodes/${note}/ink-change?after=${board}`)).status).toBe(404);
    expect((await call(w.owner, `/api/nodes/${note}/ink-versions/${board}/restore`, "POST")).status).toBe(404);
    expect((await call(w.owner, `/api/nodes/${note}/ink-edits?kind=nope`)).status).toBe(400);
    const row = (await call(w.owner, `/api/history/feed?until=${day}&days=1`)).body.days[0].notes.find((n: { id: string }) => n.id === note);
    expect(row).toMatchObject({ ink: { added: 2 }, board_ink: { added: 4 } });
  });

  it("puts an older board drawing back into board_ink only, as a new save", async () => {
    const day = daysAgo(7);
    const note = await w.note("");
    await save(note, "ink_data", drawing(ids(1, 90)));
    const [first] = await drawn(note, "board_ink", [[drawing(ids(3)), at("10:00", day)], [drawing(ids(6)), at("11:00", day)]]);
    const handBefore = await valueOf(note, "ink_data");
    const restored = await call(w.owner, `/api/nodes/${note}/ink-versions/${first}/restore?kind=board`, "POST");
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ key: "board_ink", value: drawing(ids(3)) });
    expect(await valueOf(note, "board_ink")).toBe(drawing(ids(3)));
    expect(await valueOf(note, "ink_data")).toBe(handBefore);
    // It is one more board save (and no handwriting save), so History shows it and it can be gone back from.
    expect((await eventsOf(note, "board_ink")).length).toBe(3);
    expect((await eventsOf(note, "ink_data")).length).toBe(1);
  });

  it("restores a handwriting version into ink_data only", async () => {
    const note = await w.note("");
    await save(note, "board_ink", drawing(ids(7)));
    const [first] = await drawn(note, "ink_data", [[drawing(ids(2)), at("10:00", daysAgo(6))], [drawing(ids(4)), at("11:00", daysAgo(6))]]);
    const boardBefore = await valueOf(note, "board_ink");
    expect((await call(w.owner, `/api/nodes/${note}/ink-versions/${first}/restore`, "POST")).status).toBe(200);
    expect(await valueOf(note, "ink_data")).toBe(drawing(ids(2)));
    expect(await valueOf(note, "board_ink")).toBe(boardBefore);
  });

  it("reads the saves from before migration 172 as the board's, restores one into board_ink, and leaves other notes alone", async () => {
    const day = daysAgo(5);
    const moved = await w.note("");
    const copied = await w.note("");
    const oldOnes = await drawn(moved, "ink_data", [[drawing(ids(2)), at("09:00", day)], [drawing(ids(5)), at("10:00", day)]]);
    const copiedOld = await drawn(copied, "ink_data", [[drawing(ids(2)), at("09:00", day)]]);
    // Migration 172 renamed `moved`'s row to board_ink and copied `copied`'s (moved_at is after the old saves).
    const movedAt = at("13:00", day);
    for (const [id, action] of [[moved, "moved"], [copied, "copied"]] as const) {
      await seedQ(
        `INSERT INTO board_ink_moves (node_id, workspace_id, action, reason, suggested, signals, board_ink_attribute_id, value_hash, moved_at)
         VALUES ($1, $2, $3, 'ambiguous', 'unknown', '{}'::jsonb, gen_random_uuid(), 'x', $4)`, [id, w.ws, action, movedAt]);
    }
    await seedQ(`UPDATE node_attributes SET key = 'board_ink' WHERE node_id = $1 AND key = 'ink_data'`, [moved]);
    // Migration 220 files a save made before the move under the drawing the board_ink_moves table gives it then (the version's unit is written once):
    await allowUnstampedWrite("test: the unit migration 220 gives a save before migration 172's move", () => withTransaction(async () => {
      await q("SET LOCAL session_replication_role = replica");
      for (const table of ["note_versions", "note_version_events", "note_version_positions"]) {
        await q(`UPDATE ${table} SET unit = 'board_ink' WHERE note_id = $1 AND unit = 'ink_data' AND version_key = ANY($2::text[])`, [moved, oldOnes]);
      }
    }));
    await save(moved, "ink_data", drawing(ids(1, 70))); // a handwriting page the note got after the move
    const [newBoard] = await drawn(moved, "board_ink", [[drawing(ids(6)), at("14:00", day)]]);
    const laterHandEvent = (await eventsOf(moved, "ink_data")).slice(-1)[0]!;
    await stamp([laterHandEvent], at("14:30", day));
    const laterHand = (await versionKeyOf(laterHandEvent))!;

    const board = await call(w.owner, `/api/nodes/${moved}/ink-edits?kind=board`);
    expect(board.body.map((e: { after_event: string }) => e.after_event)).toEqual([newBoard, oldOnes[1], oldOnes[0]]);
    expect(board.body.map((e: { added: number }) => e.added)).toEqual([1, 3, 2]);
    const hand = await call(w.owner, `/api/nodes/${moved}/ink-edits`);
    expect(hand.body.map((e: { after_event: string }) => e.after_event)).toEqual([laterHand]);
    // Ambiguous ('copied'): the old saves stay with the handwriting page.
    expect((await call(w.owner, `/api/nodes/${copied}/ink-edits`)).body.map((e: { after_event: string }) => e.after_event)).toEqual([copiedOld[0]]);
    expect((await call(w.owner, `/api/nodes/${copied}/ink-edits?kind=board`)).body).toEqual([]);

    const day5 = (await call(w.owner, `/api/history/feed?until=${day}&days=1`)).body.days[0].notes.find((n: { id: string }) => n.id === moved);
    expect(day5).toMatchObject({ board_ink: { added: 6, erased: 0, before_event: null }, ink: { added: 1 } });

    const handBefore = await valueOf(moved, "ink_data");
    const restored = await call(w.owner, `/api/nodes/${moved}/ink-versions/${oldOnes[1]}/restore?kind=board`, "POST");
    expect(restored.status).toBe(200);
    expect(restored.body.key).toBe("board_ink");
    expect(await valueOf(moved, "board_ink")).toBe(drawing(ids(5)));
    expect(await valueOf(moved, "ink_data")).toBe(handBefore);
    // As handwriting, that old save is not restorable.
    expect((await call(w.owner, `/api/nodes/${moved}/ink-versions/${oldOnes[1]}/restore`, "POST")).status).toBe(404);
  });
});
