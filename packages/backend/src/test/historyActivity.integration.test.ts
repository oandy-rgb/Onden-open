// History across the workspace (routes/history.ts, services/history/*):
// edits per day, the notes and agent runs of a day, undo/redo of an agent run
// and the recently-deleted list. The assembled routes, real actors.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.hoisted(() => { process.env.ONDEN_TIMEZONE = "Asia/Taipei"; });

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import historyRouter from "../routes/history.js";
import { localDayId, workspaceTimeZone } from "../localDay.js";
import { startSession } from "../services/agentSessions.js";
import { purgeDeleted, trashNode } from "../services/nodeTrash.js";
import { updateNode } from "../services/nodeUpdate.js";
import type { ActorCtx } from "../types.js";
import { agentWorld, sessionActor } from "./helpers/agentSessionFixture.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

function appFor(actor: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/history", historyRouter);
  return app;
}
const call = async (actor: ActorCtx, path: string, json?: unknown) => {
  const r = await appFor(actor).request(`/api/history${path}`, json === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

afterAll(async () => { await pool.end(); });

type World = Awaited<ReturnType<typeof agentWorld>>;
const edit = (w: World, who: ActorCtx, id: string, markdown: string) => updateNode(w.ws, id, { markdown }, { actor: who });
/** Move every event of `ids` to `at`, so a test controls the clock. */
async function stamp(ids: string[], at: Date) {
  // domain_events is append-only; a fixture may bend that on its own connection only.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`UPDATE domain_events SET created_at = $2 WHERE id = ANY($1::bigint[])`, [ids, at]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}
const lastEvent = async (nodeId: string) =>
  (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash' ORDER BY domain_events.id DESC LIMIT 1`, [nodeId])).rows[0]!.id;

describe.skipIf(!isTestDb)("History: activity, day, runs, undo, deleted", () => {
  let w: World;
  // Each test uses days of its own: the database is shared and these queries are workspace-wide.
  const daysAgo = (n: number) => localDayId(new Date(Date.now() - n * 86_400_000));
  /** 1 ms before the next local midnight of `day`, in the workspace zone. */
  const endOfLocalDay = (day: string): Date => {
    const next = new Date(`${day}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    const asLocal = new Date(next.toLocaleString("en-US", { timeZone: workspaceTimeZone() }));
    const asUtc = new Date(next.toLocaleString("en-US", { timeZone: "UTC" }));
    return new Date(next.getTime() - (asLocal.getTime() - asUtc.getTime()) - 1);
  };
  const yesterday = daysAgo(1);
  const quiet = daysAgo(6);
  // 00:30 local on `yesterday`: the previous day in UTC, so a day cut made in UTC would miscount it.
  const at = (hhmm: string, day = yesterday) => new Date(`${day}T${hhmm}:00+08:00`);

  beforeAll(async () => {
    w = await agentWorld("hist", { ownWorkspace: { modules: [] } });
    WS = w.ws;
  });

  it("counts edits per local day, merging saves within 5 minutes, humans apart from agents", async () => {
    const note = await w.note("one\n");
    const created = await lastEvent(note);
    await edit(w, w.owner, note, "two\n");
    const a = await lastEvent(note);
    await edit(w, w.owner, note, "three\n");
    const b = await lastEvent(note);
    await edit(w, w.owner, note, "four\n");
    const c = await lastEvent(note);
    await edit(w, w.agent, note, "five\n");
    const d = await lastEvent(note);
    await stamp([created], at("00:10", quiet));
    await stamp([a], at("00:30", quiet));   // created is its own edit; a+b are one (3 minutes apart)
    await stamp([b], at("00:33", quiet));
    await stamp([c], at("12:00", quiet));   // a later, separate human edit
    await stamp([d], at("12:02", quiet));   // the agent, a different actor
    const { status, body } = await call(w.owner, "/activity?days=8");
    expect(status).toBe(200);
    expect(body.days).toHaveLength(8);
    expect(body.days.at(-1).date).toBe(localDayId());
    const day = body.days.find((x: { date: string }) => x.date === quiet);
    expect(day).toEqual({ date: quiet, you: 3, agents: 1 });
    const day2 = (await call(w.owner, `/day?date=${quiet}`)).body;
    const row = day2.notes.find((n: { id: string }) => n.id === note);
    expect(row).toMatchObject({ id: note, edits: 4, created: true });
    expect(new Date(row.first_at).getTime()).toBe(at("00:10", quiet).getTime());
    expect(new Date(row.last_at).getTime()).toBe(at("12:02", quiet).getTime());
    expect(row.actors).toEqual(expect.arrayContaining([
      { name: w.owner.name, kind: "human" }, { name: w.agent.name, kind: "agent" },
    ]));
  });

  it("hides notes the reader cannot read, and validates its parameters", async () => {
    const stranger = await persistActor(w.ws, { id: "", name: `Stranger ${w.stamp}`, role: "editor", type: "human" });
    // the fixture's default space lets the stranger in; the world's shared space does not
    await q(`DELETE FROM space_members WHERE actor_id = $1::uuid AND space_id <> (SELECT id FROM spaces WHERE owner_actor_id = $1::uuid AND kind = 'personal')`, [stranger.id]);
    const secret = await w.note("secret\n");
    await edit(w, w.owner, secret, "secret 2\n");
    const ids = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1`, [secret])).rows.map((r) => r.id);
    await stamp(ids, at("08:00", daysAgo(5)));
    const mine = (await call(w.owner, `/day?date=${daysAgo(5)}`)).body.notes.map((n: { id: string }) => n.id);
    expect(mine).toContain(secret);
    const theirs = (await call(stranger, `/day?date=${daysAgo(5)}`)).body;
    expect(theirs.notes.map((n: { id: string }) => n.id)).not.toContain(secret);
    expect((await call(w.owner, "/activity?days=0")).status).toBe(400);
    expect((await call(w.owner, "/activity?days=abc")).status).toBe(400);
    expect((await call(w.owner, "/day?date=2026-13-40")).status).toBe(400);
    expect((await call(w.owner, "/deleted?days=0")).status).toBe(400);
  });

  describe("?space= filter", () => {
    it("narrows activity, day, feed and deleted to one space, and every note carries its space_id", async () => {
      const day = daysAgo(3);
      const other = await makeSpace(w.ws, "Other", [{ id: w.owner.id, permission: "edit" }]);
      const inDefault = await w.note("d\n");
      const inOther = await w.note("o\n", other);
      const gone = await w.note("gone\n", other);
      await trashNode(w.owner, w.ws, gone);
      const ids = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = ANY($1::text[])`, [[inDefault, inOther]])).rows.map((r) => r.id);
      await stamp(ids, at("10:00", day));

      const ofDay = async (query = "") => (await call(w.owner, `/day?date=${day}${query}`)).body.notes as Array<{ id: string; space_id: string | null }>;
      const all = await ofDay();
      expect(all.find((n) => n.id === inDefault)!.space_id).toBe(w.space);
      expect(all.find((n) => n.id === inOther)!.space_id).toBe(other);
      expect((await ofDay(`&space=${other}`)).map((n) => n.id)).toEqual([inOther]);
      expect((await ofDay(`&space=${w.space}`)).map((n) => n.id)).toContain(inDefault);
      expect((await ofDay(`&space=${w.space}`)).map((n) => n.id)).not.toContain(inOther);

      const sum = async (query: string) => (await call(w.owner, `/activity?days=5&until=${day}${query}`)).body.days.find((x: { date: string }) => x.date === day);
      const everything = await sum("");
      const justOther = await sum(`&space=${other}`);
      expect(justOther.you).toBe(1);
      expect(everything.you).toBeGreaterThan(justOther.you);

      const feed = (await call(w.owner, `/feed?until=${day}&days=1&space=${other}`)).body;
      // The day's last instant, in the zone the days are cut in: 「那天的樣子」 looks back to it.
      expect(new Date(feed.days[0].end_at).getTime()).toBe(endOfLocalDay(day).getTime());
      expect(feed.days.flatMap((d: { notes: Array<{ id: string }> }) => d.notes.map((n) => n.id))).toEqual([inOther]);

      const deleted = async (query: string) => (await call(w.owner, `/deleted${query}`)).body.notes as Array<{ id: string; space_id: string }>;
      expect((await deleted("")).find((n) => n.id === gone)!.space_id).toBe(other);
      expect((await deleted(`?space=${other}`)).map((n) => n.id)).toEqual([gone]);
      expect((await deleted(`?space=${w.space}`)).map((n) => n.id)).not.toContain(gone);
      expect((await call(w.owner, `/deleted/${gone}?space=${other}`)).status).toBe(200);
      expect((await call(w.owner, `/deleted/${gone}?space=${w.space}`)).status).toBe(404);
    });

    it("answers a space the caller cannot read, or that does not exist, like an empty one; a malformed id is 400", async () => {
      const day = daysAgo(4);
      const hiddenSpace = await makeSpace(w.ws, "Hidden", [{ id: w.owner.id, permission: "edit" }]);
      const note = await w.note("h\n", hiddenSpace);
      await stamp((await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1`, [note])).rows.map((r) => r.id), at("10:00", day));
      const stranger = await persistActor(w.ws, { id: "", name: `Outsider ${w.stamp}`, role: "editor", type: "human" });
      await q(`DELETE FROM space_members WHERE actor_id = $1::uuid AND space_id = $2::uuid`, [stranger.id, hiddenSpace]);
      const missing = "00000000-0000-4000-8000-000000000000";
      for (const space of [hiddenSpace, missing]) {
        expect((await call(stranger, `/day?date=${day}&space=${space}`)).body).toEqual({ notes: [], agent_runs: [], rewinds: [] });
        expect((await call(stranger, `/feed?until=${day}&days=1&space=${space}`)).body).toEqual({ days: [], earlier_day: null });
        expect((await call(stranger, `/deleted?space=${space}`)).body).toEqual({ notes: [], older_cursor: null });
        const act = (await call(stranger, `/activity?days=1&until=${day}&space=${space}`)).body.days;
        expect(act).toEqual([{ date: day, you: 0, agents: 0 }]);
      }
      for (const path of ["/day?space=nope", "/feed?space=nope", "/activity?space=nope", "/deleted?space=nope", `/deleted/${missing}?space=nope`]) {
        expect((await call(w.owner, path)).status).toBe(400);
      }
    });

    it("an agent run lists only the notes in the space, and a run with none there is absent", async () => {
      // A session run stays in the space of the note it was sent from
      // (spaceAccess sessionSql), so a run across spaces is a resident
      // token's: writes 10 minutes apart or less are one legacy run.
      const day = daysAgo(2);
      const spaceA = await makeSpace(w.ws, "Run A", [{ id: w.owner.id, permission: "edit" }, { id: w.agent.id, permission: "edit" }]);
      const spaceB = await makeSpace(w.ws, "Run B", [{ id: w.owner.id, permission: "edit" }, { id: w.agent.id, permission: "edit" }]);
      const a1 = await w.note("a\n", spaceA);
      const b1 = await w.note("b\n", spaceB);
      const onlyB = await w.note("c\n", spaceB);
      await edit(w, w.agent, a1, "a1\n");
      await edit(w, w.agent, b1, "b1\n");
      const events = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE actor_id = $1 AND target_id = ANY($2::text[]) ORDER BY domain_events.id`, [w.agent.id, [a1, b1]])).rows;
      await stamp(events.map((e) => e.id), at("09:00", day));
      const both = `legacy:${w.agent.id}:${events[0]!.id}`;
      // a second run, later that day, touching only space B
      await edit(w, w.agent, onlyB, "c1\n");
      const ev = await lastEvent(onlyB);
      await stamp([ev], at("20:00", day));
      const onlyBRun = `legacy:${w.agent.id}:${ev}`;

      const runs = async (query = "") => (await call(w.owner, `/day?date=${day}${query}`)).body.agent_runs as Array<{ run_id: string; notes: Array<{ id: string; space_id: string }> }>;
      const everything = await runs();
      expect(everything.find((r) => r.run_id === both)!.notes.map((n) => n.id).sort()).toEqual([a1, b1].sort());
      expect(everything.find((r) => r.run_id === both)!.notes.find((n) => n.id === a1)!.space_id).toBe(spaceA);
      expect(everything.map((r) => r.run_id)).toContain(onlyBRun);

      const inA = await runs(`&space=${spaceA}`);
      expect(inA.find((r) => r.run_id === both)!.notes.map((n) => n.id)).toEqual([a1]);
      expect(inA.map((r) => r.run_id)).not.toContain(onlyBRun);
      const inB = await runs(`&space=${spaceB}`);
      expect(inB.find((r) => r.run_id === both)!.notes.map((n) => n.id)).toEqual([b1]);
      expect(inB.map((r) => r.run_id)).toContain(onlyBRun);
    });
  });

  describe("agent runs", () => {
    it("groups a session's writes by the session id and legacy writes by a 10-minute gap", async () => {
      const n1 = await w.note("a\n");
      const n2 = await w.note("b\n");
      const mention = `@${w.handle} 整理這兩篇，順便把標題改好`;
      const host = await w.note(mention);
      const { session } = await startSession(w.ws, { actor: w.owner, nodeId: host, target: { blockText: mention } });
      const sess = await sessionActor(session, w.agent);
      await edit(w, sess, n1, "a1\n");
      await edit(w, sess, n2, "b1\n");
      const sessionEvents = (await q<{ id: string; run: string }>(
        `SELECT id::text, payload->>'agent_run_id' AS run FROM domain_events WHERE actor_id = $1 AND target_id = ANY($2::text[]) AND payload ? 'body_hash' ORDER BY domain_events.id`,
        [w.agent.id, [n1, n2]])).rows;
      expect(sessionEvents.map((e) => e.run)).toEqual([session.id, session.id]);
      await stamp(sessionEvents.map((e) => e.id), at("09:00"));

      // resident-token writes carry no session: runs are cut at a 10-minute gap
      const l1 = await w.note("x\n");
      await edit(w, w.agent, l1, "x1\n"); const e1 = await lastEvent(l1);
      await edit(w, w.agent, l1, "x2\n"); const e2 = await lastEvent(l1);
      await edit(w, w.agent, l1, "x3\n"); const e3 = await lastEvent(l1);
      await stamp([e1], at("14:00")); await stamp([e2], at("14:09")); await stamp([e3], at("14:30"));

      const day = (await call(w.owner, `/day?date=${yesterday}`)).body;
      const runs = day.agent_runs as Array<{ run_id: string; agent_name: string; summary: string; undone: boolean; notes: Array<Record<string, any>> }>;
      const sessionRun = runs.find((r) => r.run_id === session.id)!;
      expect(sessionRun).toMatchObject({ agent_name: w.agent.name, summary: "整理這兩篇，順便把標題改好", undone: false });
      expect(sessionRun.notes.map((n) => n.id).sort()).toEqual([n1, n2].sort());
      expect(sessionRun.notes.find((n) => n.id === n1)).toMatchObject({ added: 0, changed: 1, removed: 0 });
      const legacy = runs.filter((r) => r.run_id.startsWith(`legacy:${w.agent.id}:`) && r.notes.some((n) => n.id === l1));
      expect(legacy.map((r) => r.run_id)).toEqual([`legacy:${w.agent.id}:${e3}`, `legacy:${w.agent.id}:${e1}`]);
      expect(legacy.every((r) => r.summary === "")).toBe(true);
    });

    // Legacy runs are cut by time, so each test writes on a day of its own.
    async function agentEdits(body: string, next: string, day: string) {
      const note = await w.note(body);
      await edit(w, w.agent, note, next);
      const ev = await lastEvent(note);
      await stamp([ev], at("16:00", day));
      const run = `legacy:${w.agent.id}:${ev}`;
      return { note, run };
    }

    it("undo keeps what a person wrote afterwards; redo brings the agent's change back", async () => {
      const { note, run } = await agentEdits("a\nb\nc\n", "A\nb\nc\n", daysAgo(2));
      await edit(w, w.owner, note, "A\nb\nC\n"); // a person edits another line afterwards
      const undone = await call(w.owner, `/agent-runs/${run}/undo`, { node_ids: [note] });
      expect(undone).toMatchObject({ status: 200, body: { undone: [note], conflicts: [], skipped: [] } });
      expect(await w.body(note)).toBe("a\nb\nC\n");
      const hist = await q<{ actor_id: string; ctx: string }>(
        `SELECT actor_id, tx_meta->>'ui_context' AS ctx FROM domain_events WHERE target_id = $1 ORDER BY id DESC LIMIT 1`, [note]);
      expect(hist.rows[0]).toEqual({ actor_id: w.owner.id, ctx: "history.agent_run.undo" });
      // the run now reads as undone
      const day = (await call(w.owner, `/day?date=${daysAgo(2)}`)).body;
      expect(day.agent_runs.find((r: { run_id: string }) => r.run_id === run).undone).toBe(true);
      // asking again changes nothing and still answers undone
      const again = await call(w.owner, `/agent-runs/${run}/undo`, { node_ids: [note] });
      expect(again.body.undone).toEqual([note]);
      expect(await w.body(note)).toBe("a\nb\nC\n");

      const redone = await call(w.owner, `/agent-runs/${run}/redo`, { node_ids: [note] });
      expect(redone).toMatchObject({ status: 200, body: { undone: [note], conflicts: [] } });
      expect(await w.body(note)).toBe("A\nb\nC\n");
      const day2 = (await call(w.owner, `/day?date=${daysAgo(2)}`)).body;
      expect(day2.agent_runs.find((r: { run_id: string }) => r.run_id === run).undone).toBe(false);
    });

    it("M5: a session's run cannot be undone while it is open; a later write of the run is not 'undone'", async () => {
      const note = await w.note("a\n");
      const mention = `@${w.handle} 改這篇`;
      const host = await w.note(mention);
      const { session } = await startSession(w.ws, { actor: w.owner, nodeId: host, target: { blockText: mention } });
      const sess = await sessionActor(session, w.agent);
      await edit(w, sess, note, "a1\n");
      // still open: refused, nothing written
      expect((await call(w.owner, `/agent-runs/${session.id}/undo`, { node_ids: [note] })).status).toBe(409);
      expect(await w.body(note)).toBe("a1\n");
      const { endSession } = await import("../services/agentSessionStore.js");
      await endSession(w.ws, session.id, "cancelled");
      const first = await call(w.owner, `/agent-runs/${session.id}/undo`, { node_ids: [note] });
      expect(first).toMatchObject({ status: 200, body: { undone: [note] } });
      expect(await w.body(note)).toBe("a\n");
    });

    it("M5: when the agent writes a note again after its run was undone, the run reads as not undone and undo works again", async () => {
      const day = daysAgo(5);
      const note = await w.note("a\n");
      await edit(w, w.agent, note, "a1\n");
      const e1 = await lastEvent(note);
      await stamp([e1], at("10:00", day));
      const run = `legacy:${w.agent.id}:${e1}`;
      expect((await call(w.owner, `/agent-runs/${run}/undo`, { node_ids: [note] })).body.undone).toEqual([note]);
      const undoEvent = await lastEvent(note);
      await stamp([undoEvent], at("10:01", day));
      await edit(w, w.agent, note, "a1\na2\n"); // the same run (within the 10-minute gap) writes again
      await stamp([await lastEvent(note)], at("10:02", day));
      const card = (await call(w.owner, `/day?date=${day}`)).body.agent_runs.find((r: { run_id: string }) => r.run_id === run);
      expect(card.undone).toBe(false);
      const again = await call(w.owner, `/agent-runs/${run}/undo`, { node_ids: [note] });
      expect(again.body.undone).toEqual([note]);
      expect(await w.body(note)).toBe("a\n");
    });

    it("a line both sides changed stays as the person wrote it and the other text goes to the inbox", async () => {
      const { note, run } = await agentEdits("a\nb\n", "AGENT\nb\n", daysAgo(4));
      await edit(w, w.owner, note, "HUMAN\nb\n");
      const r = await call(w.owner, `/agent-runs/${run}/undo`, { node_ids: [note] });
      expect(r.body).toMatchObject({ undone: [note], conflicts: [note], skipped: [] });
      expect(await w.body(note)).toBe("HUMAN\nb\n");
      const conflict = (await q<{ payload: { conflicts: Array<{ incoming: string; current: string }> } }>(
        `SELECT payload FROM domain_events WHERE target_id = $1 AND event_type = 'BODY_CONFLICT'`, [note])).rows;
      expect(conflict).toHaveLength(1);
      expect(conflict[0]!.payload.conflicts[0]).toMatchObject({ incoming: "HUMAN\n", current: "a\n" });
    });

    it("leaves alone a note the caller may read but not write, and notes outside the run", async () => {
      const viewer = await persistActor(w.ws, { id: "", name: `Viewer ${w.stamp}`, role: "editor", type: "human" });
      const shared = await makeSpace(w.ws, `shared ${w.stamp}`, [
        { id: w.owner.id, role: "manager" }, { id: w.agent.id, role: "editor" }, { id: viewer.id, role: "viewer" },
      ]);
      const note = await w.note("p\n", shared);
      const other = await w.note("q\n");
      await edit(w, w.agent, note, "P\n");
      const ev = await lastEvent(note);
      await stamp([ev], at("17:00", daysAgo(3)));
      const run = `legacy:${w.agent.id}:${ev}`;
      const denied = await call(viewer, `/agent-runs/${run}/undo`, { node_ids: [note, other] });
      expect(denied).toMatchObject({ status: 200, body: { undone: [], conflicts: [], skipped: expect.arrayContaining([note, other]) } });
      expect(await w.body(note)).toBe("P\n");
      expect((await call(w.owner, `/agent-runs/${run}/undo`, { node_ids: [] })).body).toEqual({ undone: [], conflicts: [], skipped: [] });
      expect((await call(w.owner, `/agent-runs/legacy:${w.agent.id}:999999999/undo`, { node_ids: [note] })).status).toBe(404);
      expect((await call(w.owner, `/agent-runs/${run}/undo`, {})).status).toBe(400);
      // an unreadable run is missing, not forbidden
      const stranger = await persistActor(w.ws, { id: "", name: `Out ${w.stamp}`, role: "editor", type: "human" });
      await q(`DELETE FROM space_members WHERE actor_id = $1::uuid AND space_id = $2::uuid`, [stranger.id, shared]);
      expect((await call(stranger, `/agent-runs/${run}/undo`, { node_ids: [note] })).status).toBe(404);
    });

    it("skips a note the run created: there is no earlier body to go back to", async () => {
      const { createNote } = await import("../services/noteCreate.js");
      const sess = await persistActor(w.ws, { id: "", name: `Maker ${w.stamp}`, role: "editor", type: "agent", tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null } });
      await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1::uuid, $2::uuid, 'edit') ON CONFLICT DO NOTHING`, [w.space, sess.id]);
      const made = (await createNote({ actor: sess, workspaceId: w.ws, title: `made ${w.stamp}`, markdown: "new\n", spaceId: w.space, event: { uiContext: "test" } })).node.id as string;
      const ev = await lastEvent(made);
      const run = `legacy:${sess.id}:${ev}`;
      expect((await call(w.owner, `/agent-runs/${run}/undo`, { node_ids: [made] })).body).toEqual({ undone: [], conflicts: [], skipped: [made] });
      expect(await w.body(made)).toBe("new\n");
    });
  });

  it("lists deleted notes the reader can read, a deletion's root only", async () => {
    const parent = await w.note("parent\n");
    const child = await w.note("child\n");
    await seedQ(`UPDATE content_nodes SET parent_id = $1 WHERE id = $2`, [parent, child]);
    const hidden = await w.note("not mine\n");
    await trashNode(w.owner, w.ws, parent);
    await trashNode(w.owner, w.ws, hidden);
    const stranger = await persistActor(w.ws, { id: "", name: `Nobody ${w.stamp}`, role: "editor", type: "human" });
    await q(`DELETE FROM space_members WHERE actor_id = $1::uuid AND space_id = $2::uuid`, [stranger.id, w.space]);
    const listed = (await call(w.owner, "/deleted")).body.notes as Array<{ id: string; title: string; deleted_at: string }>;
    const ids = listed.map((n) => n.id);
    expect(ids).toContain(parent);
    expect(ids).not.toContain(child); // comes back with its parent
    expect(listed.find((n) => n.id === parent)!.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await call(stranger, "/deleted")).body.notes.map((n: { id: string }) => n.id)).not.toContain(parent);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() - interval '40 days' WHERE id = $1`, [hidden]);
    expect((await call(w.owner, "/deleted?days=30")).body.notes.map((n: { id: string }) => n.id)).not.toContain(hidden);
    expect((await call(w.owner, "/deleted?days=60")).body.notes.map((n: { id: string }) => n.id)).toContain(hidden);
  });
  describe("what changed, the feed, blank deleted notes", () => {
    const stampAll = async (id: string, at: Date) => {
      const ids = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash' ORDER BY domain_events.id`, [id])).rows.map((r) => r.id);
      await stamp(ids, at);
    };
    /** Stamp the events after the first `skip` ones of `id` onto `at`. */
    const stampAfter = async (id: string, skip: number, at: Date) => {
      const ids = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash' ORDER BY domain_events.id`, [id])).rows.map((r) => r.id);
      await stamp(ids.slice(skip), at);
    };
    const rowOf = (body: Record<string, any>, id: string) => (body.notes as Array<Record<string, any>>).find((n) => n.id === id)!;

    it("describes each note against its text before the day: new, changed, removed, unchanged", async () => {
      const day = daysAgo(24);
      const before = daysAgo(26);
      const fresh = await w.note("# Plan\n\nfirst step\n");
      await stampAll(fresh, at("10:00", day));

      const changed = await w.note("# Todo\n\nbuy milk\n\nwalk dog\n");
      await stampAll(changed, at("10:00", before));
      await edit(w, w.owner, changed, "# Todo\n\nbuy oat milk\n\nwalk dog\n");
      await stampAfter(changed, 1, at("09:00", day));
      await edit(w, w.owner, changed, "# Todo\n\nbuy oat milk please\n\nwalk dog\n");   // a second save the same day
      await stampAfter(changed, 2, at("15:00", day));

      const removed = await w.note("# Todo\n\nkeep\n\nwalk the dog ^d1\n");
      await stampAll(removed, at("10:00", before));
      await edit(w, w.owner, removed, "# Todo\n\nkeep\n");
      await stampAfter(removed, 1, at("11:00", day));

      const same = await w.note("alpha\n");
      await stampAll(same, at("10:00", before));
      await edit(w, w.owner, same, "beta\n");
      await stampAfter(same, 1, at("11:00", day));
      await edit(w, w.owner, same, "alpha\n");   // back to what the day began with
      await stampAfter(same, 2, at("13:00", day));

      const { body } = await call(w.owner, `/day?date=${day}`);
      expect(rowOf(body, fresh).change).toEqual({ added: 2, changed: 0, removed: 0, sections: ["Plan"], sample: "Plan", sample_kind: "added" });
      expect(rowOf(body, changed).change).toEqual({ added: 0, changed: 1, removed: 0, sections: ["Todo"], sample: "buy oat milk please", sample_kind: "changed" });
      expect(rowOf(body, removed).change).toEqual({ added: 0, changed: 0, removed: 1, sections: ["Todo"], sample: "walk the dog", sample_kind: "removed" });
      expect(rowOf(body, same).change).toEqual({ added: 0, changed: 0, removed: 0, sections: [], sample: null, sample_kind: null });
    });

    it("a title-only edit does not appear as a body edit", async () => {
      const day = daysAgo(23);
      const note = await w.note("same body\n");
      await stampAll(note, at("08:00", daysAgo(25)));
      await updateNode(w.ws, note, { title: `renamed ${w.stamp}` }, { actor: w.owner });
      const { body } = await call(w.owner, `/day?date=${day}`);
      const row = (body.notes as Array<{ id: string }>).find((n) => n.id === note);
      // Either not listed (no body saved) or listed with no text change; never a made-up change.
      if (row) expect((row as Record<string, any>).change).toMatchObject({ added: 0, changed: 0, removed: 0, sample: null });
    });

    it("feed: only the days with changes, newest first, within until/days, with the same notes as /day", async () => {
      const until = daysAgo(15);
      const [d1, d2] = [daysAgo(16), daysAgo(19)];
      const a = await w.note("one\n");
      await stampAll(a, at("10:00", d1));
      const b = await w.note("two\n");
      await stampAll(b, at("10:00", d2));
      const outside = await w.note("three\n");
      await stampAll(outside, at("10:00", daysAgo(30)));

      const feed = (await call(w.owner, `/feed?until=${until}&days=7`)).body.days as Array<{ date: string; notes: Array<{ id: string }>; agent_runs: unknown[] }>;
      const page = (path: string) => call(w.owner, path).then((r) => r.body as { days: Array<{ date: string }>; earlier_day: string | null });
      expect(feed.map((d) => d.date)).toEqual([d1, d2]);
      expect(feed[0]!.notes.map((n) => n.id)).toEqual([a]);
      expect(feed[1]!.notes.map((n) => n.id)).toEqual([b]);
      expect(feed[0]!.agent_runs).toEqual([]);
      expect(feed[0]!.notes[0]).toEqual((await call(w.owner, `/day?date=${d1}`)).body.notes.find((n: { id: string }) => n.id === a));
      // the range is [until-days+1, until]: one day ending 15 days ago has nothing
      expect((await call(w.owner, `/feed?until=${until}&days=1`)).body.days).toEqual([]);
      expect((await call(w.owner, `/feed?until=${daysAgo(16)}&days=1`)).body.days.map((d: { date: string }) => d.date)).toEqual([d1]);
      // earlier_day: where the next page ends. Walking by it visits every day with a save, back to the start, and then says null.
      const visited: string[] = [];
      let next: string | null = (await page(`/feed?until=${until}&days=7`)).earlier_day;
      for (let steps = 0; next !== null && steps < 40; steps++) {
        const got = await page(`/feed?until=${next}&days=7`);
        visited.push(...got.days.map((d) => d.date));
        next = got.earlier_day;
      }
      expect(next).toBeNull();
      expect(visited).toContain(daysAgo(30));
      const stranger = await persistActor(w.ws, { id: "", name: `Earlier stranger ${w.stamp}`, role: "editor", type: "human" });
      await q(`DELETE FROM space_members WHERE actor_id = $1::uuid AND space_id <> (SELECT id FROM spaces WHERE owner_actor_id = $1::uuid AND kind = 'personal')`, [stranger.id]);
      expect(await call(stranger, `/feed?until=${until}&days=7`).then((r) => r.body.earlier_day)).toBeNull();   // sees none of these notes
      // a day with only an agent run is a day with changes
      const viaAgent = await w.note("agent text\n");
      await edit(w, w.agent, viaAgent, "agent text 2\n");
      await stampAll(viaAgent, at("12:00", daysAgo(17)));
      const withRun = (await call(w.owner, `/feed?until=${until}&days=7`)).body.days as Array<{ date: string; agent_runs: Array<{ notes: Array<{ id: string }> }> }>;
      expect(withRun.map((d) => d.date)).toEqual([d1, daysAgo(17), d2]);
      expect(withRun[1]!.agent_runs[0]!.notes.map((n) => n.id)).toEqual([viaAgent]);
    });

    it("feed: validates its parameters and hides notes the reader cannot read", async () => {
      expect((await call(w.owner, "/feed?days=0")).status).toBe(400);
      expect((await call(w.owner, "/feed?days=32")).status).toBe(400);
      expect((await call(w.owner, "/feed?until=2026-13-40")).status).toBe(400);
      expect((await call(w.owner, "/feed")).status).toBe(200);
      const stranger = await persistActor(w.ws, { id: "", name: `Feed stranger ${w.stamp}`, role: "editor", type: "human" });
      await q(`DELETE FROM space_members WHERE actor_id = $1::uuid AND space_id <> (SELECT id FROM spaces WHERE owner_actor_id = $1::uuid AND kind = 'personal')`, [stranger.id]);
      const secret = await w.note("secret feed\n");
      await stampAll(secret, at("09:00", daysAgo(27)));
      const seen = (a: ActorCtx) => call(a, `/feed?until=${daysAgo(27)}&days=1`).then((r) => (r.body.days as Array<{ notes: Array<{ id: string }> }>).flatMap((d) => d.notes.map((n) => n.id)));
      expect(await seen(w.owner)).toContain(secret);
      expect(await seen(stranger)).not.toContain(secret);
    });

    it("activity: until moves the window back and the last day is until", async () => {
      const until = daysAgo(40);
      const [d1, d2] = [daysAgo(41), daysAgo(44)];
      for (const [markdown, day] of [["act one\n", d1], ["act two\n", d2], ["act old\n", daysAgo(50)]] as const) {
        await stampAll(await w.note(markdown), at("10:00", day));
      }
      const days = (await call(w.owner, `/activity?days=7&until=${until}`)).body.days as Array<{ date: string; you: number; agents: number }>;
      expect(days).toHaveLength(7);
      expect(days.at(-1)!.date).toBe(until);
      expect(days.find((d) => d.date === d1)!.you).toBe(1);
      expect(days.find((d) => d.date === d2)!.you).toBe(1);
      expect(days.find((d) => d.date === daysAgo(50))).toBeUndefined();   // outside the window
      expect((await call(w.owner, `/activity?days=7&until=${daysAgo(60)}`)).body.days.reduce((n: number, d: { you: number }) => n + d.you, 0)).toBe(0);
      expect((await call(w.owner, "/activity?until=nope")).status).toBe(400);
    });

    it("deleted: blank = placeholder title, no text, nothing beside or under it", async () => {
      const mk = async (title: string, markdown: string) => {
        const id = await w.note("x\n");
        await seedQ(`UPDATE content_nodes SET title = $2, markdown = $3 WHERE id = $1`, [id, title, markdown]);
        return id;
      };
      const empty = await mk("", "");
      const spaces = await mk("  ", " \n\n");
      const untitledZh = await mk("未命名", "");
      const untitledEn = await mk("Untitled", "  \n");
      const daily = await mk("2026-10-20", "");
      const titled = await mk("Has title", "");
      const texted = await mk("未命名", "some text");
      const inked = await mk("未命名", "");
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, 'ink_data', '{}')`, [w.ws, inked]);
      const imported = await mk("Untitled", "");
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, '_import_path', 'a.md')`, [w.ws, imported]);
      const board = await mk("Untitled", "");
      await seedQ(`UPDATE content_nodes SET node_type = 'canvas' WHERE id = $1`, [board]);
      const parent = await mk("", "");
      const child = await mk("", "");
      await seedQ(`UPDATE content_nodes SET parent_id = $1 WHERE id = $2`, [parent, child]);
      for (const id of [empty, spaces, untitledZh, untitledEn, daily, titled, texted, inked, imported, board, parent]) await trashNode(w.owner, w.ws, id);
      const listed = (await call(w.owner, "/deleted")).body.notes as Array<{ id: string; blank: boolean }>;
      const blank = (id: string) => listed.find((n) => n.id === id)?.blank;
      expect([empty, spaces, untitledZh, untitledEn, daily, imported].map(blank)).toEqual([true, true, true, true, true, true]);
      // A real title, text, handwriting kept beside the text, or a whiteboard is not blank.
      expect([titled, texted, inked, board].map(blank)).toEqual([false, false, false, false]);
      expect(blank(parent)).toBe(false);   // its child was deleted with it
      expect(blank(child)).toBeUndefined(); // listed under its parent
    });

    it("GET /deleted/:id gives a deleted note's last text, only to someone who can read it", async () => {
      const stranger = await persistActor(w.ws, { id: "", name: `Reader ${w.stamp}`, role: "editor", type: "human" });
      await q(`DELETE FROM space_members WHERE actor_id = $1::uuid AND space_id <> (SELECT id FROM spaces WHERE owner_actor_id = $1::uuid AND kind = 'personal')`, [stranger.id]);
      const gone = await w.note("last words\n");
      const live = await w.note("still here\n");
      await trashNode(w.owner, w.ws, gone);
      const res = await call(w.owner, `/deleted/${gone}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: gone, markdown: "last words\n" });
      expect(typeof res.body.deleted_at).toBe("string");
      expect((await call(w.owner, `/deleted/${live}`)).status).toBe(404);          // not deleted
      expect((await call(stranger, `/deleted/${gone}`)).status).toBe(404);          // not theirs to read
      expect((await call(w.owner, "/deleted/not-an-id")).status).toBe(400);          // not an id at all (routes/params.ts uuidParam)
    });

    describe("POST /deleted/purge", () => {
      let editor: ActorCtx;
      let shared = "";
      beforeAll(async () => {
        editor = await persistActor(w.ws, { id: "", name: `Editor ${w.stamp}`, role: "editor", type: "human" });
        shared = await makeSpace(w.ws, `purge space ${w.stamp}`, [{ id: w.owner.id, role: "manager" }, { id: editor.id, role: "editor" }]);
      });
      const deletedNote = async (markdown = "") => {
        const id = await w.note(markdown, shared);
        await seedQ(`UPDATE content_nodes SET title = '' WHERE id = $1`, [id]);
        await trashNode(w.owner, w.ws, id);
        return id;
      };
      const exists = async (id: string) => (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [id])).rowCount === 1;

      it("purges each item with the single-note checks and reports each on its own", async () => {
        const [a, b, live] = [await deletedNote(), await deletedNote(), await w.note("alive\n", shared)];
        const res = await call(w.owner, "/deleted/purge", { items: [
          { node_id: a, expected_ids: [a] },
          { node_id: live, expected_ids: [live] },                       // not deleted
          { node_id: b, expected_ids: [b, "00000000-0000-4000-8000-000000000000"] }, // plan changed
          { node_id: a, expected_ids: [a] },                             // already gone
        ] });
        expect(res.status).toBe(200);
        expect(res.body.results).toEqual([
          { node_id: a, purged: true, media_removed: 0 },
          { node_id: live, purged: false, code: "not_deleted" },
          { node_id: b, purged: false, code: "plan_changed" },
          { node_id: a, purged: false, code: "not_found" },
        ]);
        expect(await exists(a)).toBe(false);
        expect(await exists(b)).toBe(true);
        expect(await exists(live)).toBe(true);
      });

      it("refuses a note whose space the caller does not manage, and still purges the rest", async () => {
        const mine = await deletedNote();
        const res = await call(editor, "/deleted/purge", { items: [{ node_id: mine, expected_ids: [mine] }] });
        expect(res.status).toBe(200);
        expect(res.body.results).toHaveLength(1);
        expect(res.body.results[0]).toMatchObject({ node_id: mine, purged: false });
        expect(await exists(mine)).toBe(true);
        // the same call by the manager purges it
        expect((await call(w.owner, "/deleted/purge", { items: [{ node_id: mine, expected_ids: [mine] }] })).body.results[0]).toMatchObject({ purged: true });
        expect(await exists(mine)).toBe(false);
      });

      it("rejects a malformed body", async () => {
        expect((await call(w.owner, "/deleted/purge", { items: [] })).status).toBe(400);
        expect((await call(w.owner, "/deleted/purge", { items: [{ node_id: "x", expected_ids: ["y"] }] })).status).toBe(400);
        expect((await call(w.owner, "/deleted/purge", { items: [{ node_id: crypto.randomUUID() }] })).status).toBe(400);
      });

      it("agrees with purgeDeleted run directly on a live descendant", async () => {
        const parent = await deletedNote();
        const kid = await w.note("kid\n", shared);
        await seedQ(`UPDATE content_nodes SET parent_id = $1 WHERE id = $2`, [parent, kid]);
        const res = (await call(w.owner, "/deleted/purge", { items: [{ node_id: parent, expected_ids: [parent] }] })).body.results[0];
        expect(res).toEqual({ node_id: parent, purged: false, code: "live_descendant" });
        await expect(purgeDeleted(w.owner, w.ws, parent, { expected: [parent] })).rejects.toMatchObject({ code: "live_descendant" });
      });
    });
  });
});
