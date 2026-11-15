// Repeating tasks while the workspace clock moves: time passes, the owner changes the time zone or
// the hour a day starts at (PATCH /api/workspace/time), the scheduler ticks (drainDueTasks), a
// task is finished (PATCH /api/tasks/:id). Date is faked (the process clock), so a run can cross
// weeks in milliseconds; the workspace clock itself is the real one (localDay.ts).
//
// Invariants, checked after every operation, for every repeating chain (tasks of one title):
//  T1  at most one occurrence is open (not done, not cancelled);
//  T2  (fixed mode) no occurrence date appears twice in a chain: a day is never made twice;
//  T3  every date is on the schedule: (date − first date) is a whole number of intervals
//      (fixed mode, d and w tokens);
//  T4  after a scheduler tick the open occurrence is not overdue on the current clock
//      (a repeat is never left behind), and it exists (the chain is not lost);
//  T6  finishing an occurrence and then reopening it (the toast's "undo") keeps the next one that finishing
//      made; the scheduler never makes a second next for it, so no date is made twice (T2) and,
//      after a tick, every open occurrence is on or after today (scan 10 #3);
//  T7  an occurrence set to waiting is never cancelled by a tick (scan 10 #13): the agenda lists it as
//      waiting whatever its date;
//  T5  after finishing the open occurrence, the new open one is the first scheduled date
//      after today (fixed) / today + interval (after mode), computed here by plain stepping.
//
// Not covered: "one daily note per date". The server has no day-note write (modules/daily says
// the frontend creates them, lib/data/dayNotes.ts openToday), so there is nothing here to drive.
//
// Run count: PROPS_RUNS (default 10), seed PROPS_SEED.
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import fc from "fast-check";

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));

import { apiOnError } from "../../httpError.js";
import { pool, q } from "../../db.js";
import { localDayId, resetDayClock } from "../../localDay.js";
import workspaceRouter from "../../routes/workspace.js";
import { mountModules } from "../../modules/index.js";
import { tasksModule } from "../../modules/tasks/index.js";
import { drainDueTasks } from "../../modules/tasks/scheduler.js";
import { awaitAllDispatchers } from "../../services/dispatcherQueue.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";
import { setWorkspaceOwner } from "../helpers/setOwner.js";
import { setModulesOn } from "../helpers/setModulesOn.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { checkAsync } from "../helpers/propsConfig.js";

const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 10;
const HOUR = 3_600_000;
const ZONES = ["UTC", "Asia/Taipei", "America/New_York", "Pacific/Pago_Pago", "Pacific/Kiritimati", "Pacific/Auckland"];

type Op =
  | { k: "advance"; hours: number }
  | { k: "zone"; zone: string }
  | { k: "hour"; hour: number }
  | { k: "tick" }
  | { k: "complete"; chain: number }
  | { k: "reopen"; chain: number }
  | { k: "wait"; chain: number };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant("advance" as const), hours: fc.constantFrom(1, 5, 13, 24, 30, 49, 24 * 9) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("zone" as const), zone: fc.constantFrom(...ZONES) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("hour" as const), hour: fc.integer({ min: 0, max: 6 }) }) },
  { weight: 3, arbitrary: fc.constant({ k: "tick" as const }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("complete" as const), chain: fc.nat(3) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("reopen" as const), chain: fc.nat(3) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("wait" as const), chain: fc.nat(3) }) },
);
const chainArb = fc.record({
  startOffset: fc.integer({ min: -4, max: 2 }),
  interval: fc.constantFrom(1, 2, 3, 7, 14),
  unit: fc.constantFrom("d", "w"),
  mode: fc.constantFrom("fixed", "after"),
});

const addDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

afterAll(async () => { vi.useRealTimers(); resetDayClock(); await awaitAllDispatchers(); await pool.end(); });

describe.skipIf(!isTestDatabase())("repeating tasks across clock changes (property)", () => {
  let owner: ActorCtx;
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", owner); await next(); });
  app.route("/api/workspace", workspaceRouter);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Recurring props', $1) RETURNING id`, [`recurring-props-${Date.now()}`])).rows[0]!.id;
    owner = await persistActor(WS, { id: "", name: "Owner", type: "human", role: "admin" });
    await setWorkspaceOwner(WS, owner.id);
    await setModulesOn(WS, null);
    mountModules(app, [tasksModule]);
  });

  const occurrences = async (title: string) => (await q<{ id: string; status: string; when_date: string }>(
    `SELECT t.id::text, s.value AS status, w.value AS when_date
       FROM content_nodes t
       JOIN node_attributes s ON s.node_id = t.id AND s.key = '_task_status'
       JOIN node_attributes w ON w.node_id = t.id AND w.key = '_task_when'
      WHERE t.workspace_id = $1 AND t.title = $2 AND t.deleted_at IS NULL ORDER BY w.value`, [WS, title])).rows;
  const isOpen = (r: { status: string }) => r.status !== "done" && r.status !== "cancelled";

  it("T1–T5", async () => {
    let run = 0;
    await checkAsync(fc.asyncProperty(
      fc.array(chainArb, { minLength: 1, maxLength: 3 }), fc.array(opArb, { minLength: 1, maxLength: 14 }),
      async (chainSpecs, ops) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.UTC(2026, 2, 1, 12, 0, 0));
        resetDayClock();
        expect((await send("PATCH", "/api/workspace/time", { time_zone: "UTC", day_start_hour: 0 })).status).toBe(200);
        const trace: string[] = [];
        const fail = (m: string) => `${m}\nsteps:\n${trace.join("\n")}`;
        const chains: Array<{ title: string; first: string; step: number; mode: string; reopened: number; waiting: Set<string> }> = [];
        for (const spec of chainSpecs) {
          const title = `rec ${++run} ${chains.length}`;
          const first = addDays(localDayId(), spec.startOffset);
          const res = await send("POST", "/api/tasks", { id: crypto.randomUUID(), title, when_date: first, recur: `${spec.interval}${spec.unit}`, recur_mode: spec.mode });
          expect(res.status, fail(`create ${title}: ${await res.clone().text()}`)).toBe(201);
          chains.push({ title, first, step: spec.interval * (spec.unit === "w" ? 7 : 1), mode: spec.mode, reopened: 0, waiting: new Set() });
          trace.push(`create ${title} first=${first} every ${spec.interval}${spec.unit} ${spec.mode}`);
        }
        const check = async (afterTick: boolean) => {
          for (const c of chains) {
            const rows = await occurrences(c.title);
            const open = rows.filter(isOpen);
            expect(open.length, fail(`T1 ${c.title}`)).toBeLessThanOrEqual(1 + c.reopened);
            const dates = rows.map((r) => r.when_date);
            for (const id of c.waiting) expect(rows.find((r) => r.id === id)?.status, fail(`T7 ${c.title}: a waiting occurrence was closed by a tick`)).toBe("waiting");
            // after mode: finishing early lands the next one on a date the finished one had (today + interval)
            if (c.mode === "fixed") expect(new Set(dates).size, fail(`T2 ${c.title}: ${dates}`)).toBe(dates.length);
            if (c.mode === "fixed") for (const d of dates) expect(daysBetween(c.first, d) % c.step, fail(`T3 ${c.title} ${d}`)).toBe(0);
            if (afterTick && c.mode === "fixed" && c.waiting.size === 0) {
              expect(open.length, fail(`T4 ${c.title} has no open occurrence`)).toBeGreaterThanOrEqual(1);
              for (const o of open) expect(o.when_date >= localDayId(), fail(`T4 ${c.title} overdue ${o.when_date} < ${localDayId()}`)).toBe(true);
            }
          }
        };
        for (const op of ops) {
          trace.push(`${JSON.stringify(op)} (today ${localDayId()})`);
          if (op.k === "advance") vi.setSystemTime(Date.now() + op.hours * HOUR);
          else if (op.k === "zone") expect((await send("PATCH", "/api/workspace/time", { time_zone: op.zone })).status).toBe(200);
          else if (op.k === "hour") expect((await send("PATCH", "/api/workspace/time", { day_start_hour: op.hour })).status).toBe(200);
          else if (op.k === "tick") await drainDueTasks();
          else if (op.k === "wait") {
            const c = chains[op.chain % chains.length]!;
            const open = (await occurrences(c.title)).filter(isOpen).pop();
            if (open) {
              expect((await send("PATCH", `/api/tasks/${open.id}`, { status: "waiting" })).status, fail(`wait ${c.title}`)).toBe(200);
              c.waiting.add(open.id);
            }
          } else if (op.k === "reopen") {
            const c = chains[op.chain % chains.length]!;
            const done = (await occurrences(c.title)).filter((r) => r.status === "done").pop();
            if (done) {
              expect((await send("PATCH", `/api/tasks/${done.id}`, { status: "todo" })).status, fail(`reopen ${c.title}`)).toBe(200);
              c.reopened++;
            }
          } else {
            const c = chains[op.chain % chains.length]!;
            const open = (await occurrences(c.title)).filter(isOpen);
            if (open.length === 1 && c.reopened === 0 && c.waiting.size === 0) {
              const done = open[0]!;
              const res = await send("PATCH", `/api/tasks/${done.id}`, { status: "done" });
              expect(res.status, fail(`complete ${c.title}`)).toBe(200);
              const after = (await occurrences(c.title)).filter(isOpen);
              expect(after.length, fail(`T5 ${c.title} open after completion`)).toBe(1);
              const today = localDayId();
              let expected: string;
              if (c.mode === "after") expected = addDays(today, c.step);
              else { expected = addDays(done.when_date, c.step); while (expected <= today) expected = addDays(expected, c.step); }
              expect(after[0]!.when_date, fail(`T5 ${c.title} done=${done.when_date} today=${today}`)).toBe(expected);
            }
          }
          await check(op.k === "tick");
        }
        await awaitAllDispatchers();
      },
    ), RUN_CAP);
  }, 600_000);

  const startFixedDaily = async (title: string) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 2, 1, 12, 0, 0));
    resetDayClock();
    expect((await send("PATCH", "/api/workspace/time", { time_zone: "UTC", day_start_hour: 0 })).status).toBe(200);
    const res = await send("POST", "/api/tasks", { id: crypto.randomUUID(), title, when_date: localDayId(), recur: "1d", recur_mode: "fixed" });
    expect(res.status).toBe(201);
  };

  it("named case (scan 10 #3): finish then reopen, and a later tick, make no second chain", async () => {
    await startFixedDaily("named finish-reopen");
    const first = (await occurrences("named finish-reopen"))[0]!;
    expect((await send("PATCH", `/api/tasks/${first.id}`, { status: "done" })).status).toBe(200);
    expect((await send("PATCH", `/api/tasks/${first.id}`, { status: "todo" })).status).toBe(200);
    vi.setSystemTime(Date.UTC(2026, 2, 4, 12, 0, 0));
    await drainDueTasks();
    const rows = await occurrences("named finish-reopen");
    expect(rows.map((r) => r.when_date), "the tick must not make a second next for the reopened task").toEqual(["2026-03-01", "2026-03-02", "2026-03-05"]);
    expect(rows.filter(isOpen).map((r) => r.when_date)).toEqual(["2026-03-05"]);
  });

  it("named case (scan 10 #13): a waiting repeat is not closed and replaced by a todo", async () => {
    await startFixedDaily("named waiting");
    const first = (await occurrences("named waiting"))[0]!;
    expect((await send("PATCH", `/api/tasks/${first.id}`, { status: "waiting" })).status).toBe(200);
    vi.setSystemTime(Date.UTC(2026, 2, 4, 12, 0, 0));
    await drainDueTasks();
    const rows = await occurrences("named waiting");
    expect(rows.map((r) => [r.when_date, r.status])).toEqual([["2026-03-01", "waiting"]]);
  });

  const remindOf = async (id: string) => (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_task_remind_at'`, [id])).rows[0]?.value ?? null;

  it("named case (scan 10 #11): a wall-clock reminder goes with the task's day and time; an exact moment stays", async () => {
    await startFixedDaily("named reminder move");
    const id = (await occurrences("named reminder move"))[0]!.id;
    expect((await send("PATCH", `/api/tasks/${id}`, { time: "15:00", remind_at: "2026-03-01T14:45" })).status).toBe(200);
    // The day moves: the reminder keeps its clock time on the new day.
    expect((await send("PATCH", `/api/tasks/${id}`, { when_date: "2026-03-03" })).status).toBe(200);
    expect(await remindOf(id)).toBe("2026-03-03T14:45");
    // The start time moves: "15 minutes before" follows it.
    expect((await send("PATCH", `/api/tasks/${id}`, { time: "17:00" })).status).toBe(200);
    expect(await remindOf(id)).toBe("2026-03-03T16:45");
    // A reminder named in the same request is the person's choice.
    expect((await send("PATCH", `/api/tasks/${id}`, { when_date: "2026-03-04", remind_at: "2026-03-02T08:00" })).status).toBe(200);
    expect(await remindOf(id)).toBe("2026-03-02T08:00");
    // An exact moment (an instant) is where it was set.
    expect((await send("PATCH", `/api/tasks/${id}`, { remind_at: "2026-03-04T01:00:00.000Z" })).status).toBe(200);
    expect((await send("PATCH", `/api/tasks/${id}`, { when_date: "2026-03-09", time: "10:00" })).status).toBe(200);
    expect(await remindOf(id)).toBe("2026-03-04T01:00:00.000Z");
  });
});
