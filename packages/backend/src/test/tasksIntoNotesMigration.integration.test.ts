// Migration 147: standalone tasks move into notes (docs/architecture/day-timeline.md).
//   (a) a task with a day goes into that day's note (the live one when there is
//       one, else one made with the id the app derives for (space, day)); one
//       with no day goes into a note called 任務, in the task's own space;
//   (b) every task keeps its id and every attribute: only parent_id changes,
//       and the live task count is the same before and after;
//   (c) the line `- [ ] … {task} ^t-…` is in the note with its block node
//       linked to the task, so saving the note makes no second task;
//       That is the form of the day this migration ran: `^id` marks in the text. Block identity has since left the
//       text (migration 180), so after step (c) the test plays the conversion that follows (repairBlockMarkers) and
//       checks the tasks stay linked through it, as anchors;
//   (d) trashed tasks and tasks whose title a line could not carry stay
//       standalone, untouched; a second run changes nothing.
// The SQL runs on one workspace (onden.m147_workspace), so other test files'
// tasks in the shared database are left alone.
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { DAY_NOTE_NAMESPACE } from "@onden/markdown";
import { uuidV5 } from "../utils.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import tasksRouter from "../modules/tasks/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";
import { reservedTagFixture } from "./helpers/reservedTag.js";
import { migration191Sql } from "./helpers/migration191.js";
import { repairBlockMarkers } from "../services/blockMarkerRepair.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(resolve(here, "../../db/migrations/147_tasks_into_notes.sql"), "utf8");
const uuid5 = (name: string): string => uuidV5(DAY_NOTE_NAMESPACE, name);

let workspaceId = "";
let actor: ActorCtx = { id: "m147", name: "Migrator", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
app.route("/tasks", tasksRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, method === "GET" ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Run the migration's SQL for this workspace only, on one connection; then migration 191, which follows it on a real
 *  database (the tagged tasks 147 works on become tasks references). */
async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`SELECT set_config('onden.m147_workspace', $1, false)`, [workspaceId]);
    await client.query(MIGRATION);
    await client.query(migration191Sql());
  } finally {
    await client.query(`SELECT set_config('onden.m147_workspace', '', false)`).catch(() => undefined);
    client.release();
  }
}

type TaskState = { id: string; parent_id: string | null; space_id: string | null; deleted: boolean; attrs: Record<string, string> };
/** The task nodes: before 147 and 191 ran they are tagged nodes (`tagged`), after 191 they reference the tasks function. */
async function taskStates(shape: "tagged" | "referenced" = "referenced"): Promise<TaskState[]> {
  const identity = shape === "tagged"
    ? `JOIN node_tags nt ON nt.node_id = t.id
       JOIN content_nodes tg ON tg.id = nt.tag_id AND tg.tag_schema->>'module' = 'tasks'`
    : `JOIN function_refs tref ON tref.holder_node_id = t.id AND tref.function_id = 'tasks' AND tref.instance = ''`;
  const rows = (await q<{ id: string; parent_id: string | null; space_id: string | null; deleted: boolean; attrs: Record<string, string> }>(
    `SELECT t.id::text, t.parent_id::text, t.space_id::text, t.deleted_at IS NOT NULL AS deleted,
            COALESCE((SELECT jsonb_object_agg(a.key, a.value) FROM node_attributes a WHERE a.node_id = t.id AND a.key LIKE '\\_task\\_%'), '{}'::jsonb) AS attrs
       FROM content_nodes t
       ${identity}
      WHERE t.workspace_id = $1 AND t.hidden ORDER BY t.id`, [workspaceId])).rows;
  return rows;
}
const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;

describe.skipIf(!isTestDatabase())("migration 147 — standalone tasks move into notes (DB)", () => {
  let spaceId = "";
  const made: Record<string, string> = {};

  async function standalone(key: string, body: Record<string, unknown>): Promise<string> {
    const res = await send("/tasks", "POST", { id: randomUUID(), ...body });
    expect(res.status, key).toBe(201);
    made[key] = ((await res.json()) as { id: string }).id;
    return made[key]!;
  }

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('M146',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
    spaceId = (await q<{ id: string }>(
      `SELECT s.id::text AS id FROM spaces s WHERE s.owner_actor_id = $1 AND s.kind = 'personal'`, [actor.id])).rows[0]!.id;
    // A day note that exists already, with text of its own.
    const note = await send("/nodes", "POST", { title: "2026-11-05", markdown: "今天的日記\n" });
    expect(note.status).toBe(201);
    made.dayNote = ((await note.json()) as { id: string }).id;

    await standalone("dated1", { title: "交報告", when_date: "2026-11-05", remind_at: "2026-11-05T09:30" });
    await standalone("dated2", { title: "跟組員討論", when_date: "2026-11-05", time: "15:00", until: "16:00", evening: false });
    await standalone("newDay", { title: "買牛奶", when_date: "2026-12-24", deadline: "2026-12-31", recur: "1w" });
    await standalone("undated", { title: "整理桌面" });
    await standalone("someday", { title: "學吉他", someday: true });
    await standalone("finished", { title: "寄信", when_date: "2026-11-05" });
    expect((await send(`/tasks/${made.finished}`, "PATCH", { status: "done" })).status).toBe(200);
    await standalone("braces", { title: "修 {bug}" });
    await standalone("clock", { title: "15:30 開會" });
    await standalone("trashed", { title: "已刪除", when_date: "2026-11-05" });
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [made.trashed]);
    // Migration 147 ran when a task was a node tagged with the tasks module's tag: put the tasks back in that shape.
    const tagId = await reservedTagFixture(workspaceId, "task");
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) SELECT holder_node_id, $2 FROM function_refs WHERE workspace_id = $1 AND function_id = 'tasks' AND instance = ''`, [workspaceId, tagId]);
    await seedQ(`DELETE FROM function_refs WHERE workspace_id = $1 AND function_id = 'tasks' AND instance = ''`, [workspaceId]);
    // The module's tag still holds the module's own function, as every module tag does (the line word is read from it).
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'tasks', $2)`, [workspaceId, tagId]);
  });

  // One test, three steps that build on each other: move, run again, then save a note.
  it("moves every task into its day's note and loses none; repeating changes nothing; a later save finds the links", async () => {
    {
    const before = await taskStates("tagged");
    expect(before).toHaveLength(9);
    expect(before.filter((t) => !t.deleted)).toHaveLength(8);

    await migrate();
    // 遷移 147 跑的當時，所有筆記都還是舊形式（`^id` 在正文、沒有錨點）。
    await seedQ(`UPDATE content_nodes SET anchor_form = 0 WHERE workspace_id = $1 AND node_type = 'content'`, [workspaceId]);
    const after = await taskStates();

    // (b) the same tasks, the same attributes, the same count.
    expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));
    expect(after.filter((t) => !t.deleted)).toHaveLength(8);
    for (const was of before) {
      const now = after.find((t) => t.id === was.id)!;
      expect(now.attrs, was.id).toEqual(was.attrs);
      expect(now.deleted).toBe(was.deleted);
    }

    // (a) where each went.
    const parent = (key: string) => after.find((t) => t.id === made[key])!.parent_id;
    const dayNewId = uuid5(`${spaceId}/2026-12-24`);
    const inboxId = uuid5(`${spaceId}/任務`);
    expect(parent("dated1")).toBe(made.dayNote);
    expect(parent("dated2")).toBe(made.dayNote);
    expect(parent("finished")).toBe(made.dayNote);
    expect(parent("newDay")).toBe(dayNewId);
    expect(parent("undated")).toBe(inboxId);
    expect(parent("someday")).toBe(inboxId);
    // …and what was left alone.
    for (const key of ["braces", "clock", "trashed"]) expect(parent(key), key).toBeNull();

    // The new notes: the day's, with the derived id and the date as title, and 任務, in the task's space.
    const day = (await q<{ title: string; space_id: string; hidden: boolean }>(`SELECT title, space_id::text, hidden FROM content_nodes WHERE id = $1`, [dayNewId])).rows[0]!;
    expect(day).toMatchObject({ title: "2026-12-24", space_id: spaceId, hidden: false });
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [inboxId])).rows[0]!.title).toBe("任務");
    // Only one note for the day: the one that was there.
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND title = '2026-11-05' AND deleted_at IS NULL`, [workspaceId])).rowCount).toBe(1);

    // (c) the lines.
    const ref = (key: string) => `t-${made[key]!.replace(/-/g, "").slice(0, 12)}`;
    const body = await bodyOf(made.dayNote!);
    expect(body, body).toMatch(/^今天的日記\n\n- \[ \] 交報告 \{task\} \^/);
    expect(body).toContain(`- [ ] 15:00–16:00 跟組員討論 {task} ^${ref("dated2")}`);
    expect(body).toContain(`- [x] 寄信 {task} ^${ref("finished")}`);
    expect(await bodyOf(dayNewId)).toBe(`- [ ] 買牛奶 {task} ^${ref("newDay")}\n`);
    expect(await bodyOf(inboxId)).toContain(`- [ ] 整理桌面 {task} ^${ref("undated")}`);
    const link = await q<{ task_id: string; tags: number }>(
      `SELECT b.task_id::text, (SELECT count(*)::int FROM block_node_tags g WHERE g.block_node_id = b.id) AS tags
         FROM block_nodes b WHERE b.note_id = $1 AND b.block_ref = $2`, [made.dayNote, ref("dated1")]);
    // 147 gave the line the tasks tag; 191, which follows it, took that block tag away (`{task}` is a reserved word, not a tag).
    expect(link.rows[0]).toEqual({ task_id: made.dated1, tags: 0 });

    }

    // — repeating: a second run changes nothing.
    {
    const states = await taskStates();
    const bodies = await Promise.all([made.dayNote!, uuid5(`${spaceId}/2026-12-24`), uuid5(`${spaceId}/任務`)].map(bodyOf));
    const blocks = (await q(`SELECT 1 FROM block_nodes WHERE workspace_id = $1`, [workspaceId])).rowCount;
    await migrate();
    expect(await taskStates()).toEqual(states);
    expect(await Promise.all([made.dayNote!, uuid5(`${spaceId}/2026-12-24`), uuid5(`${spaceId}/任務`)].map(bodyOf))).toEqual(bodies);
    expect((await q(`SELECT 1 FROM block_nodes WHERE workspace_id = $1`, [workspaceId])).rowCount).toBe(blocks);

    }

    // — the conversion that follows: the marks leave the text, the same ids become anchors, and every task is still linked.
    {
    const report = await repairBlockMarkers({ workspaceId });
    expect(report.conversion.notesConverted).toBeGreaterThanOrEqual(3);
    const body = await bodyOf(made.dayNote!);
    expect(body).not.toContain("^t-");
    expect(body).toContain("- [ ] 交報告 {task}\n");
    expect(await bodyOf(uuid5(`${spaceId}/2026-12-24`))).toBe("- [ ] 買牛奶 {task}\n");
    const link = await q<{ task_id: string; anchor_id: string | null }>(
      `SELECT task_id::text, anchor_id FROM block_nodes WHERE note_id = $1 AND task_id = $2 AND hidden_at IS NULL`, [made.dayNote, made.dated1]);
    expect(link.rows).toEqual([{ task_id: made.dated1, anchor_id: `t-${made.dated1!.replace(/-/g, "").slice(0, 12)}` }]);
    }

    // — a later save of the note finds the links: no second task, no renamed task.
    {
    const before = await taskStates();
    const body = await bodyOf(made.dayNote!);
    const res = await send(`/nodes/${made.dayNote}`, "PATCH", { markdown: `${body}\n新的一段\n` });
    expect(res.status).toBe(200);
    const after = await taskStates();
    expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));
    for (const was of before) {
      const now = after.find((t) => t.id === was.id)!;
      // done_at is stamped by the line's tick only when the status moves; nothing moved.
      expect(now.attrs, was.id).toEqual(was.attrs);
      expect(now.parent_id).toBe(was.parent_id);
    }
    const titles = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = ANY($1::uuid[]) ORDER BY title`, [[made.dated1, made.dated2, made.finished]])).rows.map((r) => r.title);
    expect(titles).toEqual(["交報告", "寄信", "跟組員討論"].sort());

    // They are on the Tasks page as tasks of the note.
    const agenda = (await (await send("/tasks/agenda", "GET")).json()) as { tasks?: { id: string; node_id: string | null }[] } & Record<string, unknown>;
    const all = JSON.stringify(agenda);
    expect(all).toContain(made.dated1);
    expect(all).toContain(made.dayNote);
    }
  });
});
