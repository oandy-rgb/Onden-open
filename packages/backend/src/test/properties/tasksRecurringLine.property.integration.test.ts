// A repeating task written as a line of a note (`- [ ] 每日運動 {task}`) over a random life: time passes, the
// scheduler ticks (drainDueTasks), the line is ticked in the note, the task is finished in Tasks, and either is
// undone (the toast's 「復原」: the task reopened). Decided 2026-11-15 (scan 10 #4, #13A): the line stands for the
// occurrence that is current, and the next occurrence carries the details text of the one before.
//
// Invariants, after every operation:
//  L1  the line points at the occurrence it is meant to: the newest one made (a finished or missed one moves it on
//      to the next), or the very one that was reopened by an undo; never at a finished/cancelled occurrence whose
//      next occurrence exists;
//  L2  the box on the line is empty whenever the occurrence it points at is open;
//  L3  every occurrence keeps its own NODE_CREATED event (the history shows each);
//  L4  every occurrence has the details text of the first (each next one copies the one before);
//  L5  a task that exists as one occurrence per date: no date twice (the line never makes a second chain).
//
// Run count: PROPS_RUNS (default 8), seed PROPS_SEED. SAFETY: skips unless DATABASE_URL is a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import fc from "fast-check";

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));

import { apiOnError } from "../../httpError.js";
import { pool, q } from "../../db.js";
import { localDayId, resetDayClock } from "../../localDay.js";
import nodesRouter from "../../routes/nodes.js";
import workspaceRouter from "../../routes/workspace.js";
import { mountModules } from "../../modules/index.js";
import { tasksModule } from "../../modules/tasks/index.js";
import { drainDueTasks } from "../../modules/tasks/scheduler.js";
import { derivedId } from "../../services/derivedIds.js";
import { derivedIdName } from "@onden/markdown";
import { awaitAllDispatchers } from "../../services/dispatcherQueue.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";
import { setWorkspaceOwner } from "../helpers/setOwner.js";
import { setModulesOn } from "../helpers/setModulesOn.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { checkAsync } from "../helpers/propsConfig.js";

const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 8;
const DAY = 86_400_000;
/** The id the occurrence after `id` has (derived ids, migration 201). */
const successorTaskIdOf = (id: string) => derivedId(derivedIdName.taskSuccessor(id));
const DETAILS = "帳號 123\n\n1. 開網站\n2. 付款";

type Op = { k: "advance"; days: number } | { k: "tick" } | { k: "complete" } | { k: "tickLine" } | { k: "undo" };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant("advance" as const), days: fc.constantFrom(1, 1, 2, 5) }) },
  { weight: 3, arbitrary: fc.constant({ k: "tick" as const }) },
  { weight: 3, arbitrary: fc.constant({ k: "complete" as const }) },
  { weight: 3, arbitrary: fc.constant({ k: "tickLine" as const }) },
  { weight: 3, arbitrary: fc.constant({ k: "undo" as const }) },
);

afterAll(async () => { vi.useRealTimers(); resetDayClock(); await awaitAllDispatchers(); await pool.end(); });

describe.skipIf(!isTestDatabase())("a repeating task line follows its current occurrence (property)", () => {
  let owner: ActorCtx;
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", owner); await next(); });
  app.route("/api/workspace", workspaceRouter);
  app.route("/api/nodes", nodesRouter);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Recurring lines', $1) RETURNING id`, [`recurring-lines-${Date.now()}`])).rows[0]!.id;
    owner = await persistActor(WS, { id: "", name: "Owner", type: "human", role: "admin" });
    await setWorkspaceOwner(WS, owner.id);
    await setModulesOn(WS, null);
    registerShippedModules();
    mountModules(app, [tasksModule]);
  });

  let counter = 0;
  const startLine = async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 2, 1, 12, 0, 0));
    resetDayClock();
    expect((await send("PATCH", "/api/workspace/time", { time_zone: "UTC", day_start_hour: 0 })).status).toBe(200);
    const title = `每日運動 ${++counter}`;
    const res = await send("POST", "/api/nodes", { title: `筆記 ${counter}`, markdown: `- [ ] ${title} {task}\n` });
    expect(res.status).toBe(201);
    const noteId = ((await res.json()) as { id: string }).id;
    const first = (await q<{ id: string }>(`SELECT task_id::text AS id FROM block_nodes WHERE note_id = $1`, [noteId])).rows[0]!.id;
    expect((await send("PATCH", `/api/tasks/${first}`, { when_date: localDayId(), recur: "1d" })).status).toBe(200);
    // The details text the first occurrence is written with ("寫細節").
    expect((await send("PATCH", `/api/nodes/${first}`, { markdown: DETAILS })).status).toBe(200);
    return { noteId, title, first };
  };
  const line = async (noteId: string) => (await q<{ task_id: string }>(`SELECT task_id::text FROM block_nodes WHERE note_id = $1`, [noteId])).rows[0]!.task_id;
  const statusOf = async (id: string) => (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_task_status'`, [id])).rows[0]?.value;
  const markdownOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
  const open = (status: string | undefined) => status !== "done" && status !== "cancelled";
  const live = async (id: string) => (await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND deleted_at IS NULL`, [id])).rows.length > 0;
  const chain = async (noteId: string) => (await q<{ id: string; status: string; when_date: string; markdown: string }>(
    `SELECT t.id::text, s.value AS status, w.value AS when_date, t.markdown
       FROM content_nodes t JOIN node_attributes s ON s.node_id = t.id AND s.key = '_task_status'
       JOIN node_attributes w ON w.node_id = t.id AND w.key = '_task_when'
      WHERE t.parent_id = $1 AND t.deleted_at IS NULL ORDER BY w.value`, [noteId])).rows;

  const checkLine = async (noteId: string, first: string, fail: (m: string) => string, expectedBack: string | null) => {
    const pointed = await line(noteId);
    const status = await statusOf(pointed);
    const successor = successorTaskIdOf(pointed);
    if (!open(status)) expect(await live(successor), fail(`L1 the line points at finished ${pointed} though its next occurrence ${successor} exists`)).toBe(false);
    if (expectedBack) expect(pointed, fail("L1 after an undo the line goes back to the reopened occurrence")).toBe(expectedBack);
    const md = await markdownOf(noteId);
    const boxed = /^- \[(.)\]/.exec(md);
    if (open(status)) expect(boxed?.[1], fail(`L2 the box is not empty while ${pointed} is open: ${md}`)).toBe(" ");
    const rows = await chain(noteId);
    for (const r of rows) {
      const created = (await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND event_type = 'NODE_CREATED'`, [WS, r.id])).rows.length;
      expect(created, fail(`L3 occurrence ${r.id} has no creation event`)).toBe(1);
      expect(r.markdown, fail(`L4 occurrence ${r.id} lost the details`)).toBe(DETAILS);
    }
    const dates = rows.map((r) => r.when_date);
    expect(new Set(dates).size, fail(`L5 a date twice: ${dates}`)).toBe(dates.length);
    expect(rows.some((r) => r.id === first)).toBe(true);
  };

  it("L1–L5", async () => {
    await checkAsync(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 12 }), async (ops) => {
      const { noteId, first } = await startLine();
      const trace: string[] = [];
      const fail = (m: string) => `${m}\nsteps:\n${trace.join("\n")}`;
      let undoTo: string | null = null; // the occurrence the last completion left: reopen it to undo
      for (const op of ops) {
        trace.push(`${JSON.stringify(op)} (today ${localDayId()})`);
        let expectedBack: string | null = null;
        const pointed = await line(noteId);
        if (op.k === "advance") vi.setSystemTime(Date.now() + op.days * DAY);
        else if (op.k === "tick") { await drainDueTasks(); undoTo = null; }
        else if (op.k === "complete" && open(await statusOf(pointed))) {
          expect((await send("PATCH", `/api/tasks/${pointed}`, { status: "done" })).status, fail("complete")).toBe(200);
          undoTo = pointed;
        } else if (op.k === "tickLine" && open(await statusOf(pointed))) {
          const md = await markdownOf(noteId);
          expect((await send("PATCH", `/api/nodes/${noteId}`, { markdown: md.replace("- [ ]", "- [x]") })).status, fail("tick the line")).toBe(200);
          undoTo = pointed;
        } else if (op.k === "undo" && undoTo && !open(await statusOf(undoTo)) && pointed === successorTaskIdOf(undoTo)) {
          expect((await send("PATCH", `/api/tasks/${undoTo}`, { status: "todo" })).status, fail("undo")).toBe(200);
          expectedBack = undoTo;
          undoTo = null;
        }
        await checkLine(noteId, first, fail, expectedBack);
      }
      await awaitAllDispatchers();
    }), RUN_CAP);
  }, 600_000);

  it("named case (scan 10 #4): finishing a line's task moves the line on to the next one, and undo puts it back", async () => {
    const { noteId, first, title } = await startLine();
    expect((await send("PATCH", `/api/tasks/${first}`, { status: "done" })).status).toBe(200);
    const second = successorTaskIdOf(first);
    expect(await line(noteId)).toBe(second);
    expect(await markdownOf(noteId)).toBe(`- [ ] ${title} {task}\n`);
    // Ticking the line in the note, on the next day, finishes the new one (and not the old).
    vi.setSystemTime(Date.now() + DAY);
    expect((await send("PATCH", `/api/nodes/${noteId}`, { markdown: `- [x] ${title} {task}\n` })).status).toBe(200);
    expect(await statusOf(second)).toBe("done");
    const third = successorTaskIdOf(second);
    expect(await line(noteId)).toBe(third);
    expect(await markdownOf(noteId)).toBe(`- [ ] ${title} {task}\n`);
    expect(await statusOf(third)).toBe("todo");
    // Undo of that: the second one is open again and the line is back on it.
    expect((await send("PATCH", `/api/tasks/${second}`, { status: "todo" })).status).toBe(200);
    expect(await line(noteId)).toBe(second);
    expect(await markdownOf(noteId)).toBe(`- [ ] ${title} {task}\n`);
  });

  it("named case (scan 10 #4): a missed day moves the line on, and ticking it finishes the newest", async () => {
    const { noteId, first, title } = await startLine();
    vi.setSystemTime(Date.now() + 2 * DAY);
    await drainDueTasks();
    const second = successorTaskIdOf(first);
    expect(await statusOf(first)).toBe("cancelled");
    expect(await line(noteId)).toBe(second);
    expect((await send("PATCH", `/api/nodes/${noteId}`, { markdown: `- [x] ${title} {task}\n` })).status).toBe(200);
    expect(await statusOf(second)).toBe("done");
    expect(await markdownOf(noteId)).toBe(`- [ ] ${title} {task}\n`);
  });

  it("named case (scan 10 #13A): the next occurrence has the details text of the one before", async () => {
    const { noteId, first } = await startLine();
    expect((await send("PATCH", `/api/tasks/${first}`, { status: "done" })).status).toBe(200);
    expect(await markdownOf(successorTaskIdOf(first))).toBe(DETAILS);
    vi.setSystemTime(Date.now() + 3 * DAY);
    await drainDueTasks();
    const rows = await chain(noteId);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) expect(r.markdown).toBe(DETAILS);
  });
});
