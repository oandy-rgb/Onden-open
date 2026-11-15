import { persistActor } from "./helpers/persistActor.js";
// D8 Tasks Phase 3 against a real Postgres: server-computed agenda buckets,
// rich statuses, and break-or-make recurrence — on the tasks-as-nodes storage
// (migration 062: a task is a hidden #task child node with _task_* attrs).
//
//   - buckets classify by due date + status (overdue/today/upcoming/waiting/
//     later/unscheduled), server-side;
//   - completing a recurring task MINTS the next occurrence (a real task node
//     + a NODE_CREATED event chained to the completion) — "make";
//   - the time-trigger (drainDueTasks) cancels an UNATTENDED overdue recurring
//     occurrence and mints the next future one — "break"; non-recurring
//     overdue tasks are left alone (they're a human decision);
//   - a viewer's agenda excludes tasks on notes in spaces they are not in.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { log } from "../logger.js";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import nodesRouter from "../routes/nodes.js";
import { drainDueTasks } from "../modules/tasks/scheduler.js";
import { advanceDue, nextDueAfter, isValidRecur } from "../modules/tasks/recurrence.js";
import { K, taskRowById, type TaskRow } from "../services/tasksStore.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { markAsTask } from "./helpers/taskRef.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/tasks", tasksRouter);
app.post("/api/nodes/:id/tasks", addTaskUnderNote);
app.route("/api/nodes", nodesRouter);

const owner: ActorCtx = { id: "t3-owner", name: "Owner", role: "admin", type: "human" };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

describe("recur date math (pure)", () => {
  it("advances by days/weeks/months", () => {
    expect(advanceDue("2026-06-11", "1d")).toBe("2026-06-12");
    expect(advanceDue("2026-06-11", "2w")).toBe("2026-06-25");
    // Month steps clamp to the month's last day instead of spilling over.
    expect(advanceDue("2026-01-31", "1m")).toBe("2026-02-28");
    expect(advanceDue("2028-01-31", "1m")).toBe("2028-02-29");
    expect(advanceDue("2026-03-31T09:00", "1m")).toBe("2026-04-30T09:00");
    expect(advanceDue("2026-01-15", "1m")).toBe("2026-02-15");
    expect(advanceDue("2026-06-11", "1m")).toBe("2026-07-11");
  });
  it("nextDueAfter skips stale slots to the first FUTURE one", () => {
    expect(nextDueAfter("2026-05-01", "1w", "2026-06-11")).toBe("2026-06-12");
    expect(nextDueAfter("2026-06-10", "1d", "2026-06-11")).toBe("2026-06-12");
  });
  it("a zero interval can never reach a future slot — the scheduler must break, not mint", () => {
    // Review 2026-06-11: '0d' advances nowhere; nextDueAfter exhausts its
    // guard and returns the (non-future) original date. drainDueTasks treats
    // any non-future result as chain-broken instead of reminting forever.
    expect(nextDueAfter("2026-06-01", "0d", "2026-06-11")).toBe("2026-06-01");
  });
  it("isValidRecur requires n >= 1 within the <n><d|w|m> shape", () => {
    expect(isValidRecur("1d")).toBe(true);
    expect(isValidRecur("2w")).toBe(true);
    expect(isValidRecur("999m")).toBe(true);
    expect(isValidRecur("0d")).toBe(false);
    expect(isValidRecur("00w")).toBe(false);
    expect(isValidRecur("000m")).toBe(false);
    expect(isValidRecur("1y")).toBe(false);
    expect(isValidRecur("1000d")).toBe(false);
  });
});

describe.skipIf(!isTestDb)("D8 task phase 3 (DB)", () => {
  let WS = "";
  let hostId = "";

  const mkTask = async (body: Record<string, unknown>) =>
    (await (await app.request(`/api/nodes/${hostId}/tasks`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })).json()) as { id: string; due_date: string | null; recur: string | null };

  const patchTask = (id: string, body: Record<string, unknown>) =>
    app.request(`/api/tasks/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const agenda = async () =>
    (await (await app.request("/api/tasks/agenda")).json()) as {
      buckets: Record<string, Array<{ id: string; title: string; bucket: string }>>;
    };

  // Synthesized rows by exact title — the tasks-as-nodes replacement for the
  // old `SELECT … FROM node_tasks WHERE title = …` assertions.
  const tasksByTitle = async (title: string): Promise<TaskRow[]> => {
    const r = await q<TaskRow>(
      `SELECT t.id, t.workspace_id, t.parent_id AS node_id, t.title,
              s.value AS status, d.value AS due_date, r.value AS recur,
              t.created_at, t.updated_at
         FROM content_nodes t
         JOIN function_refs tref ON tref.holder_node_id = t.id AND tref.function_id = 'tasks'
         JOIN node_attributes s ON s.node_id = t.id AND s.key = '${K.status}'
         LEFT JOIN node_attributes d ON d.node_id = t.id AND d.key = '${K.when}'
         LEFT JOIN node_attributes r ON r.node_id = t.id AND r.key = '${K.recur}'
        WHERE t.workspace_id = $1 AND t.deleted_at IS NULL AND t.title = $2
        ORDER BY t.created_at ASC`,
      [WS, title],
    );
    return r.rows;
  };

  // Direct substrate seed (bypasses the API on purpose — for rows the API
  // would reject, e.g. legacy zero-interval recurrence).
  const seedTaskNode = async (opts: { title: string; status?: string; due?: string; recur?: string; host?: string }) => {
    const id = randomUUID();
    await seedQ(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id, hidden)
       VALUES ($1, $2, 'manual', 'content', $3, $4, '', $5, true)`,
      [id, WS, opts.title, `task-${id}`, opts.host ?? hostId],
    );
    await markAsTask(WS, id);
    const attrs: Array<[string, string | undefined]> = [
      [K.status, opts.status ?? "todo"], [K.when, opts.due], [K.recur, opts.recur],
    ];
    for (const [key, value] of attrs) {
      if (value === undefined) continue;
      await seedQ(
        `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
         VALUES ($1, $2, $3, $4, 'text', false, 'explicit')`,
        [WS, id, key, value],
      );
    }
    return id;
  };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    // The scheduler skips a workspace with the tasks module off, and other files leave this shared workspace that way.
    await turnModuleOn(WS, "tasks");
    Object.assign(owner, await persistActor(WS, owner));

    currentActor = owner;
    const n = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1,'manual','content','Task host','t3-host-${Date.now()}') RETURNING id`, [WS]);
    hostId = n.rows[0]!.id;
  });

  it("buckets classify by due date and status, server-side", async () => {
    const stamp = Date.now();
    const overdue = await mkTask({ title: `t3-overdue-${stamp}`, due_date: daysFromNow(-2) });
    const today = await mkTask({ title: `t3-today-${stamp}`, due_date: daysFromNow(0) });
    const upcoming = await mkTask({ title: `t3-upcoming-${stamp}`, due_date: daysFromNow(3) });
    const unsched = await mkTask({ title: `t3-unsched-${stamp}` });
    const waiting = await mkTask({ title: `t3-waiting-${stamp}` });
    expect((await patchTask(waiting.id, { status: "waiting" })).status).toBe(200);
    const later = await mkTask({ title: `t3-later-${stamp}` });
    expect((await patchTask(later.id, { status: "later" })).status).toBe(200);

    const { buckets } = await agenda();
    const inBucket = (b: string, id: string) => buckets[b]!.some((t) => t.id === id);
    expect(inBucket("overdue", overdue.id)).toBe(true);
    expect(inBucket("today", today.id)).toBe(true);
    expect(inBucket("upcoming", upcoming.id)).toBe(true);
    expect(inBucket("unscheduled", unsched.id)).toBe(true);
    expect(inBucket("waiting", waiting.id)).toBe(true);
    expect(inBucket("later", later.id)).toBe(true);

    // done leaves the agenda entirely
    await patchTask(today.id, { status: "done" });
    expect((await agenda()).buckets.today!.some((t) => t.id === today.id)).toBe(false);
  });

  it("completing a recurring task mints the next occurrence (make)", async () => {
    const t = await mkTask({ title: `t3-recur-${Date.now()}`, due_date: daysFromNow(0), recur: "1w" });
    expect((await patchTask(t.id, { status: "done" })).status).toBe(200);

    const rows = (await tasksByTitle((await taskRowById(WS, t.id))!.title)).filter((r) => r.id !== t.id);
    expect(rows.length).toBe(1);
    const next = rows[0]!;
    expect(next.status).toBe("todo");
    expect(next.recur).toBe("1w");
    expect(next.due_date).toBe(daysFromNow(7));
    // The mint is a real NODE (hidden child of the same host, tagged #task).
    expect(next.node_id).toBe(hostId);

    // The mint is chained to the completion in the event log: a NODE_CREATED
    // (the task IS a node now) carrying rolled_from, triggered by the
    // completion's ATTRIBUTE_SET.
    const minted = await q<{ payload: { rolled_from?: string }; triggered_by_event_id: string | null }>(
      `SELECT payload, triggered_by_event_id FROM domain_events
        WHERE event_type = 'NODE_CREATED' AND target_id = $1`, [next.id]);
    expect(minted.rows[0]!.payload.rolled_from).toBe(t.id);
    expect(minted.rows[0]!.triggered_by_event_id).not.toBeNull();
  });

  it("completing a task the scheduler already rolled does NOT mint a second occurrence (M9)", async () => {
    currentActor = owner;
    const stamp = Date.now();
    const t = await mkTask({ title: `t3-m9-${stamp}`, due_date: daysFromNow(-3), recur: "1d" });
    const mintCount = async (): Promise<number> =>
      Number((await q<{ n: string }>(
        `SELECT count(*) AS n FROM domain_events WHERE event_type='NODE_CREATED' AND payload->>'rolled_from' = $1`,
        [t.id],
      )).rows[0]!.n);

    // Scheduler breaks the overdue occurrence: cancels it AND mints the next one.
    await drainDueTasks();
    expect((await taskRowById(WS, t.id))!.status).toBe("cancelled");
    expect(await mintCount(), "scheduler minted exactly one").toBe(1);

    // The user then completes the SAME, already-rolled occurrence. The
    // break-or-make decision must read the live, locked status ('cancelled') —
    // not the pre-tx view — so it does NOT mint a SECOND next occurrence (M9).
    expect((await patchTask(t.id, { status: "done" })).status).toBe(200);
    expect(await mintCount(), "no second occurrence after completing an already-rolled task").toBe(1);
  });

  it("the time-trigger breaks an unattended recurring occurrence and mints the next (break)", async () => {
    const stamp = Date.now();
    const stale = await mkTask({ title: `t3-stale-${stamp}`, due_date: daysFromNow(-10), recur: "1d" });
    const plainOverdue = await mkTask({ title: `t3-plain-${stamp}`, due_date: daysFromNow(-10) });

    const res = await drainDueTasks();
    expect(res.rolled).toBeGreaterThanOrEqual(1);

    const broke = await taskRowById(WS, stale.id);
    expect(broke!.status).toBe("cancelled");
    const missed = await q<{ target_type: string }>(`SELECT target_type FROM domain_events WHERE event_type='TASK_OCCURRENCE_MISSED' AND target_id=$1`, [stale.id]);
    expect(missed.rows.length).toBe(1);
    // A task is a node: the event must fall under node read policy.
    expect(missed.rows[0].target_type).toBe("node");

    const next = (await tasksByTitle(`t3-stale-${stamp}`)).filter((r) => r.id !== stale.id && r.status === "todo");
    expect(next.length).toBe(1);
    expect(next[0]!.due_date! > daysFromNow(-1)).toBe(true); // strictly future-or-today+1

    // Non-recurring overdue is a human decision — untouched.
    const plain = await taskRowById(WS, plainOverdue.id);
    expect(plain!.status).toBe("todo");
  });

  it("the API rejects a zero recur interval on create and patch", async () => {
    const stamp = Date.now();
    const res = await app.request(`/api/nodes/${hostId}/tasks`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `t3-zero-create-${stamp}`, due_date: daysFromNow(1), recur: "0d" }),
    });
    expect(res.status).toBe(400);
    expect((await tasksByTitle(`t3-zero-create-${stamp}`)).length).toBe(0);

    const t = await mkTask({ title: `t3-zero-patch-${stamp}`, due_date: daysFromNow(1), recur: "1d" });
    expect((await patchTask(t.id, { recur: "0w" })).status).toBe(400);
    expect((await patchTask(t.id, { recur: "00m" })).status).toBe(400);
    expect((await patchTask(t.id, { recur: "2w" })).status).toBe(200); // valid recur still flows
  });

  it("the scheduler BREAKS a chain that cannot reach a future occurrence instead of minting", async () => {
    const stamp = Date.now();
    // 2000 days overdue with '1d': nextDueAfter's 1000-step advance guard caps
    // out at a PAST date. Pre-fix, the scheduler minted that overdue successor
    // and the next tick cancelled + reminted it — the same task, forever.
    const id = await seedTaskNode({ title: `t3-exhaust-${stamp}`, due: daysFromNow(-2000), recur: "1d" });

    await drainDueTasks();
    expect((await taskRowById(WS, id))!.status).toBe("cancelled");

    // Chain broken terminally: no successor node, and the missed event says why.
    expect((await tasksByTitle(`t3-exhaust-${stamp}`)).filter((r) => r.id !== id).length).toBe(0);
    const missed = await q<{ payload: { chain_broken?: boolean } }>(
      `SELECT payload FROM domain_events WHERE event_type = 'TASK_OCCURRENCE_MISSED' AND target_id = $1`, [id]);
    expect(missed.rows[0]!.payload.chain_broken).toBe(true);

    // The infinite-loop pin: a second tick finds nothing to roll for this chain.
    await drainDueTasks();
    expect((await tasksByTitle(`t3-exhaust-${stamp}`)).filter((r) => r.id !== id).length).toBe(0);
  });

  it("a legacy zero-interval recurrence (pre-060 substrate) is broken by the scheduler, never reminted", async () => {
    // The old node_tasks CHECK retired with the table (migration 062); the
    // reserved attr has no DB constraint, so a legacy '0d' value CAN exist in
    // the substrate. Defense-in-depth: one tick cancels it and mints NOTHING.
    const stamp = Date.now();
    const zeroId = await seedTaskNode({ title: `t3-zero-row-${stamp}`, due: daysFromNow(-3), recur: "0d" });

    await drainDueTasks();
    expect((await taskRowById(WS, zeroId))!.status).toBe("cancelled");
    expect((await tasksByTitle(`t3-zero-row-${stamp}`)).filter((r) => r.id !== zeroId).length).toBe(0);
  });

  it("a stored repeat rule the scheduler cannot parse ('1y', from an old import) is skipped, not retried with an error each tick", async () => {
    const stamp = Date.now();
    const id = await seedTaskNode({ title: `t3-year-row-${stamp}`, due: daysFromNow(-3), recur: "1y" });
    const errors = vi.spyOn(log, "error");
    try {
      await drainDueTasks();
      await drainDueTasks();
      expect(errors.mock.calls.filter((c) => String(c[1]).includes(id))).toEqual([]);
    } finally { errors.mockRestore(); }
    // Left as it was: not cancelled, nothing minted.
    expect((await taskRowById(WS, id))!.status).toBe("todo");
    expect((await tasksByTitle(`t3-year-row-${stamp}`)).filter((r) => r.id !== id).length).toBe(0);
  });

  it("a viewer's agenda excludes tasks on notes in a space they are not in", async () => {
    const stamp = Date.now();
    const secretNode = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1,'manual','content','Secret host ${stamp}','t3-secret-${stamp}') RETURNING id`, [WS]);
    await seedTaskNode({ title: `t3-secret-task-${stamp}`, due: daysFromNow(0), host: secretNode.rows[0]!.id });
    // Hide the host (and its task child) in a space only the owner is in.
    await putInSpace(secretNode.rows[0]!.id, await adminOnlySpace(WS, `t3-sec-${stamp}`, [owner.id]));

    currentActor = await persistActor(WS, { id: "t3-viewer", name: "Viewer", role: "viewer", type: "human" });
    const v = await agenda();
    expect(Object.values(v.buckets).flat().some((t) => t.title === `t3-secret-task-${stamp}`)).toBe(false);

    currentActor = owner;
    const a = await agenda();
    expect(Object.values(a.buckets).flat().some((t) => t.title === `t3-secret-task-${stamp}`)).toBe(true);
  });
});
