// Deleting a task that is a line of a note (docs/architecture/block-nodes.md, 任務行 › 刪除):
// the line leaves the note in the same transaction and the task goes to the trash, so the note's next save cannot put
// it back (it used to: syncBlockTasks restored a task whose line was still there). Undo writes the line back.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import eventsRouter from "../routes/events.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const isTestDb = isTestDatabase();
let workspaceId = "";
let admin: ActorCtx = { id: "task-del-admin", name: "Tasks", role: "admin", type: "human" };
let viewer: ActorCtx = { id: "task-del-viewer", name: "Viewer", role: "editor", type: "human" };
let as: ActorCtx = admin;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", as); await next(); });
app.route("/nodes", nodesRouter);
app.route("/tasks", tasksRouter);
app.route("/events", eventsRouter);
app.post("/nodes/:id/tasks", addTaskUnderNote);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const bodyOf = async (id: string) => (await q<{ markdown: string }>("SELECT markdown FROM content_nodes WHERE id = $1", [id])).rows[0]!.markdown;
type Task = { id: string; title: string; status: string; deleted: boolean; recur: string | null; due: string | null };
/** Every task node under the note, oldest first. */
const tasksOf = async (noteId: string): Promise<Task[]> => (await q<Task>(
  `SELECT t.id::text, t.title, s.value AS status, t.deleted_at IS NOT NULL AS deleted, r.value AS recur, d.value AS due
     FROM content_nodes t
     JOIN node_attributes s ON s.node_id = t.id AND s.key = '_task_status'
     LEFT JOIN node_attributes r ON r.node_id = t.id AND r.key = '_task_recur'
     LEFT JOIN node_attributes d ON d.node_id = t.id AND d.key = '_task_when'
    WHERE t.parent_id = $1 ORDER BY t.created_at, t.id`, [noteId])).rows;
const live = async (noteId: string) => (await tasksOf(noteId)).filter((t) => !t.deleted);
const save = (id: string, markdown: string) => send(`/nodes/${id}`, "PATCH", { markdown });
const makeNote = async (markdown: string): Promise<string> => {
  const res = await send("/nodes", "POST", { title: `筆記 ${randomUUID().slice(0, 6)}`, markdown });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
};
const taskTitled = async (noteId: string, title: string) => (await tasksOf(noteId)).find((t) => t.title === title)!;
const lineLinks = async (noteId: string, taskId: string) =>
  (await q("SELECT 1 FROM block_nodes WHERE note_id = $1 AND task_id = $2 AND hidden_at IS NULL", [noteId, taskId])).rows.length;

describe.skipIf(!isTestDb)("deleting a task that is a line of a note", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Task delete',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    admin = await persistActor(workspaceId, admin);
    viewer = await persistActor(workspaceId, viewer);
  });
  beforeEach(() => { as = admin; });

  it("takes the line out of the note, and the note's next save does not bring the task back", async () => {
    const noteId = await makeNote("前言\n\n- [ ] 寫下習慣 {task}\n- [ ] 另一個 {task}\n");
    const task = await taskTitled(noteId, "寫下習慣");
    const res = await send(`/nodes/${task.id}`, "DELETE");
    expect(res.status).toBe(200);
    expect(await bodyOf(noteId)).toBe("前言\n\n- [ ] 另一個 {task}\n");
    expect((await tasksOf(noteId)).find((t) => t.id === task.id)).toMatchObject({ deleted: true });
    // The report: after the note is edited and saved the task stayed deleted.
    expect((await save(noteId, `${await bodyOf(noteId)}\n新增一行\n`)).status).toBe(200);
    expect(await bodyOf(noteId)).toBe("前言\n\n- [ ] 另一個 {task}\n\n新增一行\n");
    expect((await tasksOf(noteId)).find((t) => t.id === task.id)).toMatchObject({ deleted: true });
    expect((await live(noteId)).map((t) => t.title)).toEqual(["另一個"]);
  });

  it("a note open in an editor with unsaved typing: the typing is saved against the old body and merges with the removed line, losing neither", async () => {
    const original = "# 筆記\n\n- [ ] 要刪 {task}\n- [ ] 留下 {task}\n\n結尾段落\n";
    const noteId = await makeNote(original);
    const task = await taskTitled(noteId, "要刪");
    expect((await send(`/nodes/${task.id}`, "DELETE")).status).toBe(200);
    // The editor still holds `original`; its save names it as the base (what the note writer sends).
    const typed = original.replace("結尾段落", "結尾段落，這是還沒存的打字");
    const res = await send(`/nodes/${noteId}`, "PATCH", { markdown: typed, base_markdown: original });
    expect(res.status).toBe(200);
    expect(await bodyOf(noteId)).toBe("# 筆記\n\n- [ ] 留下 {task}\n\n結尾段落，這是還沒存的打字\n");
    expect((await live(noteId)).map((t) => t.title)).toEqual(["留下"]);
  });

  it("is one history step: the task's delete and the note's edit are both recorded, and the rest of the note is untouched", async () => {
    const noteId = await makeNote("- [ ] 要刪 {task}\n- [ ] 留下 {task}\n");
    const task = await taskTitled(noteId, "要刪");
    await send(`/nodes/${task.id}`, "DELETE");
    const events = (await q<{ event_type: string; target_id: string }>(
      `SELECT event_type, target_id::text FROM domain_events WHERE workspace_id = $1 AND tx_meta->>'ui_context' = 'task.delete' ORDER BY id`, [workspaceId])).rows;
    expect(events.map((e) => [e.event_type, e.target_id]))
      .toEqual(expect.arrayContaining([["NODE_DELETED", task.id], ["NODE_UPDATED", noteId]]));
    expect((await live(noteId)).map((t) => t.title)).toEqual(["留下"]);
  });

  it("leaves items nested under the task line in the note (the rule of taking a task out)", async () => {
    const noteId = await makeNote("- [ ] 父任務 {task}\n  - 細項一\n  - 細項二\n- 其他\n");
    const task = await taskTitled(noteId, "父任務");
    expect((await send(`/nodes/${task.id}`, "DELETE")).status).toBe(200);
    expect(await bodyOf(noteId)).toBe("  - 細項一\n  - 細項二\n- 其他\n");
    expect((await save(noteId, `${await bodyOf(noteId)}\n尾巴\n`)).status).toBe(200);
    expect(await live(noteId)).toHaveLength(0);
  });

  it("a repeating task: the line and the task go, nothing is made in its place, and the earlier occurrence stays done", async () => {
    const noteId = await makeNote("- [ ] 每週整理 {task}\n");
    const first = await taskTitled(noteId, "每週整理");
    expect((await send(`/tasks/${first.id}`, "PATCH", { when_date: "2026-11-02", recur: "1w" })).status).toBe(200);
    expect((await send(`/tasks/${first.id}`, "PATCH", { status: "done" })).status).toBe(200);
    // The line moved on to the next occurrence, its box empty.
    const [, second] = await tasksOf(noteId);
    expect(second).toMatchObject({ deleted: false, status: "todo", recur: "1w" });
    expect(await bodyOf(noteId)).toBe("- [ ] 每週整理 {task}\n");
    expect((await send(`/nodes/${second!.id}`, "DELETE")).status).toBe(200);
    expect(await bodyOf(noteId)).toBe("");
    expect((await save(noteId, "之後寫的\n")).status).toBe(200);
    const all = await tasksOf(noteId);
    expect(all).toHaveLength(2);
    expect(all.filter((t) => !t.deleted)).toMatchObject([{ id: first.id, status: "done" }]);
  });

  it("a standalone task is deleted as before, and so is a task added under a note without a line", async () => {
    const standalone = await send("/tasks", "POST", { id: randomUUID(), title: "獨立任務" });
    expect(standalone.status).toBe(201);
    const standaloneId = ((await standalone.json()) as { id: string }).id;
    expect((await send(`/nodes/${standaloneId}`, "DELETE")).status).toBe(200);
    expect((await q("SELECT deleted_at FROM content_nodes WHERE id = $1", [standaloneId])).rows[0]).toMatchObject({ deleted_at: expect.anything() });

    const noteId = await makeNote("內文\n");
    const added = await send(`/nodes/${noteId}/tasks`, "POST", { id: randomUUID(), title: "沒有行的任務" });
    expect(added.status).toBe(201);
    const addedId = ((await added.json()) as { id: string }).id;
    expect((await send(`/nodes/${addedId}`, "DELETE")).status).toBe(200);
    expect(await bodyOf(noteId)).toBe("內文\n");
    expect((await tasksOf(noteId)).find((t) => t.id === addedId)).toMatchObject({ deleted: true });
  });

  it("a line whose {task} was taken out by hand: the line stays as written, deleting the (already trashed) task changes nothing", async () => {
    const noteId = await makeNote("- [ ] 手動拿掉 {task}\n");
    const task = await taskTitled(noteId, "手動拿掉");
    expect((await save(noteId, "- [ ] 手動拿掉\n")).status).toBe(200);
    expect((await tasksOf(noteId))[0]).toMatchObject({ deleted: true });
    expect((await send(`/nodes/${task.id}`, "DELETE")).status).toBe(404);
    expect(await bodyOf(noteId)).toBe("- [ ] 手動拿掉\n");
  });

  it("is refused for someone who may not write the note, and nothing changes", async () => {
    const space = await makeSpace(workspaceId, `del-${randomUUID()}`, [{ id: admin.id, role: "manager" }, { id: viewer.id, role: "viewer" }]);
    const noteId = await makeNote("- [ ] 只能看 {task}\n");
    await putInSpace(noteId, space);
    const task = await taskTitled(noteId, "只能看");
    as = viewer;
    const res = await send(`/nodes/${task.id}`, "DELETE");
    expect([403, 404]).toContain(res.status);
    expect(await bodyOf(noteId)).toBe("- [ ] 只能看 {task}\n");
    expect((await live(noteId)).map((t) => t.title)).toEqual(["只能看"]);
  });

  it("a line that cannot be found in the note's text is refused whole: nothing changes, and a later save does not bring a task back", async () => {
    const noteId = await makeNote("- [ ] 找不到 {task}\n- [ ] 旁邊 {task}\n");
    const task = await taskTitled(noteId, "找不到");
    // The line's anchor no longer stands anywhere (what a note too long to parse leaves).
    await seedQ("UPDATE block_anchors SET status = 'lost' WHERE note_id = $1 AND anchor_id = (SELECT block_ref FROM block_nodes WHERE task_id = $2)", [noteId, task.id]);
    const res = await send(`/nodes/${task.id}`, "DELETE");
    expect(res.status).toBe(409);
    expect(await bodyOf(noteId)).toBe("- [ ] 找不到 {task}\n- [ ] 旁邊 {task}\n");
    expect((await live(noteId)).map((t) => t.title).sort()).toEqual(["找不到", "旁邊"]);
    expect((await save(noteId, `${await bodyOf(noteId)}\n尾\n`)).status).toBe(200);
    expect((await live(noteId)).map((t) => t.title).sort()).toEqual(["找不到", "旁邊"]);
  });

  it("someone who can delete the task but cannot see its note is refused whole, not left with a line that brings it back", async () => {
    const noteId = await makeNote("- [ ] 看不到 {task}\n");
    const task = await taskTitled(noteId, "看不到");
    // The note moves into a space the actor is not in; the task node stays readable and deletable to them.
    const hidden = await adminOnlySpace(workspaceId, `hid-${randomUUID()}`, [admin.id]);
    await putInSpace(noteId, hidden);
    as = viewer;
    const res = await send(`/nodes/${task.id}`, "DELETE");
    expect([403, 404]).toContain(res.status);
    as = admin;
    expect(await bodyOf(noteId)).toBe("- [ ] 看不到 {task}\n");
    expect((await live(noteId)).map((t) => t.title)).toEqual(["看不到"]);
    expect((await save(noteId, `${await bodyOf(noteId)}\n尾\n`)).status).toBe(200);
    expect((await live(noteId)).map((t) => t.title)).toEqual(["看不到"]);
  });

  describe("undo (POST /api/nodes/:id/undelete)", () => {
    const undo = (id: string) => send(`/nodes/${id}/undelete`, "POST");

    it("writes the line back where it was and the same task is its line again, with its fields", async () => {
      const noteId = await makeNote("# 計畫\n\n- [ ] 第一件 {task}\n- [ ] 15:00–16:00 開會 {task}\n- [ ] 第三件 {task}\n");
      const task = await taskTitled(noteId, "開會");
      expect((await send(`/tasks/${task.id}`, "PATCH", { when_date: "2026-11-20", deadline: "2026-11-25", recur: "1w", remind_at: "2026-11-20T06:00:00Z" })).status).toBe(200);
      const before = await bodyOf(noteId);
      expect((await send(`/nodes/${task.id}`, "DELETE")).status).toBe(200);
      expect(await bodyOf(noteId)).toBe("# 計畫\n\n- [ ] 第一件 {task}\n- [ ] 第三件 {task}\n");
      expect((await undo(task.id)).status).toBe(200);
      expect(await bodyOf(noteId)).toBe(before);
      const back = await q<{ id: string; deleted: boolean }>(`SELECT id::text, deleted_at IS NOT NULL AS deleted FROM content_nodes WHERE id = $1`, [task.id]);
      expect(back.rows[0]).toMatchObject({ deleted: false });
      expect(await lineLinks(noteId, task.id)).toBe(1);
      const row = (await send(`/tasks/${task.id}`, "PATCH", { status: "todo" }));
      expect(await row.json()).toMatchObject({ id: task.id, title: "開會", time: "15:00", until: "16:00", when_date: "2026-11-20", deadline: "2026-11-25", recur: "1w", remind_at: "2026-11-20T06:00:00Z" });
      // Still the one task: ticking its line in the note completes it (and, as it repeats, makes the next one).
      expect((await save(noteId, before.replace("- [ ] 15:00–16:00 開會", "- [x] 15:00–16:00 開會"))).status).toBe(200);
      expect((await tasksOf(noteId)).find((t) => t.id === task.id)).toMatchObject({ status: "done", deleted: false });
    });

    it("puts a first line back at the top and a last line at the bottom", async () => {
      const noteId = await makeNote("- [ ] 頭 {task}\n- [ ] 中 {task}\n- [ ] 尾 {task}\n");
      const before = await bodyOf(noteId);
      for (const title of ["頭", "尾"]) {
        const task = await taskTitled(noteId, title);
        expect((await send(`/nodes/${task.id}`, "DELETE")).status).toBe(200);
        expect(await bodyOf(noteId)).not.toContain(`${title} {task}`);
        expect((await undo(task.id)).status).toBe(200);
        expect(await bodyOf(noteId)).toBe(before);
      }
    });

    const roundTrip = async (original: string, title: string, without: string) => {
      const noteId = await makeNote(original);
      const task = await taskTitled(noteId, title);
      expect((await send(`/nodes/${task.id}`, "DELETE")).status).toBe(200);
      expect(await bodyOf(noteId)).toBe(without);
      expect((await undo(task.id)).status).toBe(200);
      expect(await bodyOf(noteId)).toBe(original);
      expect(await lineLinks(noteId, task.id)).toBe(1);
    };

    it("a subtask comes back as a subtask, first or after its sibling", async () => {
      await roundTrip("- 父項目\n  - [ ] 子任務 {task}\n- 其他\n", "子任務", "- 父項目\n- 其他\n");
      await roundTrip("- 父項目\n  - 先寫的\n  - [ ] 子任務 {task}\n- 其他\n", "子任務", "- 父項目\n  - 先寫的\n- 其他\n");
    });

    it("after an item that has sub-items it comes back at the same level, not inside them", async () => {
      await roundTrip("- A\n  - sub\n- [ ] 任務 {task}\n", "任務", "- A\n  - sub\n");
      await roundTrip("- A\n  - sub\n    - deeper\n- [ ] 任務 {task}\n- Z\n", "任務", "- A\n  - sub\n    - deeper\n- Z\n");
    });

    it("the first item under a heading comes back right under that heading, not at the end of its section", async () => {
      const original = "# 今天\n- [ ] A {task}\n- [ ] B {task}\n\n一段文字\n\n# 明天\n";
      await roundTrip(original, "A", "# 今天\n- [ ] B {task}\n\n一段文字\n\n# 明天\n");
      await roundTrip("# 今天\n\n- [ ] A {task}\n- [ ] B {task}\n\n一段文字\n", "A", "# 今天\n\n- [ ] B {task}\n\n一段文字\n");
    });

    it("tasks nested under tasks: each comes back as its line, in place", async () => {
      await roundTrip("- [ ] 父 {task}\n  - [ ] 子 {task}\n- [ ] 弟 {task}\n", "父", "  - [ ] 子 {task}\n- [ ] 弟 {task}\n");
    });

    it("a task at the very start with a blank line after it: the removal leaves no blank line at the top, undo puts it back", async () => {
      await roundTrip("- [ ] T {task}\n\n# H\n", "T", "# H\n");
      await roundTrip("- [ ] T {task}\n\n- B\n", "T", "- B\n");
    });

    it("items nested under the line stay in the note when it goes, and come back under it on undo", async () => {
      await roundTrip("- [ ] A {task}\n- [ ] T {task}\n  - c\n\n段落\n", "T", "- [ ] A {task}\n  - c\n\n段落\n");
      await roundTrip("- [ ] T {task}\n  - c\n- B\n", "T", "  - c\n- B\n");
    });

    it("children indented with 4 spaces or a tab stay as written (no text is lost) and come back under their task", async () => {
      // Left at the top of the note (or after a blank line) such a child reads as a code block: the removal keeps the text
      // as the user wrote it (docs/architecture/tasks-module.md), and undo restores the original exactly.
      await roundTrip("- [ ] T {task}\n    - c4\n- B\n", "T", "    - c4\n- B\n");
      await roundTrip("- [ ] T {task}\n\t- ct\n- B\n", "T", "\t- ct\n- B\n");
      await roundTrip("段落\n\n- [ ] T {task}\n    - c4\n- B\n", "T", "段落\n\n    - c4\n- B\n");
    });

    it("a parent item with a continuation line: the task comes back after the continuation, still the parent's child", async () => {
      await roundTrip("- 父項\n  續行文字\n  - [ ] T {task}\n- Z\n", "T", "- 父項\n  續行文字\n- Z\n");
      await roundTrip("- 父項\n  續行文字\n  - 先\n  - [ ] T {task}\n", "T", "- 父項\n  續行文字\n  - 先\n");
    });

    it("a task indented one to three spaces after a multi-line paragraph or a code fence is not written into them", async () => {
      await roundTrip("第一行\n第二行\n\n - [ ] T {task}\n", "T", "第一行\n第二行\n");
      await roundTrip("第一行\n第二行\n - [ ] T {task}\n", "T", "第一行\n第二行\n");
      // A code fence is not a block the line can follow: the line goes to the end of the note, never inside the fence.
      const fenced = await makeNote("```\ncode\nmore\n```\n\n - [ ] T {task}\n - [ ] U {task}\n");
      const fencedTask = await taskTitled(fenced, "T");
      expect((await send(`/nodes/${fencedTask.id}`, "DELETE")).status).toBe(200);
      expect((await undo(fencedTask.id)).status).toBe(200);
      expect(await bodyOf(fenced)).toMatch(/^```\ncode\nmore\n```\n/);
      expect(await bodyOf(fenced)).toContain("- [ ] T {task}");
      expect((await bodyOf(fenced)).indexOf("- [ ] T {task}")).toBeGreaterThan((await bodyOf(fenced)).lastIndexOf("```"));
      expect(await lineLinks(fenced, fencedTask.id)).toBe(1);
    });

    it("after a paragraph and before the next item the list stays tight", async () => {
      await roundTrip("段落\n\n- [ ] T {task}\n- B\n", "T", "段落\n\n- B\n");
    });

    it("when the block it followed was deleted meanwhile, the line goes to the end of the note; typing done meanwhile is kept", async () => {
      const noteId = await makeNote("甲段\n\n- [ ] 任務 {task}\n\n乙段\n");
      const task = await taskTitled(noteId, "任務");
      expect((await send(`/nodes/${task.id}`, "DELETE")).status).toBe(200);
      expect((await save(noteId, "乙段 加了字\n")).status).toBe(200);
      expect((await undo(task.id)).status).toBe(200);
      expect(await bodyOf(noteId)).toBe("乙段 加了字\n\n- [ ] 任務 {task}\n");
      expect(await lineLinks(noteId, task.id)).toBe(1);
    });

    it("an actor who lost the right to write meanwhile cannot undo: the whole undo is refused (403), the task stays deleted", async () => {
      const space = await makeSpace(workspaceId, `undo-${randomUUID()}`, [{ id: admin.id, role: "manager" }, { id: viewer.id, role: "editor" }]);
      const noteId = await makeNote("- [ ] 權限變了 {task}\n");
      await putInSpace(noteId, space);
      const task = await taskTitled(noteId, "權限變了");
      as = viewer;
      expect((await send(`/nodes/${task.id}`, "DELETE")).status).toBe(200);
      await seedQ("UPDATE space_members SET permission = 'view' WHERE space_id = $1 AND actor_id = $2::uuid", [space, viewer.id]);
      expect([403, 404]).toContain((await undo(task.id)).status);
      as = admin;
      expect(await bodyOf(noteId)).toBe("");
      expect((await tasksOf(noteId)).find((t) => t.id === task.id)).toMatchObject({ deleted: true });
    });

    it("a task restored without the line (History restores only the node) is not trashed again by the note's next save", async () => {
      const noteId = await makeNote("- [ ] 歷史 {task}\n- [ ] 保留 {task}\n");
      const task = await taskTitled(noteId, "歷史");
      await send(`/nodes/${task.id}`, "DELETE");
      const delEvent = (await q<{ id: string }>(`SELECT id::text AS id FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_DELETED' ORDER BY domain_events.id DESC LIMIT 1`, [task.id])).rows[0]!.id;
      const restored = await send(`/events/${delEvent}/restore`, "POST");
      expect(restored.status).toBe(200);
      expect((await live(noteId)).map((t) => t.title).sort()).toEqual(["保留", "歷史"]);
      // Without its line the task is an ordinary task of the note: a later save of the note leaves it alone.
      expect(await bodyOf(noteId)).toBe("- [ ] 保留 {task}\n");
      expect((await save(noteId, `${await bodyOf(noteId)}\n尾\n`)).status).toBe(200);
      expect((await live(noteId)).map((t) => t.title).sort()).toEqual(["保留", "歷史"]);
    });
  });
});
