import { persistActor } from "./helpers/persistActor.js";
// Tasks-as-nodes (migration 062) — the node-uniformity migration, pinned:
//
//   • migration 062 converts seeded legacy node_tasks rows into hidden #task
//     child nodes (SAME ids — frontend id continuity), preserves created_at
//     ordering, drops the table, and is re-runnable;
//   • READ-POLICY PAYOFF: a task in a space the viewer is not in disappears
//     from their agenda — impossible with the parallel table, automatic now
//     that task reads flow through node read policy (spaces: a task lives in
//     its host's space, docs/architecture/spaces.md);
//   • API parity: agenda/POST/PATCH keep the FROZEN node_tasks wire shape,
//     synthesized from nodes+attrs;
//   • sync delta: task-node churn travels in `tasks` (synthesized rows), never
//     in `nodes`/`attributes` — no hidden-task pollution of client node lists;
//   • bootstrap synthesis: the general nodes query excludes task nodes, the
//     `tasks` array carries them;
//   • performance: the agenda over 1000 synthetic tasks answers fast (the
//     partial indexes on _task_status/_task_when (062, renamed by 135)).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";

// This router harness injects identity; database snapshot/policy remain real.
vi.mock("../services/actorReadSnapshot.js", () => import("./helpers/injectedActorReadSnapshot.js"));
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { q, pool, getWorkspaceId } from "../db.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import nodesRouter from "../routes/nodes.js";
import syncRouter from "../routes/sync.js";
import {
  K, TASK_TAG_NAME, taskRowsForBootstrap, taskRowById, notATaskNodeSql,
} from "../services/tasksStore.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { migration135Sql } from "./helpers/migration135.js";
import { migration191Sql } from "./helpers/migration191.js";
import { seedQ } from "./helpers/seedQ.js";

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
app.route("/api/sync", syncRouter);

const admin: ActorCtx = { id: "tan-admin", name: "Admin", role: "admin", type: "human" };
const viewer: ActorCtx = { id: "tan-viewer", name: "Viewer", role: "viewer", type: "human" };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

const MIGRATION_062 = resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations/062_tasks_as_nodes.sql");

// The retired node_tasks row shape — the wire contract every task endpoint
// still speaks (lib/api.ts NodeTask + localDb mirror columns).
const TASK_ROW_KEYS = ["id", "workspace_id", "node_id", "title", "status", "due_date", "recur", "created_at", "updated_at",
  // migration 135: standalone tasks, when / evening / someday / deadline / repeat mode / reminder
  "when_date", "evening", "someday", "deadline", "recur_mode", "remind_at", "space_id", "has_body",
  // day timeline: the clock time it starts and ends, and when it was completed
  "time", "until", "done_at", "block_ref"].sort();
const AGENDA_ROW_KEYS = [...TASK_ROW_KEYS, "node_title", "bucket"].sort();
const AGENDA_BUCKETS = ["overdue", "today", "upcoming", "waiting", "later", "unscheduled", "scheduled"].sort();

describe.skipIf(!isTestDb)("tasks as nodes (migration 062)", () => {
  let WS = "";
  let hostId = "";

  const mkTask = async (body: Record<string, unknown>, host = hostId) =>
    (await (await app.request(`/api/nodes/${host}/tasks`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })).json()) as Record<string, unknown> & { id: string };

  const agenda = async () =>
    (await (await app.request("/api/tasks/agenda")).json()) as {
      buckets: Record<string, Array<Record<string, unknown> & { id: string; title: string }>>; count: number;
    };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
    Object.assign(viewer, await persistActor(WS, viewer));

    currentActor = admin;
    const n = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1,'manual','content','TAN host','tan-host-${Date.now()}') RETURNING id`, [WS]);
    hostId = n.rows[0]!.id;
  });

  // ── A. migration 062 carries legacy rows over, same ids ────────────────────
  it("migration 062: converts seeded node_tasks rows to #task nodes (same ids, created_at kept), drops the table, re-runnable", async () => {
    const stamp = `m${Date.now()}`;
    // Seed the legacy shape (as migrations 001+059+060 defined it).
    await q(`CREATE TABLE IF NOT EXISTS node_tasks (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      workspace_id uuid NOT NULL, node_id uuid NOT NULL,
      title text NOT NULL, status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      due_date date, recur text)`);
    const older = await q<{ id: string; created_at: string }>(
      `INSERT INTO node_tasks (workspace_id, node_id, title, status, due_date, recur, created_at)
       VALUES ($1, $2, 'tan-legacy-a-${stamp}', 'todo', CURRENT_DATE, '1w', now() - interval '2 days')
       RETURNING id, created_at`, [WS, hostId]);
    const newer = await q<{ id: string }>(
      `INSERT INTO node_tasks (workspace_id, node_id, title, status)
       VALUES ($1, $2, 'tan-legacy-b-${stamp}', 'done') RETURNING id`, [WS, hostId]);

    const sql = readFileSync(MIGRATION_062, "utf8");
    await pool.query(sql);
    // On a real database migration 100 runs after 062 and keys the #task tag
    // 062 may have just created, and migration 135 turns it into the tasks
    // module's tag and renames _task_due; do the same here.
    await pool.query(`UPDATE content_nodes SET reserved_key = 'task'
      WHERE workspace_id = $1 AND node_type = 'class_tag' AND title = 'task' AND parent_id IS NULL AND deleted_at IS NULL AND reserved_key IS NULL`, [WS]);
    await pool.query(migration135Sql());
    // …and migration 191 moves the task nodes from the tag to the tasks reference.
    await pool.query(migration191Sql());

    // Same id, now a hidden #task child node of the host, created_at preserved.
    const a = await taskRowById(WS, older.rows[0]!.id);
    expect(a).toBeTruthy();
    expect(a!.node_id).toBe(hostId);
    expect(a!.title).toBe(`tan-legacy-a-${stamp}`);
    expect(a!.status).toBe("todo");
    expect(a!.due_date).toBe(iso(new Date()));
    expect(a!.recur).toBe("1w");
    expect(new Date(a!.created_at).toISOString()).toBe(new Date(older.rows[0]!.created_at).toISOString());
    const node = await q<{ hidden: boolean; parent_id: string }>(
      `SELECT hidden, parent_id FROM content_nodes WHERE id = $1`, [older.rows[0]!.id]);
    expect(node.rows[0]!.hidden).toBe(true);
    expect(node.rows[0]!.parent_id).toBe(hostId);

    const b = await taskRowById(WS, newer.rows[0]!.id);
    expect(b!.status).toBe("done");
    expect(b!.due_date).toBeNull();
    expect(b!.recur).toBeNull();

    // The parallel table is gone, and exactly ONE root #task tag exists per workspace.
    const gone = await q<{ reg: string | null }>(`SELECT to_regclass('public.node_tasks')::text AS reg`);
    expect(gone.rows[0]!.reg).toBeNull();
    const tags = await q(
      `SELECT id FROM content_nodes WHERE workspace_id = $1 AND node_type='class_tag' AND deleted_at IS NULL AND title = $2 AND parent_id IS NULL`,
      [WS, TASK_TAG_NAME]);
    expect(tags.rows.length).toBe(1);

    // Re-runnable: a second execution on the already-migrated DB is a no-op.
    await pool.query(sql);
    expect((await taskRowById(WS, older.rows[0]!.id))!.title).toBe(`tan-legacy-a-${stamp}`);
  });

  // ── A2. offline-parity: a client-minted task-node id is HONORED ────────────
  it("honors a client-supplied task-node id (stable optimistic id, no server-minted duplicate)", async () => {
    const clientId = randomUUID();
    const created = await mkTask({ id: clientId, title: `client-minted-${Date.now()}` });
    // The server used the client's id verbatim — so an optimistic offline task
    // reconciles by id when /api/sync arrives, never showing a second copy.
    expect(created.id).toBe(clientId);
    const node = await q<{ parent_id: string; hidden: boolean }>(
      `SELECT parent_id, hidden FROM content_nodes WHERE id = $1`, [clientId]);
    expect(node.rows[0]!.parent_id).toBe(hostId);
    expect(node.rows[0]!.hidden).toBe(true);
    // …and it surfaces on the agenda under that exact id.
    const ag = await agenda();
    const found = Object.values(ag.buckets).flat().find((tk) => tk.id === clientId);
    expect(found, "the client-id task appears on the agenda under its own id").toBeTruthy();
  });

  // ── B. the migration's PAYOFF: read policy reaches individual tasks ────────
  it("READ-POLICY PAYOFF: a task in a space the viewer is not in disappears from their agenda (impossible with node_tasks)", async () => {
    const stamp = Date.now();
    currentActor = admin;
    // A second host in an admin-only space; its tasks live in that space too
    // (a task node takes its host's space). The first host stays in the
    // default space. The old parallel table had no read rule per task at all.
    const secretHost = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1,'manual','content','TAN secret host',$2) RETURNING id`, [WS, `tan-secret-host-${stamp}`])).rows[0]!.id;
    await putInSpace(secretHost, await adminOnlySpace(WS, `tan-sec-${stamp}`, [admin.id]));
    await mkTask({ title: `tan-open-${stamp}`, due_date: daysFromNow(0) });
    await mkTask({ title: `tan-restricted-${stamp}`, due_date: daysFromNow(0) }, secretHost);

    currentActor = viewer;
    const v = await agenda();
    const vTitles = Object.values(v.buckets).flat().map((t) => t.title);
    expect(vTitles).toContain(`tan-open-${stamp}`);       // public sibling still shows
    expect(vTitles).not.toContain(`tan-restricted-${stamp}`);

    currentActor = admin;
    const a = await agenda();
    expect(Object.values(a.buckets).flat().map((t) => t.title)).toContain(`tan-restricted-${stamp}`);
  });

  // ── C. frozen wire shapes ───────────────────────────────────────────────────
  it("agenda parity: bucket set and row fields match the pre-062 contract exactly", async () => {
    const stamp = Date.now();
    currentActor = admin;
    const t = await mkTask({ title: `tan-parity-${stamp}`, due_date: daysFromNow(0), recur: "2w" });
    // POST + PATCH responses carry the full synthesized node_tasks row shape.
    expect(Object.keys(t).sort()).toEqual(TASK_ROW_KEYS);
    const patched = await (await app.request(`/api/tasks/${t.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "doing" }),
    })).json() as Record<string, unknown>;
    expect(Object.keys(patched).sort()).toEqual(TASK_ROW_KEYS);
    expect(patched.status).toBe("doing");

    const a = await agenda();
    expect(Object.keys(a.buckets).sort()).toEqual(AGENDA_BUCKETS);
    expect(typeof a.count).toBe("number");
    const row = Object.values(a.buckets).flat().find((r) => r.id === t.id)!;
    expect(row, "the created task is on the agenda").toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(AGENDA_ROW_KEYS);
    expect(row.bucket).toBe("today");
  });

  it("completed fold: done tasks leave the buckets but ship in the capped `done` tail with an uncapped total", async () => {
    const stamp = Date.now();
    currentActor = admin;
    const t = await mkTask({ title: `tan-done-${stamp}` });
    await app.request(`/api/tasks/${t.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done" }),
    });

    const a = await (await app.request("/api/tasks/agenda")).json() as {
      buckets: Record<string, Array<{ id: string }>>; count: number;
      done: Array<{ id: string; title: string; bucket: string }>; done_total: number;
    };
    // Out of every active bucket…
    expect(Object.values(a.buckets).flat().some((r) => r.id === t.id)).toBe(false);
    // …and in the completed tail (newest-first, so a fresh completion is there
    // even against a lived-in shared test DB), counted uncapped.
    const doneRow = a.done.find((r) => r.id === t.id);
    expect(doneRow, "the completed task ships in the done tail").toBeTruthy();
    expect(doneRow!.bucket).toBe("done");
    expect(a.done.length).toBeLessThanOrEqual(20);
    expect(a.done_total).toBeGreaterThanOrEqual(a.done.filter(Boolean).length > 20 ? 20 : 1);

    // Reopening pulls it back onto the agenda.
    await app.request(`/api/tasks/${t.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "todo" }),
    });
    const b = await agenda();
    expect(Object.values(b.buckets).flat().some((r) => r.id === t.id)).toBe(true);
  });

  it("sync delta: task-node churn travels as synthesized `tasks` rows, never as nodes/attributes", async () => {
    const stamp = Date.now();
    currentActor = admin;
    const before = await q<{ max: string }>(`SELECT COALESCE(MAX(id),0)::text AS max FROM domain_events WHERE workspace_id = $1`, [WS]);
    const t = await mkTask({ title: `tan-sync-${stamp}` });
    await app.request(`/api/tasks/${t.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ due_date: daysFromNow(2), status: "doing" }),
    });

    const delta = await (await app.request(`/api/sync?since=${before.rows[0]!.max}`)).json() as {
      nodes: { upsert: Array<{ id: string }> };
      tasks: { upsert: Array<Record<string, unknown> & { id: string }> };
      attributes: { upsert: Array<{ node_id: string }> };
    };
    const syncedTask = delta.tasks.upsert.find((r) => r.id === t.id)!;
    expect(syncedTask, "the task arrives in tasks.upsert").toBeTruthy();
    expect(Object.keys(syncedTask).sort()).toEqual(TASK_ROW_KEYS);
    expect(syncedTask.status).toBe("doing");
    expect(syncedTask.due_date).toBe(daysFromNow(2));
    // No pollution: the hidden task node is NOT a nodes.upsert row, and its
    // reserved attrs are NOT attribute upserts.
    expect(delta.nodes.upsert.some((n) => n.id === t.id)).toBe(false);
    expect(delta.attributes.upsert.some((rr) => rr.node_id === t.id)).toBe(false);
  });

  it("bootstrap synthesis: the general nodes query excludes task nodes; the tasks array carries them", async () => {
    const stamp = Date.now();
    currentActor = admin;
    const t = await mkTask({ title: `tan-boot-${stamp}`, due_date: daysFromNow(1) });

    // The exact exclusion the bootstrap nodes query applies.
    const nodes = await q<{ id: string }>(
      `SELECT n.id FROM content_nodes n
        WHERE n.workspace_id = $1 AND n.deleted_at IS NULL AND n.id = ANY($2::uuid[])
          AND ${notATaskNodeSql("n")}`,
      [WS, [hostId, t.id]]);
    const ids = nodes.rows.map((r) => r.id);
    expect(ids).toContain(hostId);
    expect(ids).not.toContain(t.id);

    const tasks = await taskRowsForBootstrap(WS, [hostId, t.id]);
    const row = tasks.find((r) => r.id === t.id)!;
    expect(row, "the task is synthesized into the bootstrap tasks array").toBeTruthy();
    expect(row.node_id).toBe(hostId);
  });

  // ── D. performance guard ────────────────────────────────────────────────────
  it("agenda over 1000 synthetic tasks answers fast (partial-index supported)", async () => {
    currentActor = admin;
    const batch = randomUUID().slice(0, 8);
    // 1000 task nodes in 4 set-based statements (uuid derived from the batch +
    // ordinal so the statements line up without a temp table).
    await seedQ(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id, hidden)
       SELECT md5('${batch}-' || i)::uuid, $1, 'manual', 'content', 'perf-${batch}-' || i, 'task-perf-${batch}-' || i, '', $2, true
       FROM generate_series(1, 1000) AS i`, [WS, hostId]);
    await seedQ(
      `INSERT INTO function_refs (workspace_id, function_id, holder_node_id)
       SELECT $1, 'tasks', md5('${batch}-' || i)::uuid FROM generate_series(1, 1000) AS i ON CONFLICT DO NOTHING`, [WS]);
    await seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
       SELECT $1, md5('${batch}-' || i)::uuid, '${K.status}', (ARRAY['todo','doing','waiting','todo'])[1 + i % 4], 'text', false, 'explicit'
       FROM generate_series(1, 1000) AS i`, [WS]);
    await seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
       SELECT $1, md5('${batch}-' || i)::uuid, '${K.when}', to_char(CURRENT_DATE + (i % 14) - 3, 'YYYY-MM-DD'), 'text', false, 'explicit'
       FROM generate_series(1, 1000) AS i WHERE i % 5 <> 0`, [WS]);
    // Every seventh is parked (someday), as 'later' used to be.
    await seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
       SELECT $1, md5('${batch}-' || i)::uuid, '${K.someday}', 'true', 'bool', false, 'explicit'
       FROM generate_series(1, 1000) AS i WHERE i % 7 = 0`, [WS]);
    // Fresh stats so the planner sees the partial indexes. Without them for the tables the tasks join reads, the tests
    // that run after this one (the order is shuffled) make the planner walk every function reference per task.
    for (const table of ["node_attributes", "function_refs", "content_nodes"]) await q(`ANALYZE ${table}`);

    // Warm once (connection + plan), then measure.
    await agenda();
    const t0 = performance.now();
    const a = await agenda();
    const ms = performance.now() - t0;
    expect(a.count).toBeGreaterThanOrEqual(1000);
    // eslint-disable-next-line no-console
    console.log(`[perf] /api/tasks/agenda with ${a.count} open tasks: ${ms.toFixed(1)}ms`);
    // Non-flaky bound (target < 200ms; CI containers jitter, so pin at 1s —
    // a seq-scan regression at this row count blows well past it).
    expect(ms).toBeLessThan(1000);
  });
});
