// Task lines (B4, docs/architecture/block-nodes.md): `- [ ] text {task}` in a
// note is a task, both ways —
//   * saving the line makes its task (#task made first when missing);
//   * ticking / unticking the box completes / reopens it; its text is the title;
//   * completing it in Tasks ticks the box; its title is the line's (409 there);
//   * removing {task} trashes the task, putting it back restores it (due kept).
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
let actor: ActorCtx = { id: "block-tasks-admin", name: "Tasks", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
app.route("/tasks", tasksRouter);
app.post("/nodes/:id/tasks", addTaskUnderNote);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const bodyOf = async (id: string) => (await q<{ markdown: string }>("SELECT markdown FROM content_nodes WHERE id = $1", [id])).rows[0]!.markdown;
type Task = { id: string; title: string; status: string; due: string | null; deleted: boolean; parent_id: string };
const tasksOf = async (noteId: string): Promise<Task[]> => (await q<Task>(
  `SELECT t.id::text, t.title, s.value AS status, d.value AS due, t.deleted_at IS NOT NULL AS deleted, t.parent_id::text
     FROM content_nodes t
     JOIN node_attributes s ON s.node_id = t.id AND s.key = '_task_status'
     LEFT JOIN node_attributes d ON d.node_id = t.id AND d.key = '_task_when'
    WHERE t.parent_id = $1 ORDER BY t.created_at`, [noteId])).rows;
const save = (id: string, markdown: string) => send(`/nodes/${id}`, "PATCH", { markdown });

describe.skipIf(!isTestDb)("task lines (B4)", () => {
  let noteId = "";
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Block tasks',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });
  // A fresh note per test: none starts from the line another test ticked,
  // renamed or untasked.
  beforeEach(async () => {
    const res = await send("/nodes", "POST", { title: `習慣 ${randomUUID().slice(0, 6)}`, markdown: "- [ ] 寫下三個想培養的習慣 {task}\n- [ ] 只是勾選框\n" });
    expect(res.status).toBe(201);
    noteId = ((await res.json()) as { id: string }).id;
  });

  it("a `- [ ] … {task}` line makes its task (referencing the tasks function, and no tag); a plain box does not", async () => {
    const tasks = await tasksOf(noteId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "寫下三個想培養的習慣", status: "todo", deleted: false, parent_id: noteId });
    expect((await q("SELECT 1 FROM function_refs WHERE holder_node_id=$1 AND function_id='tasks'", [tasks[0]!.id])).rows).toHaveLength(1);
    expect((await q("SELECT 1 FROM node_tags WHERE node_id=$1", [tasks[0]!.id])).rows).toHaveLength(0);
    // `{task}` is a reserved word, never a tag: the save made no `task` tag and the block holds none.
    expect((await q("SELECT 1 FROM content_nodes WHERE workspace_id=$1 AND node_type='class_tag' AND lower(title)='task'", [workspaceId])).rows).toHaveLength(0);
    expect((await q("SELECT 1 FROM block_node_tags bt JOIN block_nodes b ON b.id=bt.block_node_id WHERE b.note_id=$1", [noteId])).rows).toHaveLength(0);
    expect((await q("SELECT 1 FROM block_nodes WHERE note_id=$1 AND task_id=$2", [noteId, tasks[0]!.id])).rows).toHaveLength(1);
  });

  it("ticking the box completes it; editing the text renames it; unticking reopens it", async () => {
    const body = await bodyOf(noteId);
    expect((await save(noteId, body.replace("- [ ] 寫下三個想培養的習慣", "- [x] 寫下三個想培養的習慣"))).status).toBe(200);
    expect((await tasksOf(noteId))[0]).toMatchObject({ status: "done" });
    const ticked = await bodyOf(noteId);
    expect((await save(noteId, ticked.replace("- [x] 寫下三個想培養的習慣", "- [ ] 寫下五個習慣"))).status).toBe(200);
    expect((await tasksOf(noteId))[0]).toMatchObject({ title: "寫下五個習慣", status: "todo" });
  });

  it("completing it in Tasks ticks the line; its title is refused there (409)", async () => {
    const [task] = await tasksOf(noteId);
    expect((await send(`/tasks/${task!.id}`, "PATCH", { status: "done" })).status).toBe(200);
    expect(await bodyOf(noteId)).toMatch(/^- \[x\] 寫下三個想培養的習慣 \{task\}/);
    expect((await send(`/tasks/${task!.id}`, "PATCH", { status: "todo" })).status).toBe(200);
    expect(await bodyOf(noteId)).toMatch(/^- \[ \] 寫下三個想培養的習慣 \{task\}/);
    const renamed = await send(`/tasks/${task!.id}`, "PATCH", { title: "別的" });
    expect(renamed.status).toBe(409);
    expect(await renamed.json()).toEqual({ error: "task_is_a_line" });
    // Its due date is the task's own (the line doesn't carry one).
    expect((await send(`/tasks/${task!.id}`, "PATCH", { due_date: "2026-10-20" })).status).toBe(200);
  });

  it("removing {task} trashes the task; putting it back restores it with its due date", async () => {
    const [task] = await tasksOf(noteId);
    expect((await send(`/tasks/${task!.id}`, "PATCH", { due_date: "2026-10-20" })).status).toBe(200);
    const body = await bodyOf(noteId);
    expect((await save(noteId, body.replace(" {task}", ""))).status).toBe(200);
    expect((await tasksOf(noteId))[0]).toMatchObject({ deleted: true });
    expect((await save(noteId, body)).status).toBe(200);
    expect((await tasksOf(noteId))[0]).toMatchObject({ deleted: false, due: "2026-10-20", title: "寫下三個想培養的習慣" });
    expect(await tasksOf(noteId)).toHaveLength(1);
  });

  // A `{task}` paragraph with no box (tagged before the box came with the tag, AI/MCP writes, imports) heals on its first tick or time.
  describe("a {task} line with no box", () => {
    // The task of a `{task}` line is only ever made from a boxed line, so the state is made as it was left by older
    // versions: the task exists, linked, and the note's line lost (or never had) its box.
    const boxless = async () => {
      const res = await send("/nodes", "POST", { title: `無框 ${randomUUID().slice(0, 6)}`, markdown: "- [ ] 給你可以 {task}\n" });
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { id: string }).id;
      const [task] = await tasksOf(id);
      expect(task).toBeDefined();
      // Saving it without the box trashes the task (it is no longer a task line); bring the task back, still linked.
      expect((await save(id, "給你可以 {task}\n")).status).toBe(200);
      await seedQ("UPDATE content_nodes SET deleted_at = NULL WHERE id = $1", [task!.id]);
      return { id, task: task! };
    };
    const linked = async (id: string, taskId: string) =>
      (await q("SELECT 1 FROM block_nodes WHERE note_id=$1 AND task_id=$2 AND hidden_at IS NULL", [id, taskId])).rows.length;

    it("ticking it in Tasks adds the box, ticked, and the task stays the same one", async () => {
      const { id, task } = await boxless();
      expect((await send(`/tasks/${task.id}`, "PATCH", { status: "done" })).status).toBe(200);
      expect(await bodyOf(id)).toBe("- [x] 給你可以 {task}\n");
      expect(await tasksOf(id)).toMatchObject([{ id: task.id, status: "done", deleted: false }]);
      expect(await linked(id, task.id)).toBe(1);
      // Ticking the new box in the note reopens that same task.
      expect((await save(id, "- [ ] 給你可以 {task}\n")).status).toBe(200);
      expect(await tasksOf(id)).toMatchObject([{ id: task.id, status: "todo" }]);
    });

    it("giving it a time adds the box and writes the time", async () => {
      const { id, task } = await boxless();
      expect((await send(`/tasks/${task.id}`, "PATCH", { time: "15:00" })).status).toBe(200);
      expect(await bodyOf(id)).toBe("- [ ] 15:00 給你可以 {task}\n");
      expect(await linked(id, task.id)).toBe(1);
    });

    it("cancelling alone leaves the line as it is", async () => {
      const { id, task } = await boxless();
      expect((await send(`/tasks/${task.id}`, "PATCH", { status: "cancelled" })).status).toBe(200);
      expect(await bodyOf(id)).toBe("給你可以 {task}\n");
    });
  });
});
