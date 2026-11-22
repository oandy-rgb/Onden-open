// Focus records (modules/tasks/focus.ts) under random use, through the real routes (GET/POST/PATCH
// /api/tasks/focus…), with the process clock faked so a run can cross days in milliseconds.
//
// What the app sends is what the frontend writer sends (lib/data/focusWriter.ts) and the focus
// store reads (lib/focus/focusStore.ts):
//   start   POST /api/tasks/focus        { id, task_id? }            + started_at only while offline
//   end     POST /api/tasks/focus/:id/end { note?, to_diary?, to_task? }  + ended_at only while offline
//   read    GET  /api/tasks/focus        (the running record is the server's truth)
// The app sends no edit and has no delete; both are driven anyway (an API client or an agent could
// send an edit), a delete has no route and must answer "not found", not 500.
//
// One person on two devices ("A" and "B": each knows the record it started or last read), offline
// presses that are delivered much later (their time travels with them), long gaps (days), a replay
// of a lost answer (same id), and a second person whose records are not this person's.
//
// Invariants:
//  F1  nothing answers a 500 (and every refusal carries a status below 500);
//  F2  a person has at most one running record;
//  F3  a record that ended has 0 <= duration <= 24 h, and none begins in the future (a minute of slack);
//  F4  (KNOWN, it.fails) from any state the person can reach "no record running" with only what the app
//      sends (GET, then end with no time; if that is refused, end at the time of the press = now);
//  F5  a replay of start (same id) is one record, not two; ending an ended record answers it unchanged;
//  F6  one person's record is never reachable or changed by another (404), and each person's own running
//      record is the one GET /focus answers.
//
// Run count: PROPS_RUNS (default 10: each run is a database session), seed PROPS_SEED.
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.
// Replay: PROPS_SEED=… PROPS_RUNS=… npx vitest run src/test/properties/focusRecords.property.integration.test.ts

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import fc from "fast-check";

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));

import { apiOnError } from "../../httpError.js";
import { pool, q } from "../../db.js";
import { resetDayClock } from "../../localDay.js";
import tasksRouter from "../../modules/tasks/routes.js";
import { awaitAllDispatchers } from "../../services/dispatcherQueue.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { checkAsync } from "../helpers/propsConfig.js";

const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 10;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 2, 1, 12, 0, 0);

type Device = "A" | "B";
type Op =
  | { k: "advance"; ms: number }
  | { k: "start"; dev: Device; offline: boolean; delay: number; replay: boolean; withTask: boolean }
  | { k: "end"; dev: Device; offline: boolean; delay: number; note: boolean; diary: boolean; task: boolean; again: boolean }
  | { k: "reload"; dev: Device }
  | { k: "edit"; field: "start" | "end" | "note" | "both"; shift: number }
  | { k: "delete" }
  | { k: "other"; what: "start" | "end" | "touchMine" }
  | { k: "escape" };

const gapArb = fc.constantFrom(1, 20, 59, 61, 90, 6 * 60, 23 * 60, 24 * 60 - 1, 24 * 60 + 1, 30 * 60, 3 * 24 * 60, 9 * 24 * 60).map((m) => m * MIN);
const delayArb = fc.constantFrom(0, 0, 0, 2 * MIN, 50 * MIN, 5 * HOUR, 26 * HOUR, 3 * DAY);
const deviceArb = fc.constantFrom<Device>("A", "B");
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: gapArb.map((ms) => ({ k: "advance", ms }) as Op) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("start" as const), dev: deviceArb, offline: fc.boolean(), delay: delayArb, replay: fc.boolean(), withTask: fc.boolean() }) },
  { weight: 5, arbitrary: fc.record({ k: fc.constant("end" as const), dev: deviceArb, offline: fc.boolean(), delay: delayArb, note: fc.boolean(), diary: fc.boolean(), task: fc.boolean(), again: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("reload" as const), dev: deviceArb }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("edit" as const), field: fc.constantFrom("start", "end", "note", "both"), shift: fc.constantFrom(-26 * HOUR, -5 * HOUR, -MIN, 0, MIN, 3 * HOUR, 40 * HOUR) }) },
  { weight: 1, arbitrary: fc.constant({ k: "delete" } as Op) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("other" as const), what: fc.constantFrom("start", "end", "touchMine") }) },
  { weight: 1, arbitrary: fc.constant({ k: "escape" } as Op) },
);
const opsArb = fc.array(opArb, { minLength: 1, maxLength: 14 });

afterAll(async () => { vi.useRealTimers(); resetDayClock(); await awaitAllDispatchers(); await pool.end(); });

describe.skipIf(!isTestDatabase())("focus records under random use (property)", () => {
  let me: ActorCtx;
  let other: ActorCtx;
  let who: ActorCtx;
  const taskIds: string[] = [];
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", who); await next(); });
  app.route("/tasks", tasksRouter);
  registerShippedModules();

  const send = async (as: ActorCtx, method: string, path: string, body?: unknown) => {
    who = as;
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
  };

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Focus props', $1) RETURNING id`, [`focus-props-${Date.now()}`])).rows[0]!.id;
    me = await persistActor(WS, { id: "", name: "Me", type: "human", role: "admin" });
    other = await persistActor(WS, { id: "", name: "Other", type: "human", role: "editor" });
    for (let i = 0; i < 2; i++) {
      const res = await send(me, "POST", "/tasks", { id: randomUUID(), title: `focus task ${i}` });
      expect(res.status, res.text).toBe(201);
      taskIds.push(res.body.id);
    }
  });

  type Row = { id: string; actor_id: string; started_at: Date; ended_at: Date | null };
  const rowsOf = async (actor: ActorCtx) => (await q<Row>(`SELECT id::text, actor_id::text, started_at, ended_at FROM focus_sessions WHERE actor_id = $1 ORDER BY started_at`, [actor.id])).rows;

  /** The app's way out of a running record: read the server's truth, end with no time, then end at the time of the press (now). */
  async function escapeWithAppRequests(trace: string[]): Promise<{ stuck: string | null }> {
    const read = await send(me, "GET", "/tasks/focus");
    if (read.status !== 200) return { stuck: `GET /focus answered ${read.status}` };
    const running = read.body.running as { id: string } | null;
    if (!running) return { stuck: null };
    const first = await send(me, "POST", `/tasks/focus/${running.id}/end`, {});
    trace.push(`  escape: end with no time → ${first.status} ${first.body?.error ?? ""}`);
    if (first.status >= 400) {
      const second = await send(me, "POST", `/tasks/focus/${running.id}/end`, { ended_at: new Date().toISOString() });
      trace.push(`  escape: end at press time → ${second.status} ${second.body?.error ?? ""}`);
    }
    const after = await send(me, "GET", "/tasks/focus");
    return { stuck: after.body?.running ? `record ${after.body.running.id} (started ${after.body.running.started_at}) is still running at ${new Date().toISOString()}` : null };
  }

  /** Run `ops`; `escapeIsInvariant` makes F4 (and the "escape" op) fail the run, else it is left to its own property. */
  async function play(ops: Op[], opts: { checkEscape: boolean }): Promise<void> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    await q(`DELETE FROM focus_sessions WHERE actor_id = ANY($1::uuid[])`, [[me.id, other.id]]);
    const trace: string[] = [];
    const fail = (m: string) => `${m}\nsteps (clock ${new Date(START).toISOString()}):\n${trace.join("\n")}`;
    const known: Record<Device, string | null> = { A: null, B: null };
    let lastStartId: string | null = null;
    let otherRunning: string | null = null;
    const ours = new Set<string>();

    const answered = (res: { status: number; text: string }, what: string) => {
      trace.push(`  ${what} → ${res.status}${res.status >= 400 ? ` ${res.text.slice(0, 80)}` : ""}`);
      expect(res.status, fail(`F1 ${what} answered ${res.status}: ${res.text.slice(0, 300)}`)).toBeLessThan(500);
    };

    const invariants = async () => {
      for (const actor of [me, other]) {
        const rows = await rowsOf(actor);
        const running = rows.filter((r) => r.ended_at === null);
        expect(running.length, fail(`F2 ${actor === me ? "me" : "other"} has ${running.length} running records`)).toBeLessThanOrEqual(1);
        for (const r of rows) {
          expect(r.started_at.getTime(), fail(`F3 ${r.id} begins in the future`)).toBeLessThanOrEqual(Date.now() + MIN);
          if (r.ended_at) {
            const length = r.ended_at.getTime() - r.started_at.getTime();
            expect(length, fail(`F3 ${r.id} lasts ${length} ms`)).toBeGreaterThanOrEqual(0);
            expect(length, fail(`F3 ${r.id} lasts ${length} ms`)).toBeLessThanOrEqual(DAY);
          }
        }
        const read = await send(actor, "GET", "/tasks/focus");
        answered(read, "GET /focus");
        expect(read.body?.running?.id ?? null, fail(`F6 GET /focus running of ${actor === me ? "me" : "other"}`)).toBe(running[0]?.id ?? null);
      }
    };

    for (const op of ops) {
      trace.push(`${JSON.stringify(op)} (now ${new Date().toISOString()})`);
      if (op.k === "advance") vi.setSystemTime(Date.now() + op.ms);
      else if (op.k === "start") {
        const id: string = op.replay && lastStartId ? lastStartId : randomUUID();
        const pressed = new Date().toISOString();
        vi.setSystemTime(Date.now() + op.delay); // the queue delivers it later
        const body = { id, ...(op.withTask ? { task_id: taskIds[0] } : {}), ...(op.offline ? { started_at: pressed } : {}) };
        const res = await send(me, "POST", "/tasks/focus", body);
        answered(res, `start ${id.slice(0, 4)}`);
        if (res.status === 201) {
          known[op.dev] = id; lastStartId = id; ours.add(id);
          const same = (await rowsOf(me)).filter((r) => r.id === id);
          expect(same.length, fail(`F5 start ${id} made ${same.length} records`)).toBe(1);
        }
      } else if (op.k === "end") {
        const id = known[op.dev];
        if (!id) continue;
        const pressed = new Date().toISOString();
        vi.setSystemTime(Date.now() + op.delay);
        const note = op.note ? { note: "寫完", ...(op.diary ? { to_diary: true } : {}), ...(op.task ? { to_task: true } : {}) } : {};
        const body = { ...(op.offline ? { ended_at: pressed } : {}), ...note };
        const before = (await rowsOf(me)).find((r) => r.id === id);
        const res = await send(me, "POST", `/tasks/focus/${id}/end`, body);
        answered(res, `end ${id.slice(0, 4)}`);
        if (res.status === 200 && before?.ended_at) expect(new Date(res.body.ended_at).getTime(), fail("F5 ending an ended record changed its end")).toBe(before.ended_at.getTime());
        if (res.status === 200) known[op.dev] = null;
        if (op.again) {
          const again = await send(me, "POST", `/tasks/focus/${id}/end`, body);
          answered(again, `end again ${id.slice(0, 4)}`);
          if (res.status === 200) expect(again.body?.ended_at, fail("F5 a retried end answers the same record")).toBe(res.body.ended_at);
        }
      } else if (op.k === "reload") {
        const res = await send(me, "GET", "/tasks/focus");
        answered(res, "reload");
        known[op.dev] = res.body?.running?.id ?? null;
      } else if (op.k === "edit") {
        const id = lastStartId;
        if (!id || !ours.has(id)) continue;
        const row = (await rowsOf(me)).find((r) => r.id === id);
        if (!row) continue;
        const patch: Record<string, string> = {};
        if (op.field === "start" || op.field === "both") patch.started_at = new Date(row.started_at.getTime() + op.shift).toISOString();
        if (op.field === "end" || op.field === "both") patch.ended_at = new Date((row.ended_at ?? new Date()).getTime() + op.shift).toISOString();
        if (op.field === "note") patch.note = `n${op.shift}`;
        answered(await send(me, "PATCH", `/tasks/focus/${id}`, patch), `edit ${JSON.stringify(patch)}`);
      } else if (op.k === "delete") {
        const id = lastStartId ?? randomUUID();
        const res = await send(me, "DELETE", `/tasks/focus/${id}`);
        answered(res, "delete");
        expect([404, 405], fail(`there is no delete route; answered ${res.status}`)).toContain(res.status);
      } else if (op.k === "other") {
        if (op.what === "start") {
          const id = randomUUID();
          const res = await send(other, "POST", "/tasks/focus", { id });
          answered(res, "other start");
          if (res.status === 201) otherRunning = id;
        } else if (op.what === "end") {
          if (otherRunning) {
            const res = await send(other, "POST", `/tasks/focus/${otherRunning}/end`, {});
            answered(res, "other end");
            if (res.status === 200) otherRunning = null;
          }
        } else if (lastStartId && ours.has(lastStartId)) {
          const mine = (await rowsOf(me)).find((r) => r.id === lastStartId);
          const ended = await send(other, "POST", `/tasks/focus/${lastStartId}/end`, {});
          const edited = await send(other, "PATCH", `/tasks/focus/${lastStartId}`, { note: "hijack" });
          const replayed = await send(other, "POST", "/tasks/focus", { id: lastStartId });
          for (const [res, what] of [[ended, "end"], [edited, "edit"], [replayed, "start replay"]] as const) answered(res, `other ${what} of mine`);
          expect([ended.status, edited.status, replayed.status], fail("F6 another person reached my record")).toEqual([404, 404, 409]);
          const after = (await rowsOf(me)).find((r) => r.id === lastStartId);
          expect(after?.ended_at?.getTime() ?? null, fail("F6 my record was changed by another person")).toBe(mine?.ended_at?.getTime() ?? null);
        }
      } else if (opts.checkEscape) {
        const { stuck } = await escapeWithAppRequests(trace);
        expect(stuck, fail(`F4 cannot get to "no record running": ${stuck}`)).toBeNull();
      }
      await invariants();
    }
    if (opts.checkEscape) {
      const { stuck } = await escapeWithAppRequests(trace);
      expect(stuck, fail(`F4 cannot get to "no record running": ${stuck}`)).toBeNull();
    }
    await awaitAllDispatchers();
  }

  it("F1–F3, F5, F6 over random start / end / edit / delete, two devices, offline presses and long gaps", async () => {
    await checkAsync(fc.asyncProperty(opsArb, (ops) => play(ops, { checkEscape: false })), RUN_CAP);
  }, 900_000);

  // KNOWN (F4). A record is refused an end more than 24 h after its start (focus_too_long, MAX_FOCUS_MS), and
  // the app has no other way to end one: ending with no time stamps "now", ending offline stamps the press, and
  // the app sends no edit. A start is not held to the same limit (a queued offline start may carry a time days
  // old), and a record left running overnight is the ordinary way to get there. The person is then stuck: the
  // timer shows it running, every end is refused, and a new start answers 409 focus_running.
  // Turns red the day it is fixed: change `it.fails` to `it`.
  describe("F4 the person can always get to 'no record running' with what the app sends", () => {
    // At least 60 runs even at the default cap: a known failure that a short run can miss would turn red by itself.
    it("random sequences", async () => {
      await checkAsync(fc.asyncProperty(opsArb, (ops) => play(ops, { checkEscape: true })), Math.max(RUN_CAP, 60));
    }, 900_000);

    it("named case: a timer left running for 25 hours cannot be ended (focus.ts assertTimes → focus_too_long)", async () => {
      await play([
        { k: "start", dev: "A", offline: false, delay: 0, replay: false, withTask: false },
        { k: "advance", ms: 25 * HOUR },
        { k: "end", dev: "A", offline: false, delay: 0, note: false, diary: false, task: false, again: false },
        { k: "escape" },
      ], { checkEscape: true });
    });

    // Nightly 2026-11-19, PROPS_SEED=111421 PROPS_RUNS=2000 (found at run 897). Invariant F4: the person can always reach "no record running".
    // Likely cause: an edit may move the start up to a minute past now (F3 slack), and then every end the app sends (no time, or now) is refused focus_ends_before_it_starts.
    it.fails("nightly 2026-11-19: a start edited one minute into the future cannot be ended (seed 111421)", async () => {
      await play([
        { k: "start", dev: "A", offline: false, delay: 0, replay: false, withTask: false },
        { k: "edit", field: "start", shift: MIN },
        { k: "reload", dev: "A" },
        { k: "escape" },
      ], { checkEscape: true });
    });

    it("named case: an offline start delivered 3 days late is accepted, then cannot be ended", async () => {
      await play([
        { k: "start", dev: "A", offline: true, delay: 3 * DAY, replay: false, withTask: false },
        { k: "escape" },
      ], { checkEscape: true });
    });
  });
});
