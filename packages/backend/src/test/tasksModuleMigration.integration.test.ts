// Migration 135: #task stops being a reserved tag and becomes the tasks
// module's tag; `_task_due` becomes `_task_when`; status `later` becomes
// todo + someday. An old workspace goes on as it was:
//   (a) the task tag keeps its id, name and members, loses reserved_key, gets
//       the module mark, and is not inherited by blocks;
//   (b) tags under it (or the tag itself under another) move to the root, the
//       children extending it so they keep the function (migration 129's rule);
//   (c) a timed due keeps its day in `_task_when` and its time in `_task_remind_at`;
//   (d) `later` is todo + someday; nothing else about a task changes;
//   (e) no node, tag, tag application or task is lost; re-running changes nothing;
//   (f) the agenda still finds every task, with the same buckets.
// Runs on whatever schema the test database was built from: the seeded rows
// are the OLD shape either way.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { taskAgenda } from "../modules/tasks/agenda.js";
import { taskRowById } from "../services/tasksStore.js";
import { taskModuleTagId as taskTagId } from "./helpers/reservedTag.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { migration135Sql } from "./helpers/migration135.js";
import { migration191Sql } from "./helpers/migration191.js";

const MIGRATION = migration135Sql();

describe.skipIf(!isTestDatabase())("migration 135 — the tasks module (DB)", () => {
  const stamp = Date.now();
  const ws: Record<string, string> = {};
  const row: Record<string, string> = {};
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  async function workspace(name: string) {
    ws[name] = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`m135-${name}`, `m135-${name}-${stamp}`])).rows[0]!.id;
  }
  async function node(key: string, w: string, opts: { type?: string; title?: string; parent?: string; reserved?: string; hidden?: boolean; host?: string } = {}) {
    row[key] = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, reserved_key, hidden)
       VALUES ($1, 'manual', $2, $3, $4, '', $5, $6, $7) RETURNING id`,
      [ws[w], opts.type ?? "content", opts.title ?? key, `m135-${randomUUID()}`, opts.parent ? row[opts.parent] : null, opts.reserved ?? null, opts.hidden ?? false])).rows[0]!.id;
  }
  /** A task node of the OLD shape: hidden child of `host`, tagged `tag`, with these attributes. */
  async function task(key: string, w: string, host: string, tag: string, attrs: Record<string, string>) {
    await node(key, w, { parent: host, hidden: true });
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [row[key], row[tag]]);
    for (const [k, v] of Object.entries(attrs)) {
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, $3, $4, $5)`,
        [ws[w], row[key], k, v, /^\d{4}-\d{2}-\d{2}$/.test(v) ? "date" : "text"]);
    }
  }
  const attrs = async (key: string) => Object.fromEntries((await q<{ key: string; value: string; value_type: string }>(
    `SELECT key, value, value_type FROM node_attributes WHERE node_id = $1 ORDER BY key`, [row[key]])).rows.map((r) => [r.key, `${r.value}:${r.value_type}`]));
  const tagRow = async (key: string) => (await q<{ reserved_key: string | null; parent_id: string | null; title: string; module: string | null; extends: string[] | null }>(
    `SELECT reserved_key, parent_id::text, title, tag_schema->>'module' AS module,
            ARRAY(SELECT jsonb_array_elements_text(tag_schema->'extends')) AS extends
       FROM content_nodes WHERE id = $1`, [row[key]])).rows[0]!;
  const counts = async (w: string) => (await q<{ nodes: string; tags: string; applied: string; attrs: string }>(
    `SELECT (SELECT count(*) FROM content_nodes WHERE workspace_id = $1) AS nodes,
            (SELECT count(*) FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag') AS tags,
            (SELECT count(*) FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id WHERE n.workspace_id = $1) AS applied,
            (SELECT count(*) FROM node_attributes WHERE workspace_id = $1) AS attrs`, [ws[w]])).rows[0]!;
  const epoch = async (w: string) => (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [ws[w]])).rows[0]!.e;

  let before: Awaited<ReturnType<typeof counts>>;
  let epochBefore = "";
  let epochOther = "";
  const reader: ActorCtx = { id: "m135-reader", name: "Reader", role: "admin", type: "human" };

  beforeAll(async () => {
    // main: a keyed root #task (renamed by its owner), a tag under it, and a spread of tasks
    await workspace("main");
    await node("taskTag", "main", { type: "class_tag", title: "待辦", reserved: "task" });
    await node("bugTag", "main", { type: "class_tag", title: "bug", parent: "taskTag" });
    await node("host", "main", { title: "Host note" });
    await task("dated", "main", "host", "taskTag", { _task_status: "todo", _task_due: day(2), _task_recur: "1w" });
    await task("timed", "main", "host", "taskTag", { _task_status: "doing", _task_due: `${day(0)}T14:30` });
    await task("parked", "main", "host", "taskTag", { _task_status: "later", _task_due: day(5) });
    await task("parkedNoDay", "main", "host", "taskTag", { _task_status: "later" });
    await task("done", "main", "host", "taskTag", { _task_status: "done", _task_due: day(-1) });
    await task("bare", "main", "host", "taskTag", { _task_status: "todo" });
    // nested: the only #task is a child of another tag
    await workspace("nested");
    await node("outer", "nested", { type: "class_tag", title: "outer" });
    await node("innerTag", "nested", { type: "class_tag", title: "task", parent: "outer", reserved: "task" });
    // none: a workspace that never had a task
    await workspace("none");
    await node("plainTag", "none", { type: "class_tag", title: "task" });
    before = await counts("main");
    epochBefore = await epoch("main");
    epochOther = await epoch("none");
    await seedQ(MIGRATION);
    // On a real database migration 191 runs after 135: the tagged tasks become tasks references.
    await seedQ(migration191Sql());
  });

  it("turns the reserved #task into the tasks module's tag, keeping its id, name and members", async () => {
    expect(await tagRow("taskTag")).toMatchObject({ reserved_key: null, title: "待辦", parent_id: null, module: "tasks" });
    expect(await taskTagId(ws.main!)).toBe(row.taskTag);
    // its six members are tasks now: migration 191 moved their tag rows to tasks references
    expect((await q(`SELECT 1 FROM function_refs WHERE function_id = 'tasks' AND holder_node_id IN (SELECT id FROM content_nodes WHERE workspace_id = $1 AND hidden)`, [ws.main])).rows).toHaveLength(6);
    expect((await q(`SELECT 1 FROM node_tags WHERE tag_id = $1`, [row.taskTag])).rows).toHaveLength(0);
    // a plain #task nobody keyed is an ordinary tag, as before
    expect(await tagRow("plainTag")).toMatchObject({ reserved_key: null, module: null });
    expect(await taskTagId(ws.none!)).toBeNull();
  });

  it("moves tags off the module tag to the root, children extending it (the module tags' rule)", async () => {
    expect(await tagRow("bugTag")).toMatchObject({ parent_id: null, extends: [row.taskTag] });
    expect(await tagRow("innerTag")).toMatchObject({ parent_id: null, module: "tasks", reserved_key: null });
    expect(await epoch("main")).not.toBe(epochBefore);
    expect(await epoch("none")).toBe(epochOther);
  });

  it("renames the day, and a due with a time keeps its time as the reminder", async () => {
    expect(await attrs("dated")).toEqual({ _task_recur: "1w:text", _task_status: "todo:text", _task_when: `${day(2)}:date` });
    expect(await attrs("timed")).toEqual({ _task_remind_at: `${day(0)}T14:30:text`, _task_status: "doing:text", _task_when: `${day(0)}:date` });
    expect(await attrs("done")).toEqual({ _task_status: "done:text", _task_when: `${day(-1)}:date` });
    expect(await attrs("bare")).toEqual({ _task_status: "todo:text" });
  });

  it("turns 'later' into todo + someday, with or without a day", async () => {
    expect(await attrs("parked")).toEqual({ _task_someday: "true:bool", _task_status: "todo:text", _task_when: `${day(5)}:date` });
    expect(await attrs("parkedNoDay")).toEqual({ _task_someday: "true:bool", _task_status: "todo:text" });
  });

  it("loses nothing: the same nodes, tags and tag applications, and the tasks all still tasks", async () => {
    const after = await counts("main");
    // The six tasks' tag rows became tasks references (migration 191); every other tag application is still there.
    expect(after).toMatchObject({ nodes: before.nodes, tags: before.tags });
    expect(Number(after.applied)).toBe(Number(before.applied) - 6);
    expect(Number(after.attrs)).toBe(Number(before.attrs) + 1 /* the timed reminder */ + 2 /* two someday flags */);
    for (const key of ["dated", "timed", "parked", "parkedNoDay", "done", "bare"]) expect(await taskRowById(ws.main!, row[key]!), key).toBeTruthy();
  });

  it("the agenda reads the migrated tasks: days, buckets, the parked ones in 'later'", async () => {
    Object.assign(reader, await persistActor(ws.main!, reader));
    await setWorkspaceOwner(ws.main!, reader.id);
    const agenda = await taskAgenda(reader, ws.main!);
    const bucket = (key: string) => Object.entries(agenda.buckets).find(([, rows]) => rows.some((r) => r.id === row[key]))?.[0] ?? (agenda.done.some((r) => r.id === row[key]) ? "done" : null);
    expect(bucket("dated")).toBe("upcoming");
    expect(bucket("timed")).toBe("today");
    expect(bucket("parked")).toBe("later");
    expect(bucket("parkedNoDay")).toBe("later");
    expect(bucket("bare")).toBe("unscheduled");
    expect(bucket("done")).toBe("done");
    const timed = agenda.buckets.today!.find((r) => r.id === row.timed)!;
    expect(timed).toMatchObject({ when_date: day(0), due_date: day(0), remind_at: `${day(0)}T14:30`, node_id: row.host, status: "doing" });
  });

  it("is repeatable: a second run changes nothing", async () => {
    const snapshot = async () => JSON.stringify([
      await attrs("dated"), await attrs("timed"), await attrs("parked"), await tagRow("taskTag"), await tagRow("bugTag"), await counts("main"),
    ]);
    const first = await snapshot();
    const epochNow = await epoch("main");
    await seedQ(MIGRATION);
    expect(await snapshot()).toBe(first);
    expect(await epoch("main")).toBe(epochNow);
  });

  it("moves the partial index the agenda scans by day to the new key", async () => {
    const index = await q<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'node_attr_task_when'`);
    expect(index.rows[0]?.indexdef).toContain("_task_when");
    expect((await q(`SELECT 1 FROM pg_indexes WHERE indexname = 'node_attr_task_due'`)).rows).toHaveLength(0);
  });
});
