// Handwriting in History (services/history/inkChanges.ts, routes/history.ts, routes/nodes.ts):
// a drawing's saves are edits of the day, merged like typing, counted as strokes drawn and erased;
// the drawings behind a row are read on demand and only for notes the reader can read.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.hoisted(() => { process.env.ONDEN_TIMEZONE = "Asia/Taipei"; });

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

import { encodeInk, type InkDocument, type InkStroke } from "@onden/markdown/ink";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import historyRouter from "../routes/history.js";
import nodesRouter from "../routes/nodes.js";
import { localDayId } from "../localDay.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import type { ActorCtx } from "../types.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";
import { persistActor } from "./helpers/persistActor.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

function appFor(actor: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/history", historyRouter);
  app.route("/api/nodes", nodesRouter);
  return app;
}
const get = async (actor: ActorCtx, path: string) => {
  const r = await appFor(actor).request(path);
  return { status: r.status, body: (await r.json()) as any };
};

afterAll(async () => { await pool.end(); });

const stroke = (id: string): InkStroke => ({ id, points: [[0, 0], [10, 10], [20, 5], [30, 30]], color: "#112233", size: 2, toolId: "pen" });
const drawing = (ids: string[], erased: InkDocument["erased"] = {}): string =>
  encodeInk({ version: 1, strokes: ids.map(stroke), erased, page: { width: 1000 } });
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `s${from + i}`);

async function stamp(eventIds: string[], at: Date) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`UPDATE domain_events SET created_at = $2 WHERE id = ANY($1::bigint[])`, [eventIds, at]);
    await client.query("COMMIT");
  } finally { client.release(); }
}
const inkEvents = async (nodeId: string) =>
  (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND payload->>'key' = 'ink_data' ORDER BY domain_events.id`, [nodeId])).rows.map((r) => r.id);

describe.skipIf(!isTestDb)("History shows what handwriting changed", () => {
  let w: Awaited<ReturnType<typeof agentWorld>>;
  const daysAgo = (n: number) => localDayId(new Date(Date.now() - n * 86_400_000));
  const at = (hhmm: string, day: string) => new Date(`${day}T${hhmm}:00+08:00`);
  const save = (owner: ActorCtx, nodeId: string, value: string) =>
    setNodeAttribute({ workspaceId: w.ws, actor: owner, nodeId, attribute: { key: "ink_data", value } });
  /** Saves each drawing in turn, stamped at the given times (events are in save order). */
  async function drawn(nodeId: string, saves: Array<[string, Date]>) {
    for (const [value] of saves) await save(w.owner, nodeId, value);
    const events = await inkEvents(nodeId);
    for (const [i, [, when]] of saves.entries()) await stamp([events[i]!], when);
    return events;
  }

  beforeAll(async () => { w = await agentWorld("inkhist", { ownWorkspace: { modules: [] } }); WS = w.ws; });

  it("lists a note that was only drawn on, one row for a run of saves, with what the day drew and erased", async () => {
    const day = daysAgo(9);
    const note = await w.note("");
    // Four saves a minute or two apart: one edit. The last one erases a whole stroke and part of another.
    await drawn(note, [
      [drawing(ids(2)), at("10:00", day)], [drawing(ids(5)), at("10:01", day)],
      [drawing(ids(9)), at("10:03", day)], [drawing(ids(9).slice(1), { s1: [[0, 1]] }), at("10:04", day)],
    ]);
    const feed = (await get(w.owner, `/api/history/feed?until=${day}&days=1`)).body;
    const row = feed.days[0].notes.find((n: { id: string }) => n.id === note);
    expect(row).toMatchObject({ id: note, edits: 1, ink: { added: 8, erased: 0 } });
    expect(row.ink.before_event).toBeNull();
  });

  it("starts the next day from where the day before ended, and splits saves more than 5 minutes apart", async () => {
    const day1 = daysAgo(8), day2 = daysAgo(7);
    const note = await w.note("");
    const events = await drawn(note, [
      [drawing(ids(3)), at("09:00", day1)],
      [drawing(ids(6)), at("11:00", day2)], [drawing(ids(6, 0).slice(0, 5), { s0: [[0, 0]] }), at("11:30", day2)],
    ]);
    const feed = (await get(w.owner, `/api/history/feed?until=${day2}&days=2`)).body;
    const second = feed.days.find((d: { date: string }) => d.date === day2).notes.find((n: { id: string }) => n.id === note);
    // 3 -> 6 drawn, then one taken out (s5) and s0 partly erased: two edits, one day-long change from the 3 strokes (s3, s4 drawn; s0 erased).
    expect(second).toMatchObject({ edits: 2, ink: { added: 2, erased: 1, before_event: events[0], after_event: events[2] } });
    const first = feed.days.find((d: { date: string }) => d.date === day1).notes.find((n: { id: string }) => n.id === note);
    expect(first.ink).toMatchObject({ added: 3, erased: 0, before_event: null });
  });

  it("counts drawing edits in the activity chart and leaves a text note without an ink summary", async () => {
    const day = daysAgo(6);
    const inked = await w.note("");
    const typed = await w.note("hello\n");
    await drawn(inked, [[drawing(ids(2)), at("14:00", day)]]);
    const ev = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1`, [typed])).rows.map((r) => r.id);
    await stamp(ev, at("15:00", day));
    expect((await get(w.owner, `/api/history/activity?days=3&until=${daysAgo(5)}`)).body.days.find((d: { date: string }) => d.date === day)).toMatchObject({ you: 2 });
    const notes = (await get(w.owner, `/api/history/day?date=${day}`)).body.notes;
    expect(notes.find((n: { id: string }) => n.id === typed).ink ?? null).toBeNull();
    expect(notes.find((n: { id: string }) => n.id === inked).ink).toMatchObject({ added: 2 });
  });

  it("lists a note's handwriting edits newest first", async () => {
    const day = daysAgo(5);
    const note = await w.note("");
    await drawn(note, [
      [drawing(ids(4)), at("08:00", day)], [drawing(ids(4, 0).slice(0, 2)), at("12:00", day)],
    ]);
    const { status, body } = await get(w.owner, `/api/nodes/${note}/ink-edits`);
    expect(status).toBe(200);
    expect(body.map((e: { added: number; erased: number; saves: number }) => [e.added, e.erased, e.saves])).toEqual([[0, 2, 1], [4, 0, 1]]);
    expect(body[0]).toMatchObject({ actor_kind: "human", actor_name: w.owner.name });
  });

  it("reads the two drawings behind a change only for a reader of the note, and only for that note's own saves", async () => {
    const day = daysAgo(4);
    const note = await w.note("");
    const other = await w.note("");
    const [first, second] = await drawn(note, [[drawing(ids(1)), at("08:00", day)], [drawing(ids(3)), at("09:00", day)]]);
    const [foreign] = await drawn(other, [[drawing(ids(1, 50)), at("08:00", day)]]);
    const ok = await get(w.owner, `/api/nodes/${note}/ink-change?before=${first}&after=${second}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ before: drawing(ids(1)), after: drawing(ids(3)) });
    expect((await get(w.owner, `/api/nodes/${note}/ink-change?after=${first}`)).body).toEqual({ before: null, after: drawing(ids(1)) });
    // another note's save, a text event of this note, a malformed id, and a missing `after`
    expect((await get(w.owner, `/api/nodes/${note}/ink-change?before=${first}&after=${foreign}`)).status).toBe(404);
    const textEvent = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash' LIMIT 1`, [note])).rows[0]!.id;
    expect((await get(w.owner, `/api/nodes/${note}/ink-change?after=${textEvent}`)).status).toBe(404);
    expect((await get(w.owner, `/api/nodes/${note}/ink-change?after=1%20OR%201=1`)).status).toBe(404);
    expect((await get(w.owner, `/api/nodes/${note}/ink-change`)).status).toBe(404);

    // A reader who cannot see the note gets neither the rows nor the drawings, and nothing tells it apart from a missing note.
    const stranger = await persistActor(w.ws, { id: "", name: `Stranger ${w.stamp}`, role: "editor", type: "human" });
    await q(`DELETE FROM space_members WHERE actor_id = $1::uuid AND space_id <> (SELECT id FROM spaces WHERE owner_actor_id = $1::uuid AND kind = 'personal')`, [stranger.id]);
    expect((await get(stranger, `/api/nodes/${note}/ink-change?before=${first}&after=${second}`)).status).toBe(404);
    expect((await get(stranger, `/api/nodes/${note}/ink-edits`)).status).toBe(404);
    const theirDay = (await get(stranger, `/api/history/day?date=${day}`)).body.notes.map((n: { id: string }) => n.id);
    expect(theirDay).not.toContain(note);
    expect((await get(w.owner, `/api/nodes/${note}/ink-edits`)).status).toBe(200);
  });
});
