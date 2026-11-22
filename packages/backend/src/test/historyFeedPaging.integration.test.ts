// History's day list sends a page of each day's notes (feedByDay) and the rest
// on request (GET /api/history/day/notes). The page is a slice of the full
// list: same order, same actors and change summaries, only readable notes
// counted, and the totals cover the whole day.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ALIGN_VERSION_TIMES_SQL } from "./helpers/alignVersionTimes.js";
import { Hono } from "hono";

vi.hoisted(() => { process.env.ONDEN_TIMEZONE = "Asia/Taipei"; });

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import historyRouter from "../routes/history.js";
import { localDayId } from "../localDay.js";
import { feedByDay, notesEditedOn } from "../services/history/index.js";
import { describeChange } from "../services/history/noteVersions.js";
import { updateNode } from "../services/nodeUpdate.js";
import type { ActorCtx } from "../types.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";
import { persistActor } from "./helpers/persistActor.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

const call = async (actor: ActorCtx, path: string) => {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/history", historyRouter);
  const r = await app.request(`/api/history${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
afterAll(async () => { await pool.end(); });

type World = Awaited<ReturnType<typeof agentWorld>>;
const edit = (w: World, who: ActorCtx, id: string, markdown: string) => updateNode(w.ws, id, { markdown }, { actor: who });
async function stamp(ids: string[], at: Date) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`UPDATE domain_events SET created_at = $2 WHERE id = ANY($1::bigint[])`, [ids, at]);
    await client.query(ALIGN_VERSION_TIMES_SQL);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}
const eventsOf = async (nodeId: string) =>
  (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash' ORDER BY domain_events.id`, [nodeId])).rows.map((r) => r.id);

describe.skipIf(!isTestDb)("History day list pages", () => {
  let w: World;
  const daysAgo = (n: number) => localDayId(new Date(Date.now() - n * 86_400_000));
  const at = (hhmm: string, day: string) => new Date(`${day}T${hhmm}:00+08:00`);
  const day = daysAgo(3);
  const next = daysAgo(2);
  const ids: string[] = [];

  beforeAll(async () => {
    w = await agentWorld("histpage", { ownWorkspace: { modules: [] } });
    WS = w.ws;
    // Five notes created on `day`, at 10:00 … 10:40 (newest = ids[4]); the
    // first two edited again on `next` (one by the owner, one by the agent).
    for (let i = 0; i < 5; i++) {
      const id = await w.note(`first ${i}\n`);
      await stamp(await eventsOf(id), at(`10:${i}0`, day));
      ids.push(id);
    }
    await edit(w, w.owner, ids[0]!, "first 0\nadded line\n");
    await edit(w, w.agent, ids[1]!, "changed 1\n");
    await stamp(await eventsOf(ids[0]!).then((e) => e.slice(1)), at("09:00", next));
    await stamp(await eventsOf(ids[1]!).then((e) => e.slice(1)), at("09:30", next));
  });

  it("sends the newest notes of a day with the day's totals, and the rest by page", async () => {
    const feed = await feedByDay(w.owner, w.ws, next, 2, {}, 2);
    const first = feed.days.find((d) => d.date === day)!;
    expect(first.notes.map((n) => n.id)).toEqual([ids[4], ids[3]]);
    expect(first.notes_total).toBe(5);
    expect(first.edits_total).toBe(5);
    const page = async (offset: number, limit: number) => (await call(w.owner, `/day/notes?date=${day}&offset=${offset}&limit=${limit}`)).body;
    expect((await page(2, 2)).notes.map((n: { id: string }) => n.id)).toEqual([ids[2], ids[1]]);
    const last = await page(4, 2);
    expect(last.notes.map((n: { id: string }) => n.id)).toEqual([ids[0]]);
    expect(last.notes_total).toBe(5);
    expect((await page(5, 2)).notes).toEqual([]);
    // The pages put together are the whole day, row for row.
    const all = await notesEditedOn(w.owner, w.ws, day);
    const stitched = [...first.notes, ...(await page(2, 2)).notes, ...last.notes];
    expect(stitched).toEqual(all);
  });

  it("each day lists only that day's actors and the change that day made", async () => {
    const all = await notesEditedOn(w.owner, w.ws, next);
    const byOwner = all.find((n) => n.id === ids[0])!;
    const byAgent = all.find((n) => n.id === ids[1])!;
    expect(byOwner.actors).toEqual([{ name: w.owner.name, kind: "human" }]);
    expect(byAgent.actors).toEqual([{ name: w.agent.name, kind: "agent" }]);
    // From the body before the day's first save to the body after its last.
    expect(byOwner.change).toEqual(describeChange("first 0\n", "first 0\nadded line\n"));
    expect(byAgent.change).toEqual(describeChange("first 1\n", "changed 1\n"));
    const onFirstDay = (await notesEditedOn(w.owner, w.ws, day)).find((n) => n.id === ids[0])!;
    expect(onFirstDay.actors).toEqual([{ name: w.owner.name, kind: "human" }]);
    expect(onFirstDay.change).toEqual(describeChange("", "first 0\n"));
    expect(all.map((n) => n.id)).toEqual([ids[1], ids[0]]);
    expect(all.map((n) => n.edits)).toEqual([1, 1]);
  });

  it("counts and pages only notes the reader can read, and validates its parameters", async () => {
    const stranger = await persistActor(w.ws, { id: "", name: `Stranger ${w.stamp}`, role: "editor", type: "human" });
    await q(`DELETE FROM space_members WHERE actor_id = $1::uuid AND space_id <> (SELECT id FROM spaces WHERE owner_actor_id = $1::uuid AND kind = 'personal')`, [stranger.id]);
    const mine = (await call(w.owner, `/day/notes?date=${day}`)).body;
    expect(mine.notes_total).toBe(5);
    const theirs = (await call(stranger, `/day/notes?date=${day}`)).body;
    expect(theirs.notes).toEqual([]);
    expect(theirs.notes_total).toBe(0);
    const feed = await feedByDay(stranger, w.ws, next, 2, {}, 2);
    expect(feed.days.flatMap((d) => d.notes)).toEqual([]);
    for (const bad of ["offset=-1", "offset=x", "limit=0", "limit=201", "date=2026-13-40"]) {
      expect((await call(w.owner, `/day/notes?${bad}`)).status, bad).toBe(400);
    }
  });
});
