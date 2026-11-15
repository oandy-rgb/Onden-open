// Multi-replica safety: the periodic task-scheduler tick must run on ONE instance
// at a time. Without leader election every replica rolls the SAME unattended
// overdue recurring task forward each tick (duplicate occurrences / due date
// skipping). A non-blocking advisory lock (mirrors drainOutbox) makes the tick
// mutually exclusive across instances; a loser skips the pass.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q, getWorkspaceId } from "../db.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import nodesRouter from "../routes/nodes.js";
import { tickWithLeaderLock } from "../modules/tasks/scheduler.js";
import { K, TASK_TAG_NAME } from "../services/tasksStore.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const SCHEDULER_TICK_LOCK_KEY = 4_242_044_044; // must match modules/tasks/scheduler.ts

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/tasks", tasksRouter);
app.post("/api/nodes/:id/tasks", addTaskUnderNote);
app.route("/api/nodes", nodesRouter);

let owner: ActorCtx = { id: "sll-owner", name: "Owner", role: "admin", type: "human" };
const daysFromNow = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

describe.skipIf(!isTestDb)("scheduler tick leader-lock (DB)", () => {
  let WS = "", hostId = "";
  const stamp = Date.now();
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    owner = await persistActor(WS, owner);
    currentActor = owner;
    hostId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1,'manual','content','Sched host','sll-host-${stamp}') RETURNING id`, [WS])).rows[0]!.id;
    await seedQ(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       SELECT $1,'manual','class_tag',$2,'tag-task-sll'
       WHERE NOT EXISTS (SELECT 1 FROM content_nodes WHERE workspace_id=$1 AND node_type='class_tag' AND deleted_at IS NULL AND title=$2)`,
      [WS, TASK_TAG_NAME]);
  });

  it.skipIf(needsSecondConnection)("a held lock skips the tick (no roll); releasing it lets the roll happen", async () => {
    currentActor = owner;
    // an UNATTENDED overdue recurring task — a tick would roll it (mint next occurrence)
    const title = `sll-recur-${stamp}`;
    const t = (await (await app.request(`/api/nodes/${hostId}/tasks`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, due_date: daysFromNow(-3), recur: "1w" }),
    })).json()) as { id: string };
    const occurrences = async () =>
      (await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM content_nodes t
            JOIN node_attributes d ON d.node_id = t.id AND d.key = $3
          WHERE t.workspace_id = $1 AND t.title = $2 AND t.deleted_at IS NULL`,
        [WS, title, K.when])).rows[0]!.n;
    expect(await occurrences()).toBe("1");

    // a second instance holds the tick lock → our tick must skip
    const holder = await pool.connect();
    try {
      expect((await holder.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked", [SCHEDULER_TICK_LOCK_KEY])).rows[0]!.locked).toBe(true);
      await tickWithLeaderLock();
      expect(await occurrences(), "tick skipped while another instance holds the lock").toBe("1");
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [SCHEDULER_TICK_LOCK_KEY]).catch(() => {});
      holder.release();
    }

    // lock free → the tick acquires it and rolls the overdue occurrence forward
    await tickWithLeaderLock();
    expect(Number(await occurrences())).toBeGreaterThan(1);
    expect(t.id).toBeTruthy();
  });
});
