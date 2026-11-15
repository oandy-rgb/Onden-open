// The workspace's calendar clock (services/workspaceTime.ts, localDay.ts):
//   • PATCH /api/workspace/time is the owner's alone; an unknown zone or hour is
//     a 400 and no string reaches SQL; changing it writes WORKSPACE_TIME_ZONE_CHANGED
//     with the old and new values, and changing nothing writes nothing.
//   • It takes effect at once, with no restart: localDayId, the agenda's buckets,
//     History's day cuts — and a pooled connection opened before the change does
//     not keep the old zone (sessions stay UTC; the SQL names the zone).
//   • Recurring tasks: whichever way the zone moves, a day is not rolled twice
//     and not skipped — exactly one open occurrence stays.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import workspaceRouter from "../routes/workspace.js";
import historyRouter from "../routes/history.js";
import { createNote } from "../services/noteCreate.js";
import { mountModules } from "../modules/index.js";
import { tasksModule } from "../modules/tasks/index.js";
import { drainDueTasks } from "../modules/tasks/scheduler.js";
import { dayClock, localDayId, resetDayClock, setDayClock, sqlDayStart, sqlLocalDay, workspaceTimeZone } from "../localDay.js";
import { buildBootstrap } from "../services/sync/bootstrap.js";
import { buildSyncDelta } from "../services/sync/delta.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("workspace time (DB)", () => {
  let owner: ActorCtx;
  let editor: ActorCtx;
  let actor: ActorCtx | null = null;
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/workspace", workspaceRouter);
  app.route("/api/history", historyRouter);

  const as = (who: ActorCtx) => { actor = who; };
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setTime = (body: unknown) => send("PATCH", "/api/workspace/time", body);
  const stored = async () => (await q<{ time_zone: string | null; day_start_hour: number }>(
    `SELECT time_zone, day_start_hour FROM workspaces WHERE id = $1`, [WS])).rows[0]!;
  const changedEvents = async () => (await q<{ payload: { from: unknown; to: unknown }; actor_id: string }>(
    `SELECT payload, actor_id FROM domain_events WHERE workspace_id = $1 AND event_type = 'WORKSPACE_TIME_ZONE_CHANGED' ORDER BY id`, [WS])).rows;

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Workspace time', $1) RETURNING id`, [`workspace-time-${Date.now()}`])).rows[0]!.id;
    owner = await persistActor(WS, { id: "", name: "Owner", type: "human", role: "admin" });
    editor = await persistActor(WS, { id: "", name: "Editor", type: "human", role: "editor" });
    await setWorkspaceOwner(WS, owner.id);
    await setModulesOn(WS, null);
    mountModules(app, [tasksModule]);
  });
  afterEach(async () => {
    await q(`UPDATE workspaces SET time_zone = NULL, day_start_hour = 0 WHERE id = $1`, [WS]);
    resetDayClock();
  });
  afterAll(async () => { await pool.end(); });

  describe("the setting", () => {
    it("is the owner's: an editor is refused and nothing changes", async () => {
      as(editor);
      expect((await setTime({ time_zone: "Asia/Taipei" })).status).toBe(403);
      expect((await setTime({ day_start_hour: 3 })).status).toBe(403);
      expect(await stored()).toEqual({ time_zone: null, day_start_hour: 0 });
      expect(workspaceTimeZone()).not.toBe("Asia/Taipei");
    });

    it("saves a zone and a day start hour, answers today on the new clock, and writes one event with before and after", async () => {
      as(owner);
      const eventsBefore = (await changedEvents()).length;
      const res = await setTime({ time_zone: "Asia/Taipei", day_start_hour: 4 });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ time_zone: "Asia/Taipei", day_start_hour: 4, today: localDayId() });
      expect(await stored()).toEqual({ time_zone: "Asia/Taipei", day_start_hour: 4 });
      expect(dayClock()).toEqual({ timeZone: "Asia/Taipei", dayStartHour: 4 });
      const events = await changedEvents();
      expect(events).toHaveLength(eventsBefore + 1);
      expect(events.at(-1)).toMatchObject({
        actor_id: owner.id,
        payload: { from: { time_zone: null, day_start_hour: 0 }, to: { time_zone: "Asia/Taipei", day_start_hour: 4 } },
      });
    });

    it("sets one field without touching the other, and null goes back to the server default", async () => {
      as(owner);
      expect((await setTime({ time_zone: "Asia/Tokyo" })).status).toBe(200);
      expect((await setTime({ day_start_hour: 2 })).status).toBe(200);
      expect(await stored()).toEqual({ time_zone: "Asia/Tokyo", day_start_hour: 2 });
      expect((await setTime({ time_zone: null })).status).toBe(200);
      expect(await stored()).toEqual({ time_zone: null, day_start_hour: 2 });
      expect(workspaceTimeZone()).toBe("UTC");
    });

    it("refuses what is not a known zone or an hour from 0 to 6, with a 400 and no change", async () => {
      as(owner);
      const before = (await changedEvents()).length;
      for (const bad of [
        { time_zone: "Mars/Olympus" },
        { time_zone: "taipei" },
        { time_zone: "UTC'; DROP TABLE workspaces; --" },
        { time_zone: "Asia/Taipei' || (SELECT 1) || '" },
        { time_zone: "" },
        { time_zone: 8 },
        { day_start_hour: 7 },
        { day_start_hour: -1 },
        { day_start_hour: 1.5 },
        { day_start_hour: "4" },
        { sneaky: true },
      ]) {
        expect((await setTime(bad)).status, JSON.stringify(bad)).toBe(400);
      }
      expect(await stored()).toEqual({ time_zone: null, day_start_hour: 0 });
      expect((await changedEvents()).length).toBe(before);
      // the tables are still there
      expect((await q(`SELECT 1 FROM workspaces WHERE id = $1`, [WS])).rows).toHaveLength(1);
    });

    it("a change that changes nothing writes no event", async () => {
      as(owner);
      expect((await setTime({ time_zone: "Asia/Taipei" })).status).toBe(200);
      const before = (await changedEvents()).length;
      expect((await setTime({ time_zone: "Asia/Taipei", day_start_hour: 0 })).status).toBe(200);
      expect((await changedEvents()).length).toBe(before);
      as(editor);
      expect((await setTime({ time_zone: "Asia/Taipei" })).status).toBe(403);
    });

    it("rides the bootstrap and the sync delta, so another open device gets it", async () => {
      as(owner);
      const cursor = (await buildBootstrap(owner, WS, { slimBodies: true, metaOnly: true })).last_event_id as string;
      expect((await setTime({ time_zone: "Asia/Taipei", day_start_hour: 3 })).status).toBe(200);
      const boot = await buildBootstrap(owner, WS, { slimBodies: true, metaOnly: true });
      expect(boot.workspace).toMatchObject({ time_zone: "Asia/Taipei", day_start_hour: 3 });
      expect(boot.timezone).toBe("Asia/Taipei");
      const delta = await buildSyncDelta(owner, WS, { since: Number(cursor), known: [] });
      expect(delta.workspace).toMatchObject({ time_zone: "Asia/Taipei", day_start_hour: 3 });
    });
  });

  describe("takes effect at once", () => {
    // UTC-11 and UTC+14 are 25 hours apart, so their days differ by one or two.
    const west = { timeZone: "Pacific/Pago_Pago", dayStartHour: 0 };
    const east = { timeZone: "Pacific/Kiritimati", dayStartHour: 0 };
    const addDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

    it("localDayId follows the zone and the start hour with no restart", async () => {
      as(owner);
      const now = new Date();
      await setTime({ time_zone: west.timeZone });
      expect(localDayId()).toBe(localDayId(now, west));
      await setTime({ time_zone: east.timeZone });
      expect(localDayId()).toBe(localDayId(now, east));
      await setTime({ time_zone: "UTC", day_start_hour: 6 });
      expect(localDayId()).toBe(new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 10));
    });

    it.skipIf(needsSecondConnection)("a connection opened before the change does not keep the old zone", async () => {
      as(owner);
      const client = await pool.connect();
      try {
        const probe = (iso: string) => client.query<{ day: string }>(`SELECT ${sqlLocalDay("$1::timestamptz")} AS day`, [iso]).then((r) => r.rows[0]!.day);
        await setTime({ time_zone: "UTC" });
        expect(await probe("2026-10-12T20:00:00Z")).toBe("2026-10-12");
        await setTime({ time_zone: "Asia/Taipei" });
        expect(await probe("2026-10-12T20:00:00Z")).toBe("2026-10-13");
        await setTime({ day_start_hour: 5 });
        expect(await probe("2026-10-12T20:00:00Z")).toBe("2026-10-12"); // 04:00 on the 13th still counts as the 12th
        expect(await probe("2026-10-12T21:00:00Z")).toBe("2026-10-13");
        expect((await client.query<{ TimeZone: string }>("SHOW TimeZone")).rows[0]!.TimeZone).toBe("UTC");
        const start = await client.query<{ at: Date }>(`SELECT ${sqlDayStart("'2026-10-13'::date")} AS at`);
        expect(start.rows[0]!.at.toISOString()).toBe("2026-10-12T21:00:00.000Z");
      } finally {
        client.release();
      }
    });

    it("the agenda buckets a task by the new day", async () => {
      as(owner);
      await setTime({ time_zone: west.timeZone });
      const today = localDayId();
      const res = await send("POST", "/api/tasks", { id: crypto.randomUUID(), title: "Bucket probe", when_date: today });
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { id: string }).id;
      const bucketOf = async () => {
        const agenda = (await (await send("GET", "/api/tasks/agenda")).json()) as { buckets: Record<string, Array<{ id: string }>> };
        return Object.entries(agenda.buckets).find(([, list]) => list.some((t) => t.id === id))?.[0];
      };
      expect(await bucketOf()).toBe("today");
      await setTime({ time_zone: east.timeZone });
      const later = localDayId();
      expect(await bucketOf()).toBe(later > today ? "overdue" : "today");
      // starting the day late can hold today back
      await setTime({ time_zone: "UTC", day_start_hour: 0 });
      expect(await bucketOf()).toBe(localDayId() === today ? "today" : localDayId() > today ? "overdue" : "upcoming");
      expect(addDays(today, 0)).toBe(today);
    });
  });

  describe("History's day cuts", () => {
    it("cut the day at the start hour: a save at 04:00 in Taipei is the 11th at hour 0 and the 10th at hour 5, and end_at moves with it", async () => {
      as(owner);
      const note = await createNote({ actor: owner, workspaceId: WS, title: `History cut ${Date.now()}`, markdown: "hello", event: { uiContext: "test" } });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica"); // domain_events is append-only
        await client.query(`UPDATE domain_events SET created_at = '2026-03-10T20:00:00Z' WHERE workspace_id = $1 AND target_id = $2`, [WS, note.node.id]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const feed = async () => (await (await send("GET", "/api/history/feed?until=2026-03-11&days=2")).json()) as { days: Array<{ date: string; end_at: string; notes: Array<{ id: string }> }> };
      const dayOf = async () => (await feed()).days.find((d) => d.notes.some((n) => n.id === note.node.id));

      await setTime({ time_zone: "Asia/Taipei", day_start_hour: 0 });
      expect(await dayOf()).toMatchObject({ date: "2026-03-11", end_at: "2026-03-11T15:59:59.999Z" });
      await setTime({ day_start_hour: 5 });
      expect(await dayOf()).toMatchObject({ date: "2026-03-10", end_at: "2026-03-10T20:59:59.999Z" });
      const activity = (await (await send("GET", "/api/history/activity?until=2026-03-11&days=2")).json()) as { days: Array<{ date: string; you: number }> };
      expect(activity.days.find((d) => d.date === "2026-03-10")!.you).toBeGreaterThan(0);
      expect(activity.days.find((d) => d.date === "2026-03-11")!.you).toBe(0);
    });
  });

  describe("recurring tasks across a changed clock", () => {
    const west = { timeZone: "Pacific/Pago_Pago", dayStartHour: 0 };
    const east = { timeZone: "Pacific/Kiritimati", dayStartHour: 0 };
    const addDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

    const occurrences = async (title: string) => (await q<{ status: string; when_date: string | null }>(
      `SELECT s.value AS status, w.value AS when_date
         FROM content_nodes t
         JOIN node_attributes s ON s.node_id = t.id AND s.key = '_task_status'
    LEFT JOIN node_attributes w ON w.node_id = t.id AND w.key = '_task_when'
        WHERE t.workspace_id = $1 AND t.title = $2 AND t.deleted_at IS NULL`, [WS, title])).rows;
    const open = (rows: Array<{ status: string; when_date: string | null }>) => rows.filter((r) => r.status !== "done" && r.status !== "cancelled");
    const mint = async (title: string, when: string) => {
      as(owner);
      const res = await send("POST", "/api/tasks", { id: crypto.randomUUID(), title, when_date: when, recur: "1d" });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };

    it("moving the zone forward, back, and forward again never rolls a day twice or skips one", async () => {
      as(owner);
      setDayClock(west);
      const title = `Daily ${Date.now()}`;
      const start = addDays(localDayId(), -3);
      await mint(title, start);

      await drainDueTasks();
      let rows = await occurrences(title);
      expect(rows).toHaveLength(2);
      expect(open(rows)).toHaveLength(1);
      const first = open(rows)[0]!.when_date!;
      expect(first).toBe(addDays(localDayId(), 1));

      await drainDueTasks(); // same day again: nothing to do
      expect(await occurrences(title)).toHaveLength(2);

      setDayClock(east); // forward: today can only be later
      await drainDueTasks();
      rows = await occurrences(title);
      expect(open(rows)).toHaveLength(1);
      expect(new Set(open(rows).map((r) => r.when_date)).size).toBe(1);
      expect(open(rows)[0]!.when_date! >= localDayId()).toBe(true); // due today is not yet missed
      // at most one roll per tick, and a roll only when the day had really passed
      expect(rows.length).toBe(localDayId() > first ? 3 : 2);

      const afterEast = rows.length;
      setDayClock(west); // back: the open occurrence is in the future, nothing rolls
      await drainDueTasks();
      expect(await occurrences(title)).toHaveLength(afterEast);
      expect(open(await occurrences(title))).toHaveLength(1);
    });

    it("changing the start hour does the same: one open occurrence, no repeat of a day", async () => {
      as(owner);
      setDayClock({ timeZone: "UTC", dayStartHour: 0 });
      const title = `Daily hour ${Date.now()}`;
      await mint(title, addDays(localDayId(), -2));
      await drainDueTasks();
      const afterFirst = await occurrences(title);
      expect(open(afterFirst)).toHaveLength(1);
      for (const hour of [6, 0, 3, 0]) {
        setDayClock({ timeZone: "UTC", dayStartHour: hour });
        await drainDueTasks();
        const rows = await occurrences(title);
        expect(open(rows), `hour ${hour}`).toHaveLength(1);
        const whens = rows.map((r) => r.when_date);
        expect(new Set(whens).size, "no day minted twice").toBe(whens.length);
      }
    });

    it("finishing an occurrence on the new clock makes exactly one next one, once", async () => {
      as(owner);
      await setTime({ time_zone: east.timeZone });
      const title = `Finish ${Date.now()}`;
      const id = await mint(title, localDayId());
      for (let i = 0; i < 2; i++) expect((await send("PATCH", `/api/tasks/${id}`, { status: "done" })).status).toBe(200);
      const rows = await occurrences(title);
      expect(rows.filter((r) => r.status === "done")).toHaveLength(1);
      expect(open(rows)).toHaveLength(1);
      expect(open(rows)[0]!.when_date).toBe(addDays(localDayId(), 1));
    });
  });
});
