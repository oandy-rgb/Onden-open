// The day-timeline data (docs/architecture/day-timeline.md):
//   * a task made with `into` is a line of that note, in the same transaction;
//   * the time written at the start of a task's line is the task's time and end,
//     both ways (text → attributes on save, task → text on PATCH);
//   * `_task_done_at` is stamped as a task becomes done, however it gets there,
//     and cleared when it stops being done;
//   * focus records: begin, end (with the sentence into the day's note and under
//     the task), fix, and a day's list, each person's own.
// SAFETY: only runs against a *_test database; skips otherwise.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { DAY_NOTE_NAMESPACE, dayNoteIdName } from "@onden/markdown";
import { q } from "../db.js";
import { writePref } from "../services/actorPrefs.js";
import { uuidV5 } from "../utils.js";
import { localDayId } from "../localDay.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import tasksRouter from "../modules/tasks/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";

let workspaceId = "";
let actor: ActorCtx = { id: "day-records", name: "Records", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
app.route("/tasks", tasksRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, method === "GET" ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const json = async <T = Record<string, unknown>>(res: Response): Promise<T> => (await res.json()) as T;
const bodyOf = async (id: string) => (await q<{ markdown: string }>("SELECT markdown FROM content_nodes WHERE id = $1", [id])).rows[0]!.markdown;
const attrs = async (id: string) => Object.fromEntries((await q<{ key: string; value: string }>(
  `SELECT key, value FROM node_attributes WHERE node_id = $1 AND key LIKE '\\_task\\_%'`, [id])).rows.map((r) => [r.key, r.value]));
const lineRefOf = (markdown: string, title: string) => new RegExp(`${title}.* \\{task\\} \\^([\\w-]+)`).exec(markdown)![1]!;

describe.skipIf(!isTestDatabase())("day-timeline data (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Day records',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });
  const newNote = async (title: string, markdown = "") => (await json<{ id: string }>(await send("/nodes", "POST", { title, markdown }))).id;

  describe("a task made into a note", () => {
    it("is one line of that note, with its time at the start of the text", async () => {
      const note = await newNote(`日記 ${randomUUID().slice(0, 6)}`, "早安\n");
      const res = await send("/tasks", "POST", { id: randomUUID(), title: "跟組員討論", time: "15:00", until: "16:00", into: { note_id: note } });
      expect(res.status).toBe(201);
      const task = await json<{ id: string; node_id: string; time: string; until: string }>(res);
      expect(task).toMatchObject({ node_id: note, time: "15:00", until: "16:00" });
      expect(await bodyOf(note)).toBe("早安\n\n- [ ] 15:00–16:00 跟組員討論 {task}\n"); // no `^id`: the line's identity is its anchor
      expect((await q<{ a: string | null; r: string }>(`SELECT anchor_id AS a, block_ref AS r FROM block_nodes WHERE note_id = $1 AND task_id IS NOT NULL`, [note])).rows.map((x) => x.a === x.r && x.a !== null)).toEqual([true]);
      // The save that wrote the line linked it: no second task.
      expect((await q(`SELECT 1 FROM content_nodes WHERE parent_id = $1 AND hidden`, [note])).rowCount).toBe(1);
      expect(await attrs(task.id)).toMatchObject({ _task_time: "15:00", _task_until: "16:00" });
    });

    it("is refused whole when the note is not there: no task is left standalone", async () => {
      const id = randomUUID();
      const res = await send("/tasks", "POST", { id, title: "孤兒", into: { note_id: randomUUID() } });
      expect(res.status).toBe(404);
      expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [id])).rowCount).toBe(0);
    });

    it("an end needs a start, and is later than it", async () => {
      expect((await send("/tasks", "POST", { title: "x", until: "16:00" })).status).toBe(400);
      expect((await send("/tasks", "POST", { title: "x", time: "16:00", until: "15:00" })).status).toBe(400);
    });
  });

  describe("the time on a line", () => {
    it("follows the text on save, and the text follows the task", async () => {
      const note = await newNote(`時間 ${randomUUID().slice(0, 6)}`, "- [ ] 10:30-11:15 讀論文 {task}\n- [ ] 只有開始 {task}\n");
      const [paper] = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE parent_id = $1 AND title = '讀論文'`, [note])).rows;
      expect(await attrs(paper!.id)).toMatchObject({ _task_time: "10:30", _task_until: "11:15" });
      expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [paper!.id])).rows[0]!.title).toBe("讀論文");

      // Editing the line moves the attributes; removing the time clears them.
      await send(`/nodes/${note}`, "PATCH", { markdown: (await bodyOf(note)).replace("10:30-11:15", "09:00") });
      expect(await attrs(paper!.id)).toMatchObject({ _task_time: "09:00" });
      expect(await attrs(paper!.id)).not.toHaveProperty("_task_until");
      await send(`/nodes/${note}`, "PATCH", { markdown: (await bodyOf(note)).replace("09:00 ", "") });
      const cleared = await attrs(paper!.id);
      expect(cleared).not.toHaveProperty("_task_time");

      // A time set on the task is written into the line…
      const set = await send(`/tasks/${paper!.id}`, "PATCH", { time: "14:00", until: "15:30" });
      expect(set.status).toBe(200);
      expect(await json(set)).toMatchObject({ time: "14:00", until: "15:30" });
      expect(await bodyOf(note)).toContain("- [ ] 14:00–15:30 讀論文 {task}");
      // …moved…
      await send(`/tasks/${paper!.id}`, "PATCH", { time: "08:00" });
      expect(await bodyOf(note)).toContain("- [ ] 08:00–15:30 讀論文 {task}");
      // …an end the start passed is dropped…
      await send(`/tasks/${paper!.id}`, "PATCH", { time: "16:00" });
      expect(await bodyOf(note)).toContain("- [ ] 16:00 讀論文 {task}");
      // …and cleared with the start.
      await send(`/tasks/${paper!.id}`, "PATCH", { time: null });
      expect(await bodyOf(note)).toContain("- [ ] 讀論文 {task}");
      expect(await attrs(paper!.id)).not.toHaveProperty("_task_time");
      expect((await send(`/tasks/${paper!.id}`, "PATCH", { time: "10:00", until: "09:00" })).status).toBe(400);
      expect((await send(`/tasks/${paper!.id}`, "PATCH", { time: "25:00" })).status).toBe(400);
    });

    it("a time and the tick are written together", async () => {
      const note = await newNote(`同時 ${randomUUID().slice(0, 6)}`, "- [ ] 寫程式 {task}\n");
      const id = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE parent_id = $1`, [note])).rows[0]!.id;
      expect((await send(`/tasks/${id}`, "PATCH", { time: "13:00", status: "done" })).status).toBe(200);
      expect(await bodyOf(note)).toContain("- [x] 13:00 寫程式 {task}");
    });
  });

  describe("when it was done", () => {
    it("is stamped as the task becomes done and cleared when it is reopened, from the task or from its line", async () => {
      const note = await newNote(`完成 ${randomUUID().slice(0, 6)}`, "- [ ] 交作業 {task}\n- [ ] 洗衣服 {task}\n");
      const ids = Object.fromEntries((await q<{ id: string; title: string }>(`SELECT id::text, title FROM content_nodes WHERE parent_id = $1`, [note])).rows.map((r) => [r.title, r.id]));
      const before = Date.now() - 1000;

      await send(`/tasks/${ids["交作業"]}`, "PATCH", { status: "done" });
      const stamp = (await attrs(ids["交作業"]!))._task_done_at!;
      expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before);
      // Done again changes nothing.
      await send(`/tasks/${ids["交作業"]}`, "PATCH", { status: "done" });
      expect((await attrs(ids["交作業"]!))._task_done_at).toBe(stamp);
      await send(`/tasks/${ids["交作業"]}`, "PATCH", { status: "todo" });
      expect(await attrs(ids["交作業"]!)).not.toHaveProperty("_task_done_at");

      await send(`/nodes/${note}`, "PATCH", { markdown: (await bodyOf(note)).replace("- [ ] 洗衣服", "- [x] 洗衣服") });
      expect(Date.parse((await attrs(ids["洗衣服"]!))._task_done_at!)).toBeGreaterThanOrEqual(before);
      await send(`/nodes/${note}`, "PATCH", { markdown: (await bodyOf(note)).replace("- [x] 洗衣服", "- [ ] 洗衣服") });
      expect(await attrs(ids["洗衣服"]!)).not.toHaveProperty("_task_done_at");
    });

    it("a task made already done carries the time", async () => {
      const note = await newNote(`已完成 ${randomUUID().slice(0, 6)}`, "- [x] 早就做完 {task}\n");
      const id = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE parent_id = $1`, [note])).rows[0]!.id;
      expect(await attrs(id)).toMatchObject({ _task_status: "done" });
      expect(Date.parse((await attrs(id))._task_done_at!)).not.toBeNaN();
    });
  });

  describe("focus records", () => {
    const day = localDayId();
    let note = "";
    let taskId = "";
    beforeAll(async () => {
      note = await newNote(day, "今天\n");
      taskId = (await json<{ id: string }>(await send("/tasks", "POST", { title: "寫報告", into: { note_id: await newNote(`專注 ${randomUUID().slice(0, 6)}`) } }))).id;
    });
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
    // Up to n minutes ago, but never before today began: a focus is written into the
    // diary of the day it began, so a start that falls on yesterday (a run in the
    // first hour after midnight) lands in another note than this test's.
    const todayAgo = (n: number) => {
      let m = n;
      while (m > 0 && localDayId(new Date(Date.now() - m * 60_000)) !== day) m -= 1;
      return minutesAgo(m);
    };

    it("begins once at a time, ends with a sentence, and lists the day", async () => {
      const id = randomUUID();
      const startedAt = todayAgo(55);
      const start = await send("/tasks/focus", "POST", { id, task_id: taskId, started_at: startedAt });
      expect(start.status).toBe(201);
      expect(await json(start)).toMatchObject({ id, task_id: taskId, ended_at: null, note: "" });
      // A retry with the same id answers the same record; a second one is refused while one runs.
      expect((await send("/tasks/focus", "POST", { id, task_id: taskId })).status).toBe(201);
      expect((await send("/tasks/focus", "POST", { task_id: taskId })).status).toBe(409);
      expect(await json(await send(`/tasks/focus?day=${day}`, "GET"))).toMatchObject({ running: { id } });

      const end = await send(`/tasks/focus/${id}/end`, "POST", { note: "寫完第二段", to_diary: true, to_task: true });
      expect(end.status).toBe(200);
      const ended = await json<{ ended_at: string; note: string; written: { diary: boolean; task: boolean } }>(end);
      expect(ended).toMatchObject({ note: "寫完第二段", written: { diary: true, task: true } });
      expect(Date.parse(ended.ended_at)).toBeGreaterThanOrEqual(Date.parse(startedAt));
      expect(await bodyOf(note)).toMatch(/\n> \d\d:\d\d–\d\d:\d\d 專注〈寫報告〉：寫完第二段\n$/);
      expect(await bodyOf(taskId)).toMatch(/\d\d:\d\d–\d\d:\d\d 專注〈寫報告〉：寫完第二段\n$/);
      // Ending again is the same record, and writes nothing twice.
      const again = await send(`/tasks/focus/${id}/end`, "POST", { note: "別的", to_diary: true });
      expect(await json(again)).toMatchObject({ note: "寫完第二段", written: { diary: false, task: false } });
      expect((await bodyOf(note)).match(/專注〈寫報告〉/g)).toHaveLength(1);

      const listed = await json<{ sessions: { id: string }[]; running: unknown }>(await send(`/tasks/focus?day=${day}`, "GET"));
      expect(listed.sessions.map((s) => s.id)).toContain(id);
      expect(listed.running).toBeNull();
      // The events carry the times, not the sentence.
      const events = (await q<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM domain_events WHERE target_type = 'focus_session' AND target_id = $1 ORDER BY id`, [id])).rows;
      expect(events.map((e) => e.event_type)).toEqual(["FOCUS_STARTED", "FOCUS_ENDED"]);
      expect(JSON.stringify(events)).not.toContain("寫完第二段");
    });

    it("ends a record left running over a day at the limit, and a new one can then begin", async () => {
      const id = randomUUID();
      const startedAt = minutesAgo(60 * 30);
      expect((await send("/tasks/focus", "POST", { id, started_at: startedAt })).status).toBe(201);
      const end = await send(`/tasks/focus/${id}/end`, "POST", {});
      expect(end.status).toBe(200);
      expect((await json<{ ended_at: string }>(end)).ended_at).toBe(new Date(Date.parse(startedAt) + 24 * 3_600_000).toISOString());
      // An end the client sends is still judged as sent.
      const again = randomUUID();
      await send("/tasks/focus", "POST", { id: again, started_at: minutesAgo(60 * 30) });
      expect((await send(`/tasks/focus/${again}/end`, "POST", { ended_at: minutesAgo(1) })).status).toBe(400);
      expect((await send(`/tasks/focus/${again}/end`, "POST", {})).status).toBe(200);
      const next = randomUUID();
      expect((await send("/tasks/focus", "POST", { id: next, started_at: minutesAgo(5) })).status).toBe(201);
      expect((await send(`/tasks/focus/${next}/end`, "POST", {})).status).toBe(200);
    });

    it("can be fixed when the stop was forgotten, within reason", async () => {
      const id = randomUUID();
      await send("/tasks/focus", "POST", { id, started_at: minutesAgo(200) });
      expect((await send(`/tasks/focus/${id}`, "PATCH", { ended_at: minutesAgo(10) })).status).toBe(400); // still running: end it
      await send(`/tasks/focus/${id}/end`, "POST", { ended_at: minutesAgo(150) });
      const fixed = await send(`/tasks/focus/${id}`, "PATCH", { ended_at: minutesAgo(170), note: "讀書", task_id: taskId });
      expect(fixed.status).toBe(200);
      expect(await json(fixed)).toMatchObject({ note: "讀書", task_id: taskId });
      expect((await send(`/tasks/focus/${id}`, "PATCH", { ended_at: minutesAgo(250) })).status).toBe(400); // before it began
      expect((await send(`/tasks/focus/${id}`, "PATCH", { started_at: minutesAgo(-30) })).status).toBe(400); // in the future
      expect((await send(`/tasks/focus/${id}`, "PATCH", { started_at: minutesAgo(60 * 30) })).status).toBe(400); // over a day
      expect((await send(`/tasks/focus/${randomUUID()}`, "PATCH", { note: "x" })).status).toBe(404);
    });

    it("is its owner's: another member neither sees, ends nor fixes it", async () => {
      const id = randomUUID();
      await send("/tasks/focus", "POST", { id, started_at: minutesAgo(5) });
      const mine = actor;
      actor = await persistActor(workspaceId, { id: "other", name: "Other", role: "editor", type: "human" });
      try {
        expect((await send(`/tasks/focus/${id}/end`, "POST", {})).status).toBe(404);
        expect((await send(`/tasks/focus/${id}`, "PATCH", { note: "x" })).status).toBe(404);
        expect((await send("/tasks/focus", "POST", { id })).status).toBe(409);
        expect((await json<{ running: unknown }>(await send(`/tasks/focus?day=${day}`, "GET"))).running).toBeNull();
        // …and cannot name a task they cannot read.
        const hidden = await send("/tasks/focus", "POST", { task_id: taskId });
        expect([403, 404]).toContain(hidden.status);
      } finally {
        actor = mine;
      }
      await send(`/tasks/focus/${id}/end`, "POST", {});
    });

    it("starts the day's note, with the id the app derives, when the day has none and the 日記 module is on", async () => {
      const id = randomUUID();
      const began = new Date(Date.now() - 3 * 86_400_000);
      await send("/tasks/focus", "POST", { id, started_at: began.toISOString() });
      await send(`/tasks/focus/${id}/end`, "POST", { ended_at: new Date(began.getTime() + 25 * 60_000).toISOString(), note: "整理筆記", to_diary: true });
      const date = localDayId(began);
      const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [actor.id])).rows[0]!.id;
      const noteId = uuidV5(DAY_NOTE_NAMESPACE, dayNoteIdName(space, date));
      expect(await bodyOf(noteId)).toMatch(/^> \d\d:\d\d–\d\d:\d\d 專注：整理筆記\n$/);
      expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [noteId])).rows[0]!.title).toBe(date);
    });

    // 2026-10-31: 日記 settings say where new day notes go; the focus record's
    // 「寫進日記」 started the day at the top level regardless.
    describe("the day note it starts follows the 日記 setting", () => {
      const endOn = async (daysAgo: number, note: string) => {
        const id = randomUUID();
        const began = new Date(Date.now() - daysAgo * 86_400_000);
        await send("/tasks/focus", "POST", { id, started_at: began.toISOString() });
        await send(`/tasks/focus/${id}/end`, "POST", { ended_at: new Date(began.getTime() + 25 * 60_000).toISOString(), note, to_diary: true });
        const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [actor.id])).rows[0]!.id;
        const dayId = uuidV5(DAY_NOTE_NAMESPACE, dayNoteIdName(space, localDayId(began)));
        return (await q<{ parent_id: string | null }>(`SELECT parent_id::text FROM content_nodes WHERE id = $1`, [dayId])).rows[0];
      };

      it("is under the chosen parent note", async () => {
        const parent = await newNote(`日記本 ${randomUUID().slice(0, 6)}`);
        await writePref(actor, "dayNoteParent", parent);
        expect(await endOn(6, "放在父筆記底下")).toEqual({ parent_id: parent });
      });

      it("is at the top level when the parent is gone, trashed or hidden", async () => {
        const trashed = await newNote(`垃圾 ${randomUUID().slice(0, 6)}`);
        await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [trashed]);
        await writePref(actor, "dayNoteParent", trashed);
        expect(await endOn(7, "父筆記在垃圾桶")).toEqual({ parent_id: null });
        const hidden = await newNote(`隱藏 ${randomUUID().slice(0, 6)}`);
        await seedQ(`UPDATE content_nodes SET hidden = true WHERE id = $1`, [hidden]);
        await writePref(actor, "dayNoteParent", hidden);
        expect(await endOn(8, "父筆記被隱藏")).toEqual({ parent_id: null });
        await writePref(actor, "dayNoteParent", randomUUID());
        expect(await endOn(9, "父筆記不存在")).toEqual({ parent_id: null });
      });

      it("is at the top level when no parent is set", async () => {
        await writePref(actor, "dayNoteParent", null);
        expect(await endOn(10, "沒有設定")).toEqual({ parent_id: null });
      });
    });

    it("writes the sentence only where it can: no day note and the module off is not an error", async () => {
      const id = randomUUID();
      await send("/tasks/focus", "POST", { id, started_at: minutesAgo(30) });
      const end = await send(`/tasks/focus/${id}/end`, "POST", { note: "沒有任務", to_task: true });
      expect(await json(end)).toMatchObject({ written: { diary: false, task: false } });
    });
  });
});
