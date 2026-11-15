// Migration 191: a task node references the tasks function (function_refs) instead of carrying the tasks module's tag.
// A workspace in the OLD shape (task nodes tagged with the module tag, the inline lines' block_node_tags rows, tags that
// made whole notes tasks) goes on as it was: the task page, the agenda and the synced `tasks` rows are the same before and
// after. The seeded rows are the OLD shape on whatever schema the test database was built from; the "before" figures are
// read with the old tag-join (below) and the "after" figures through the app's own readers (tasksStore, taskAgenda).
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { persistActor } from "./helpers/persistActor.js";
import { needsPostgresServer } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";
import { migration191Sql } from "./helpers/migration191.js";
import { taskAgenda } from "../modules/tasks/agenda.js";
import {
  TASK_COLUMNS_SQL, TASK_HOST_JOIN_SQL, TASK_HOST_LIVE_WHERE, TASK_JOIN_SQL, taskBucketCaseSql, taskRowsByIds, taskRowsForBootstrap,
  notATaskNodeSql, taskNodeIdsAmong,
} from "../services/tasksStore.js";
import type { ActorCtx } from "../types.js";

const MIGRATION = migration191Sql();

/** TASK_JOIN_SQL as it was before 191: the module tag through node_tags. */
const OLD_TASK_JOIN_SQL = TASK_JOIN_SQL.replace(
  /JOIN function_refs tref[\s\S]*?tref\.instance = ''/,
  `JOIN node_tags nt ON nt.node_id = t.id
    JOIN content_nodes tg ON tg.id = nt.tag_id
     AND (tg.node_type = 'class_tag' AND tg.deleted_at IS NULL AND tg.tag_schema->>'module' = 'tasks')`,
);

describe.skipIf(!isTestDatabase())("migration 191 — tasks into function references (DB)", () => {
  const stamp = Date.now();
  let ws = "";
  let admin: ActorCtx = { id: "", name: "Admin", role: "admin", type: "human" };
  let space = "";
  const id: Record<string, string> = {};
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  async function node(key: string, opts: { type?: string; title?: string; parent?: string; hidden?: boolean; deleted?: boolean; schema?: object; space?: boolean } = {}) {
    id[key] = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, hidden, space_id, tag_schema, deleted_at)
       VALUES ($1, 'manual', $2, $3, $4, '', $5, $6, $7, $8, $9) RETURNING id::text`,
      [ws, opts.type ?? "content", opts.title ?? key, `m191-${randomUUID()}`, opts.parent ? id[opts.parent] : null, opts.hidden ?? false,
        opts.space ? space : null, opts.schema ? JSON.stringify(opts.schema) : null, opts.deleted ? new Date().toISOString() : null])).rows[0]!.id;
  }
  /** A task node of the OLD shape: tagged with `tag`, status plus these attributes. */
  async function oldTask(key: string, opts: { host?: string; tag?: string; deleted?: boolean; attrs: Record<string, string> }) {
    await node(key, { parent: opts.host, hidden: true, deleted: opts.deleted, space: !opts.host });
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id[key], id[opts.tag ?? "moduleTag"]]);
    for (const [k, v] of Object.entries(opts.attrs)) {
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, $3, $4, 'text')`, [ws, id[key], k, v]);
    }
  }
  const taskKeys = ["standalone", "hosted", "trashedTask", "underTrashedHost", "line", "twoTags", "reminder", "repeat", "someday"];
  const allIds = () => Object.values(id);

  // A node tagged with two module tags was listed twice by the old join (one row per tag); the reference is one row, so
  // one listing: the "before" figures are deduplicated by id.
  const oldRows = async () => dedupe((await q<Record<string, unknown>>(
    `SELECT ${TASK_COLUMNS_SQL}, ${taskBucketCaseSql()} AS bucket ${OLD_TASK_JOIN_SQL} ${TASK_HOST_JOIN_SQL}
      WHERE t.workspace_id = $1 AND t.deleted_at IS NULL AND ${TASK_HOST_LIVE_WHERE} ORDER BY t.created_at, t.id`, [ws])).rows);
  const dedupe = (rows: Array<Record<string, unknown>>) => rows.filter((row, at) => rows.findIndex((other) => other.id === row.id) === at);
  const bucketOf = (rows: Array<{ id: string; bucket: string }>) => Object.fromEntries(rows.map((r) => [r.id, r.bucket]));
  const refCount = async (nodeId: string) => (await q(`SELECT 1 FROM function_refs WHERE holder_node_id = $1 AND function_id = 'tasks'`, [nodeId])).rowCount;
  const tagRowCount = async () => (await q(`SELECT 1 FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id WHERE n.workspace_id = $1`, [ws])).rowCount;

  let beforeRows: Record<string, unknown>[] = [];
  let beforeTaskIds: string[] = [];
  let beforeBlockTags = 0;
  let notices: string[] = [];

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('m191', $1) RETURNING id`, [`m191-${stamp}`])).rows[0]!.id;
    admin = await persistActor(ws, admin);
    space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [admin.id])).rows[0]!.id;
    const schema = { name: "task", slug: "module-task", fields: [], module: "tasks" };
    await node("moduleTag", { type: "class_tag", title: "task", schema });
    // A second tag with the module mark: the old predicate accepted any of them, so a node tagged with both is one task.
    await node("moduleTag2", { type: "class_tag", title: "task (tasks)", schema: { ...schema, slug: "module-task-2" } });
    // Every module tag holds its own function (migration 166), so the tasks module's tag has a 'tasks' reference too: it is
    // a tag, never a task, and must stay in node lists and sync.
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'tasks', $2), ($1, 'tasks', $3)`, [ws, id.moduleTag, id.moduleTag2]);
    await node("hostNote", { title: "Host note" });
    await node("trashedHost", { title: "Trashed host", deleted: true });
    await oldTask("standalone", { attrs: { _task_status: "todo", _task_when: day(0) } });
    await oldTask("hosted", { host: "hostNote", attrs: { _task_status: "doing", _task_when: day(-2) } });
    await oldTask("trashedTask", { host: "hostNote", deleted: true, attrs: { _task_status: "todo" } });
    await oldTask("underTrashedHost", { host: "trashedHost", attrs: { _task_status: "todo", _task_when: day(1) } });
    await oldTask("line", { host: "hostNote", attrs: { _task_status: "waiting" } });
    await oldTask("twoTags", { host: "hostNote", attrs: { _task_status: "done" } });
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id.twoTags, id.moduleTag2]);
    await oldTask("reminder", { host: "hostNote", attrs: { _task_status: "todo", _task_when: day(3), _task_remind_at: `${day(3)}T09:00` } });
    await oldTask("repeat", { attrs: { _task_status: "todo", _task_when: day(-1), _task_recur: "1w", _task_recur_mode: "after" } });
    await oldTask("someday", { attrs: { _task_status: "todo", _task_someday: "true" } });
    // An inline task's line: the block carries the tag (block_node_tags) and links to its task node (block_nodes.task_id).
    await seedQ(`UPDATE content_nodes SET markdown = '- [ ] a line {task}' WHERE id = $1`, [id.hostNote]);
    const block = (await seedQ<{ id: string }>(
      `INSERT INTO block_nodes (workspace_id, note_id, block_ref, anchor_id, kind, label, text_cache, task_id)
       VALUES ($1, $2, 'ln1', 'ln1', 'listItem', 'a line', 'a line', $3) RETURNING id::text`, [ws, id.hostNote, id.line])).rows[0]!.id;
    await seedQ(`INSERT INTO block_node_tags (workspace_id, block_node_id, tag_id) VALUES ($1, $2, $3)`, [ws, block, id.moduleTag]);
    // Not tasks: a note with the tag but no status (left as it is), and an ordinary tagged note.
    await node("taggedNoStatus", { title: "Tagged, no status" });
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id.taggedNoStatus, id.moduleTag]);
    await node("plainTag", { type: "class_tag", title: "plain" });
    await node("plainNote", { title: "Plain" });
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id.plainNote, id.plainTag]);
    // A tag that made its whole notes tasks (tasks_checkable / tasks_dates): the reference goes, the notes keep their values.
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'tasks_checkable', $2), ($1, 'tasks_dates', $2)`, [ws, id.plainTag]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, '_task_status', 'done', 'text')`, [ws, id.plainNote]);

    beforeRows = await oldRows();
    beforeTaskIds = beforeRows.map((r) => String(r.id));
    beforeBlockTags = (await q(`SELECT 1 FROM block_node_tags WHERE tag_id = $1`, [id.moduleTag])).rowCount ?? 0;
    // The migration's NOTICE lines (the move counts and the removed tags) are part of its contract. A `pg` client
    // reports them; PGlite has no such event, so there the migration just runs and the notice test is skipped.
    const client = await pool.connect();
    const listens = typeof client.on === "function";
    if (listens) client.on("notice", (message: { message?: string }) => { if (message.message) notices.push(message.message); });
    try { await client.query(MIGRATION); } finally { client.release(); }
  });

  it("old shape: the seed has the task nodes the old join finds, and not the trashed ones or the one under a trashed note", () => {
    expect(beforeTaskIds.sort()).toEqual(["standalone", "hosted", "line", "twoTags", "reminder", "repeat", "someday"].map((k) => id[k]!).sort());
  });

  it("gives every task node one tasks reference, trashed ones too, and no node more than one", async () => {
    for (const key of taskKeys) expect(await refCount(id[key]!), key).toBe(1);
    for (const key of ["taggedNoStatus", "plainNote", "hostNote"]) expect(await refCount(id[key]!), key).toBe(0);
    for (const key of ["moduleTag", "moduleTag2"]) expect(await refCount(id[key]!), `${key} keeps only its own`).toBe(1);
  });

  it("the synced `tasks` rows are the same before and after (every column, host liveness included)", async () => {
    const after = await taskRowsByIds(ws, allIds());
    const normalise = (rows: Array<Record<string, unknown>>) => rows.map(({ bucket: _bucket, ...row }) => row).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    expect(normalise(after as unknown as Array<Record<string, unknown>>)).toEqual(normalise(beforeRows));
    expect(normalise(await taskRowsForBootstrap(ws, allIds()) as unknown as Array<Record<string, unknown>>)).toEqual(normalise(beforeRows));
  });

  it("the agenda and its completed tail list the same tasks in the same buckets", async () => {
    const agenda = await taskAgenda(admin, ws);
    const open = Object.values(agenda.buckets).flat();
    const expectedOpen = bucketOf(beforeRows.filter((r) => r.status !== "done").map((r) => ({ id: String(r.id), bucket: String(r.bucket) })));
    expect(bucketOf(open)).toEqual(expectedOpen);
    expect(agenda.done.map((r) => r.id).sort()).toEqual(beforeRows.filter((r) => r.status === "done").map((r) => String(r.id)).sort());
    expect(agenda.done_total).toBe(beforeRows.filter((r) => r.status === "done").length);
  });

  it("the sync classification and the note listings agree: task nodes are found (trashed ones too), notes are not", async () => {
    const found = await taskNodeIdsAmong(ws, allIds());
    expect([...found].sort()).toEqual(taskKeys.map((k) => id[k]!).sort()); // the module tags, which hold the function too, are not tasks
    const notTasks = (await q<{ id: string }>(`SELECT n.id::text FROM content_nodes n WHERE n.workspace_id = $1 AND ${notATaskNodeSql("n")}`, [ws])).rows.map((r) => r.id);
    for (const key of taskKeys) expect(notTasks, key).not.toContain(id[key]);
    for (const key of ["taggedNoStatus", "plainNote", "hostNote", "moduleTag", "moduleTag2"]) expect(notTasks, key).toContain(id[key]);
  });

  it("removes the tag rows of the moved tasks and leaves the rest: a tagged note with no status stays tagged", async () => {
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = ANY($1::uuid[])`, [taskKeys.map((k) => id[k]!)])).rowCount).toBe(0);
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [id.taggedNoStatus, id.moduleTag])).rowCount).toBe(1);
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [id.plainNote, id.plainTag])).rowCount).toBe(1);
    expect(await tagRowCount()).toBe(2);
  });

  it("removes the inline lines' block tag rows and keeps the line → task link", async () => {
    expect(beforeBlockTags).toBe(1);
    expect((await q(`SELECT 1 FROM block_node_tags WHERE tag_id = $1`, [id.moduleTag])).rowCount).toBe(0);
    expect((await q(`SELECT task_id::text FROM block_nodes WHERE note_id = $1`, [id.hostNote])).rows).toEqual([{ task_id: id.line }]);
  });

  it("removes the tasks_checkable / tasks_dates references of tags and keeps those notes and their values", async () => {
    expect((await q(`SELECT 1 FROM function_refs WHERE function_id IN ('tasks_checkable', 'tasks_dates')`)).rowCount).toBe(0);
    expect((await q(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_task_status'`, [id.plainNote])).rows).toEqual([{ value: "done" }]);
    // The module tag nodes themselves are not touched by this migration.
    expect((await q(`SELECT 1 FROM content_nodes WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [[id.moduleTag, id.moduleTag2]])).rowCount).toBe(2);
  });

  // Needs real Postgres: PGlite does not report NOTICE messages (run on real Postgres; listed in the PR).
  it.skipIf(needsPostgresServer)("prints what it moved and what it removed", () => {
    const joined = notices.join("\n");
    expect(joined).toContain(`[191] tasks module tag name(s) (workspace: name): `);
    expect(joined).toContain(`${ws}: task`);
    expect(joined).toMatch(/ordinary tags named task: \d+/);
    expect(joined).toContain("[191] removed 2 tag function reference(s)");
    expect(joined).toContain(`${id.plainTag} (tasks_checkable)`);
    expect(joined).toMatch(/\[191\] task nodes given a tasks reference: \d+; nodes with the tasks tag but no status left alone: \d+; node_tags rows removed: \d+; block_node_tags rows removed: 1/);
  });

  it("is re-runnable: a second run changes nothing", async () => {
    const snapshot = async () => ({
      refs: (await q(`SELECT holder_node_id::text, function_id FROM function_refs WHERE workspace_id = $1 ORDER BY 1, 2`, [ws])).rows,
      tags: await tagRowCount(),
    });
    const first = await snapshot();
    await seedQ(MIGRATION);
    expect(await snapshot()).toEqual(first);
    expect((await taskRowsByIds(ws, allIds())).length).toBe(beforeRows.length);
  });
});
