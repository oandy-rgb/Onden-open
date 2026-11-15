// The tasks module (src/modules/tasks, docs/architecture/tasks-module.md):
// standalone tasks (no note, a space of their own), the new date fields, the
// two kinds of repeat, putting a task into a note and taking it out, and what
// "off" means. Runs the module through mountModules, the way the app does.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import { mountModules } from "../modules/index.js";
import { tasksModule } from "../modules/tasks/index.js";
import { drainDueTasks } from "../modules/tasks/scheduler.js";
import { localDayId } from "../localDay.js";
import { readableNodeIdSet, canReadNode } from "../services/readPolicy.js";
import { buildBootstrap } from "../services/sync/bootstrap.js";
import { buildSyncDelta } from "../services/sync/delta.js";
import { taskRowById } from "../services/tasksStore.js";
import { reservedTagFixture, taskModuleTagId } from "./helpers/reservedTag.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";

// Everything here happens in a workspace of this file's own.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

type Row = {
  id: string; node_id: string | null; title: string; status: string; space_id: string | null;
  when_date: string | null; due_date: string | null; evening: boolean; someday: boolean; deadline: string | null;
  recur: string | null; recur_mode: string; remind_at: string | null; has_body: boolean;
};

describe.skipIf(!isTestDb)("tasks module (DB)", () => {
  const stamp = Date.now();
  let actor: ActorCtx | null = null;
  const alice: ActorCtx = { id: "alice", name: "Alice", role: "admin", type: "human" };
  const bob: ActorCtx = { id: "bob", name: "Bob", role: "editor", type: "human" };
  const carol: ActorCtx = { id: "carol", name: "Carol", role: "editor", type: "human" };
  const viola: ActorCtx = { id: "viola", name: "Viola", role: "viewer", type: "human" };
  let aliceSpace = "";
  let teamSpace = "";   // alice + bob edit, viola views, carol is not in it
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/nodes", nodesRouter);

  const as = (who: ActorCtx) => { actor = who; };
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
  const create = async (body: Record<string, unknown>): Promise<Row> => {
    const res = await send("POST", "/api/tasks", { id: randomUUID(), ...body });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    return json<Row>(res);
  };
  const patch = (id: string, body: Record<string, unknown>) => send("PATCH", `/api/tasks/${id}`, body);
  const note = async (title: string, markdown: string, space?: string): Promise<{ id: string; markdown: string }> => {
    const res = await send("POST", "/api/nodes", { title, markdown, ...(space ? { space_id: space } : {}) });
    expect(res.status).toBe(201);
    return json(res);
  };
  const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
  const row = async (id: string) => (await taskRowById(WS, id))!;
  const attr = async (id: string, key: string) =>
    (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [id, key])).rows[0]?.value ?? null;
  const events = async (id: string, type: string) =>
    (await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND event_type = $3`, [WS, id, type])).rows.length;
  const day = (offset: number) => {
    const d = new Date(`${localDayId()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const agendaIds = async (who: ActorCtx) => {
    as(who);
    const agenda = await json<{ buckets: Record<string, Array<{ id: string }>>; done: Array<{ id: string }> }>(await send("GET", "/api/tasks/agenda"));
    return new Set([...Object.values(agenda.buckets).flat(), ...agenda.done].map((t) => t.id));
  };

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Tasks module', $1) RETURNING id`, [`tasks-module-${stamp}`])).rows[0]!.id;
    for (const who of [alice, bob, carol, viola]) Object.assign(who, await persistActor(WS, who));
    aliceSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [alice.id])).rows[0]!.id;
    teamSpace = await makeSpace(WS, `team-${stamp}`, [{ id: alice.id, permission: "edit" }, { id: bob.id, permission: "edit" }, { id: viola.id, permission: "view" }]);
    await setModulesOn(WS, null);
    mountModules(app, [tasksModule]);
  });

  describe("a standalone task", () => {
    // Each test makes its own task: the order they run in is random.
    it("is made with no note, in its maker's personal space, with the tasks reference and every field", async () => {
      as(alice);
      const id = randomUUID();
      const res = await send("POST", "/api/tasks", {
        id, title: "  Water the plants ", when_date: day(0), evening: true, deadline: day(5),
        recur: "3d", recur_mode: "after", remind_at: `${day(0)}T18:30`,
      });
      expect(res.status).toBe(201);
      expect(await json<Row>(res)).toMatchObject({
        id, node_id: null, title: "Water the plants", status: "todo", space_id: aliceSpace,
        when_date: day(0), due_date: day(0), evening: true, someday: false, deadline: day(5),
        recur: "3d", recur_mode: "after", remind_at: `${day(0)}T18:30`, has_body: false,
      });
      const stored = await q<{ parent_id: string | null; hidden: boolean; module: string | null }>(
        `SELECT n.parent_id, n.hidden, (SELECT r.function_id FROM function_refs r WHERE r.holder_node_id = n.id) AS module
           FROM content_nodes n WHERE n.id = $1`, [id]);
      expect(stored.rows[0]).toEqual({ parent_id: null, hidden: true, module: "tasks" });
      expect(await events(id, "NODE_CREATED")).toBe(1);
    });

    it("answers a replay of the same id with the task it made, and refuses an id that is something else", async () => {
      as(alice);
      const { id } = await create({ title: "Replayed" });
      const again = await send("POST", "/api/tasks", { id, title: "Replayed" });
      expect(again.status).toBe(201);
      expect((await json<Row>(again)).id).toBe(id);
      expect(await events(id, "NODE_CREATED")).toBe(1);
      const aNote = await note(`not a task ${stamp}`, "x");
      const clash = await send("POST", "/api/tasks", { id: aNote.id, title: "x" });
      expect(clash.status).toBe(409);
      expect(await json(clash)).toEqual({ error: "id_conflict" });
      as(bob); // an id someone else's task holds
      expect((await send("POST", "/api/tasks", { id, title: "mine now" })).status).toBe(409);
    });

    it("is read by its own space's rule: its maker sees it, no one else, anywhere", async () => {
      as(alice);
      const { id } = await create({ title: "Private", when_date: day(0), evening: true });
      expect(await canReadNode(alice, id)).toBe(true);
      expect(await canReadNode(bob, id)).toBe(false);
      expect((await readableNodeIdSet(alice, WS)).has(id)).toBe(true);
      expect((await readableNodeIdSet(bob, WS)).has(id)).toBe(false);
      expect((await agendaIds(alice)).has(id)).toBe(true);
      expect((await agendaIds(bob)).has(id)).toBe(false);
      // bootstrap and sync, the two ways a device learns its tasks
      const forAlice = await buildBootstrap(alice, WS, { slimBodies: false });
      const forBob = await buildBootstrap(bob, WS, { slimBodies: false });
      expect((forAlice.tasks as Row[]).find((t) => t.id === id)).toMatchObject({ node_id: null, space_id: aliceSpace });
      expect((forBob.tasks as Row[]).some((t) => t.id === id)).toBe(false);
      const delta = await buildSyncDelta(alice, WS, { since: 0, known: [] });
      expect(delta.tasks.upsert.find((t) => t.id === id)).toMatchObject({ node_id: null, when_date: day(0), evening: true });
      const deltaBob = await buildSyncDelta(bob, WS, { since: 0, known: [] });
      expect(deltaBob.tasks.upsert.some((t) => t.id === id)).toBe(false);
      // and no write: bob's PATCH is refused, nothing changes
      as(bob);
      expect([403, 404]).toContain((await patch(id, { status: "done" })).status);
      expect((await row(id)).status).toBe("todo");
    });

    it("is not a note: absent from the bootstrap's nodes, whoever reads", async () => {
      as(alice);
      const { id } = await create({ title: "Not a note" });
      const forAlice = await buildBootstrap(alice, WS, { slimBodies: false });
      expect((forAlice.nodes as Array<{ id: string }>).some((n) => n.id === id)).toBe(false);
      const delta = await buildSyncDelta(alice, WS, { since: 0, known: [] });
      expect(delta.nodes.upsert.some((n) => n.id === id)).toBe(false);
    });

    it("can carry text of its own, read and written like a note body, readable by the same people only", async () => {
      as(alice);
      const { id } = await create({ title: "With text" });
      expect((await send("PATCH", `/api/nodes/${id}`, { markdown: "Use the green can.\n" })).status).toBe(200);
      expect((await row(id)).has_body).toBe(true);
      expect((await json<{ markdown: string }>(await send("GET", `/api/nodes/${id}`))).markdown).toBe("Use the green can.\n");
      expect((await agendaIds(alice)).has(id)).toBe(true);
      as(bob);
      expect((await send("GET", `/api/nodes/${id}`)).status).toBe(404);
      expect([403, 404]).toContain((await send("PATCH", `/api/nodes/${id}`, { markdown: "mine" })).status);
      expect(await bodyOf(id)).toBe("Use the green can.\n");
    });

    it("lives in the space it is made in: a team space is read by its members, written by its editors", async () => {
      as(alice);
      const shared = await create({ title: "Book the room", space_id: teamSpace, when_date: day(2) });
      expect(shared.space_id).toBe(teamSpace);
      expect((await agendaIds(bob)).has(shared.id)).toBe(true);
      expect((await agendaIds(viola)).has(shared.id)).toBe(true);
      expect((await agendaIds(carol)).has(shared.id)).toBe(false);
      as(bob);
      expect((await patch(shared.id, { status: "doing" })).status).toBe(200);
      as(viola); // reads, may not write
      expect((await patch(shared.id, { status: "done" })).status).toBe(403);
      expect((await row(shared.id)).status).toBe("doing");
      as(carol);
      expect([403, 404]).toContain((await patch(shared.id, { status: "done" })).status);
      expect((await row(shared.id)).status).toBe("doing");
    });

    it("goes to the trash and comes back like any node: gone from the agenda and the sync, then restored", async () => {
      as(alice);
      const { id } = await create({ title: "Bin me", when_date: day(1) });
      const cursor = Number((await q<{ id: string }>(`SELECT COALESCE(max(id), 0)::text AS id FROM domain_events WHERE workspace_id = $1`, [WS])).rows[0]!.id);
      expect((await send("DELETE", `/api/nodes/${id}`)).status).toBe(200);
      expect((await agendaIds(alice)).has(id)).toBe(false);
      const gone = await buildSyncDelta(alice, WS, { since: cursor, known: [id] });
      expect(gone.tasks.delete).toContain(id);
      expect(gone.nodes.delete).not.toContain(id);
      expect((await send("POST", `/api/nodes/${id}/undelete`)).status).toBe(200);
      expect((await agendaIds(alice)).has(id)).toBe(true);
      expect(await row(id)).toMatchObject({ node_id: null, when_date: day(1), space_id: aliceSpace });
    });

    it("cannot be made in a space the maker may not write", async () => {
      as(viola);
      expect((await send("POST", "/api/tasks", { id: randomUUID(), title: "no", space_id: teamSpace })).status).toBe(403);
      as(carol);
      expect((await send("POST", "/api/tasks", { id: randomUUID(), title: "no", space_id: teamSpace })).status).toBe(403);
      // their own personal space is theirs
      const mine = await create({ title: "carol's" });
      expect(mine.space_id).toBe((await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [carol.id])).rows[0]!.id);
    });

    it("refuses what is not a task field", async () => {
      as(alice);
      for (const body of [
        { title: "x", when_date: "2026-02-30" }, { title: "x", deadline: "tomorrow" }, { title: "x", recur: "0d" },
        { title: "x", recur_mode: "sometimes" }, { title: "x", remind_at: "9am" }, { title: "" },
        { title: "x", when_date: "2026-10-02", due_date: "2026-10-03" },
      ]) expect((await send("POST", "/api/tasks", body)).status, JSON.stringify(body)).toBe(400);
    });
  });

  describe("the date fields", () => {
    it("are set, changed and cleared on PATCH, each its own event; a same-value PATCH writes nothing", async () => {
      as(alice);
      const t = await create({ title: "Dates" });
      const res = await patch(t.id, { when_date: day(1), evening: true, deadline: day(4), recur: "1w", recur_mode: "after", remind_at: `${day(1)}T08:00:00Z` });
      expect(res.status).toBe(200);
      expect(await json<Row>(res)).toMatchObject({
        when_date: day(1), due_date: day(1), evening: true, deadline: day(4), recur: "1w", recur_mode: "after", remind_at: `${day(1)}T08:00:00Z`,
      });
      expect(await attr(t.id, "_task_when")).toBe(day(1));
      expect(await attr(t.id, "_task_evening")).toBe("true");
      expect(await attr(t.id, "_task_recur_mode")).toBe("after");
      const before = await events(t.id, "ATTRIBUTE_SET");
      expect((await patch(t.id, { when_date: day(1), evening: true })).status).toBe(200);
      expect(await events(t.id, "ATTRIBUTE_SET")).toBe(before);
      // null clears; a cleared flag is off and leaves no row; fixed is the default and leaves no row
      const cleared = await json<Row>(await patch(t.id, { when_date: null, evening: null, deadline: null, remind_at: null, recur_mode: "fixed" }));
      expect(cleared).toMatchObject({ when_date: null, due_date: null, evening: false, deadline: null, remind_at: null, recur_mode: "fixed", recur: "1w" });
      for (const key of ["_task_when", "_task_evening", "_task_deadline", "_task_remind_at", "_task_recur_mode"]) expect(await attr(t.id, key)).toBeNull();
      expect(await events(t.id, "ATTRIBUTE_DELETED")).toBeGreaterThanOrEqual(5);
    });

    it("someday is a flag of its own: it parks the task whatever its day, and clears like the others", async () => {
      as(alice);
      const t = await create({ title: "Whenever", when_date: day(-2) });
      const parked = await json<Row>(await patch(t.id, { someday: true }));
      expect(parked).toMatchObject({ someday: true, when_date: day(-2) });
      const agenda = await json<{ buckets: Record<string, Array<{ id: string }>> }>(await send("GET", "/api/tasks/agenda"));
      expect(agenda.buckets.later!.some((r) => r.id === t.id)).toBe(true);
      expect(agenda.buckets.overdue!.some((r) => r.id === t.id)).toBe(false);
      expect((await json<Row>(await patch(t.id, { someday: false }))).someday).toBe(false);
      expect(await attr(t.id, "_task_someday")).toBeNull();
      const back = await json<{ buckets: Record<string, Array<{ id: string }>> }>(await send("GET", "/api/tasks/agenda"));
      expect(back.buckets.overdue!.some((r) => r.id === t.id)).toBe(true);
    });

    it("keep working for a client older than the module: due_date is the day, a time in it is the reminder, 'later' is parked", async () => {
      as(alice);
      const t = await create({ title: "Old client", due_date: `${day(2)}T14:30` });
      expect(t).toMatchObject({ when_date: day(2), due_date: day(2), remind_at: `${day(2)}T14:30` });
      expect(await json<Row>(await patch(t.id, { due_date: day(3) }))).toMatchObject({ when_date: day(3), due_date: day(3), remind_at: `${day(3)}T14:30` }); // the reminder moves with the day
      expect(await json<Row>(await patch(t.id, { status: "later" }))).toMatchObject({ status: "todo", someday: true });
      expect(await json<Row>(await patch(t.id, { due_date: null }))).toMatchObject({ when_date: null, due_date: null });
      // the node route older clients use still takes a due_date
      const host = await note(`old host ${stamp}`, "x");
      const under = await send("POST", `/api/nodes/${host.id}/tasks`, { title: "under", due_date: day(1), recur: "1d" });
      expect(under.status).toBe(201);
      expect(await json<Row>(under)).toMatchObject({ node_id: host.id, when_date: day(1), due_date: day(1), recur: "1d", space_id: expect.any(String) });
    });

    it("a reminder written as the wall clock follows its task's time (quick add, 2026-11-15); a row saved as an exact instant does not move", async () => {
      as(alice);
      const wall = await create({ title: "Quick wall", when_date: day(2), time: "15:00", remind_at: `${day(2)}T15:00` });
      expect(await json<Row>(await patch(wall.id, { time: "17:00" }))).toMatchObject({ remind_at: `${day(2)}T17:00` });
      expect(await json<Row>(await patch(wall.id, { when_date: day(3), time: "10:30" }))).toMatchObject({ remind_at: `${day(3)}T10:30` });
      const exact = await create({ title: "Old exact", when_date: day(2), time: "15:00", remind_at: `${day(2)}T07:00:00.000Z` });
      expect(await json<Row>(await patch(exact.id, { time: "17:00" }))).toMatchObject({ remind_at: `${day(2)}T07:00:00.000Z` });
      expect(await json<Row>(await patch(exact.id, { when_date: day(4) }))).toMatchObject({ remind_at: `${day(2)}T07:00:00.000Z` });
    });

    it("refuse nothing-to-change and contradictions", async () => {
      as(alice);
      const t = await create({ title: "Bad patches" });
      expect((await patch(t.id, {})).status).toBe(400);
      expect((await patch(t.id, { when_date: day(1), due_date: day(2) })).status).toBe(400);
      expect((await patch(t.id, { deadline: "soon" })).status).toBe(400);
      expect((await patch(t.id, { remind_at: "2026-10-24" })).status).toBe(400);
    });
  });

  describe("repeating", () => {
    it("fixed follows the schedule: finishing early or late does not move the next one; the deadline and reminder keep their distance", async () => {
      as(alice);
      const t = await create({ title: "Weekly", when_date: day(0), recur: "1w", deadline: day(2), remind_at: `${day(0)}T09:00` });
      expect((await patch(t.id, { status: "done" })).status).toBe(200);
      const next = (await q<{ id: string }>(
        `SELECT id FROM content_nodes WHERE workspace_id = $1 AND title = 'Weekly' AND id <> $2 AND parent_id IS NULL`, [WS, t.id])).rows[0]!.id;
      expect(await row(next)).toMatchObject({
        status: "todo", node_id: null, space_id: aliceSpace, when_date: day(7), deadline: day(9), remind_at: `${day(7)}T09:00`, recur: "1w", recur_mode: "fixed",
      });
    });

    it("mints the next occurrence once per task: tick, reopen, tick again mints nothing, also after the minted one was deleted", async () => {
      as(alice);
      const t = await create({ title: "Once only", when_date: day(0), recur: "1d" });
      const minted = async () => (await q<{ id: string; deleted_at: string | null }>(
        `SELECT id, deleted_at FROM content_nodes WHERE workspace_id = $1 AND title = 'Once only' AND id <> $2`, [WS, t.id])).rows;
      expect((await patch(t.id, { status: "done" })).status).toBe(200);
      const [first] = await minted();
      expect(first).toBeTruthy();
      // Reopen and tick again: the minted one stays as it is (it may have been edited), no second one appears.
      expect((await patch(first!.id, { title: "Once only" })).status).toBe(200);
      expect((await patch(t.id, { status: "todo" })).status).toBe(200);
      expect((await patch(t.id, { status: "done" })).status).toBe(200);
      expect((await minted()).map((r) => r.id)).toEqual([first!.id]);
      // The minted one is deleted: a third tick does not bring it back.
      await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [first!.id]);
      expect((await patch(t.id, { status: "todo" })).status).toBe(200);
      expect((await patch(t.id, { status: "done" })).status).toBe(200);
      expect((await minted()).map((r) => r.id)).toEqual([first!.id]);
      // The minted occurrence repeats too, and mints its own next one once.
      const other = await create({ title: "Chain", when_date: day(0), recur: "1d" });
      expect((await patch(other.id, { status: "done" })).status).toBe(200);
      const nextOfOther = (await q<{ id: string }>(`SELECT id FROM content_nodes WHERE workspace_id = $1 AND title = 'Chain' AND id <> $2`, [WS, other.id])).rows[0]!.id;
      expect((await patch(nextOfOther, { status: "done" })).status).toBe(200);
      expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND title = 'Chain'`, [WS])).rows.length).toBe(3);
    });

    it("after counts from the day it was done, whenever the schedule said", async () => {
      as(alice);
      const t = await create({ title: "After", when_date: day(-10), recur: "2w", recur_mode: "after", deadline: day(-8) });
      expect((await patch(t.id, { status: "done" })).status).toBe(200);
      const next = (await q<{ id: string }>(
        `SELECT id FROM content_nodes WHERE workspace_id = $1 AND title = 'After' AND id <> $2 AND parent_id IS NULL`, [WS, t.id])).rows[0]!.id;
      expect(await row(next)).toMatchObject({ when_date: day(14), deadline: day(16), recur: "2w", recur_mode: "after" });
    });

    it("after works for a task with no day at all", async () => {
      as(alice);
      const t = await create({ title: "After nodate", recur: "3d", recur_mode: "after" });
      expect((await patch(t.id, { status: "done" })).status).toBe(200);
      const next = (await q<{ id: string }>(
        `SELECT id FROM content_nodes WHERE workspace_id = $1 AND title = 'After nodate' AND id <> $2`, [WS, t.id])).rows[0]!.id;
      expect(await row(next)).toMatchObject({ when_date: day(3), recur_mode: "after" });
    });

    it("a fixed repeat with no day has nothing to follow, so finishing it makes no next one", async () => {
      as(alice);
      const t = await create({ title: "Fixed nodate", recur: "1d" });
      expect((await patch(t.id, { status: "done" })).status).toBe(200);
      expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND title = 'Fixed nodate'`, [WS])).rows).toHaveLength(1);
    });

    it("the scheduler rolls a missed fixed occurrence and leaves after, someday and the one-off alone", async () => {
      as(alice);
      const fixed = await create({ title: "Sched fixed", when_date: day(-3), recur: "1d", deadline: day(-2) });
      const after = await create({ title: "Sched after", when_date: day(-3), recur: "1d", recur_mode: "after" });
      const parked = await create({ title: "Sched parked", when_date: day(-3), recur: "1d", someday: true });
      const once = await create({ title: "Sched once", when_date: day(-3) });
      await drainDueTasks({ today: localDayId() });
      expect((await row(fixed.id)).status).toBe("cancelled");
      const minted = (await q<{ id: string }>(
        `SELECT id FROM content_nodes WHERE workspace_id = $1 AND title = 'Sched fixed' AND id <> $2`, [WS, fixed.id])).rows[0]!.id;
      expect(await row(minted)).toMatchObject({ status: "todo", node_id: null, space_id: aliceSpace, when_date: day(1), deadline: day(2), recur: "1d" });
      for (const t of [after, parked, once]) expect((await row(t.id)).status).toBe("todo");
      expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND title IN ('Sched after', 'Sched parked', 'Sched once')`, [WS])).rows).toHaveLength(3);
    });
  });

  describe("putting a task into a note and taking it out", () => {
    // 段落身分只在 block_anchors：存檔替帶 {標籤} 的區塊建錨點，測試以區塊文字（引文）查回它的 id。
    const anchorOf = async (noteId: string, text: string, last = false): Promise<string> => {
      const r = await q<{ anchor_id: string }>(`SELECT anchor_id FROM block_anchors WHERE note_id = $1 AND quote LIKE $2 ORDER BY from_utf16, to_utf16 DESC`, [noteId, `%${text}%`]);
      // 列表項的引文含它的子項，所以「巢狀的那個」取最後建立的
      expect(r.rows.length, `an anchor of "${text}"`).toBeGreaterThan(0);
      return r.rows[last ? r.rows.length - 1 : 0]!.anchor_id;
    };
    it("writes the task as a checkbox line after the block named, links it, moves the task under the note, and the line and the task stay in step", async () => {
      as(alice);
      const host = await note(`place host ${stamp}`, "# Plan\n\n- first {mark}\n- second {mark}\n");
      const t = await create({ title: "Pack the bags", when_date: day(1), deadline: day(3) });
      const res = await send("POST", `/api/tasks/${t.id}/place`, { note_id: host.id, after_block_ref: await anchorOf(host.id, "first") });
      expect(res.status).toBe(200);
      const placed = await json<Row & { block_ref: string }>(res);
      expect(placed).toMatchObject({ id: t.id, node_id: host.id, when_date: day(1), deadline: day(3), space_id: aliceSpace });
      expect(await bodyOf(host.id)).toBe("# Plan\n\n- first {mark}\n- [ ] Pack the bags {task}\n- second {mark}\n");
      const link = await q(`SELECT 1 FROM block_nodes WHERE note_id = $1 AND block_ref = $2 AND task_id = $3 AND hidden_at IS NULL`, [host.id, placed.block_ref, t.id]);
      expect(link.rows).toHaveLength(1);
      // adopted, not copied: still the one task
      expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND title = 'Pack the bags'`, [WS])).rows).toHaveLength(1);
      // done in the task list ticks the line; ticking the line completes the task
      expect((await patch(t.id, { status: "done" })).status).toBe(200);
      expect(await bodyOf(host.id)).toContain("- [x] Pack the bags {task}");
      const reopened = (await bodyOf(host.id)).replace("- [x] Pack", "- [ ] Pack");
      expect((await send("PATCH", `/api/nodes/${host.id}`, { markdown: reopened })).status).toBe(200);
      expect((await row(t.id)).status).toBe("todo");
    });

    it("finds the block to follow whichever kind it is (every anchored block, tagged here), and taking the task out gives the note back exactly", async () => {
      as(alice);
      // 前面放一個普通項目：列表第一項的錨點範圍與整個列表相同時，錨點會被讀成「列表」而不是「列表項」（見報告）。
      const original = "Intro paragraph {mark}\n\n- plain item\n- tagged item {star}\n  - nested {mark}\n\nLast paragraph\n";
      const host = await note(`anchor host ${stamp}`, original);
      const refs = { p11111: await anchorOf(host.id, "Intro paragraph"), t22222: await anchorOf(host.id, "tagged item"), n33333: await anchorOf(host.id, "nested", true) };
      for (const after of ["p11111", "t22222", "n33333"] as const) {
        const t = await create({ title: `After ${after}` });
        await json<Row & { block_ref: string }>(await send("POST", `/api/tasks/${t.id}/place`, { note_id: host.id, after_block_ref: refs[after] }));
        const body = await bodyOf(host.id);
        const line = `- [ ] After ${after} {task}`;
        const at = body.indexOf(line);
        expect(at, `${after}: ${JSON.stringify(body)}`).toBeGreaterThan(0);
        // right after the block's own scope: a paragraph's blank line, a list item's nested items
        if (after === "p11111") expect(body.slice(0, at)).toBe("Intro paragraph {mark}\n\n");
        if (after === "t22222") expect(body.slice(0, at)).toBe("Intro paragraph {mark}\n\n- plain item\n- tagged item {star}\n  - nested {mark}\n");
        if (after === "n33333") expect(body.slice(0, at).endsWith("  - nested {mark}\n  ")).toBe(true);
        expect((await send("POST", `/api/tasks/${t.id}/unplace`)).status).toBe(200);
        expect(await bodyOf(host.id), `${after}: taken out again`).toBe(original);
      }
    });

    it("puts the line at the end of the note, and a done task is written ticked", async () => {
      as(alice);
      const host = await note(`end host ${stamp}`, "Some text");
      const t = await create({ title: "Finished already" });
      await patch(t.id, { status: "done" });
      await send("POST", `/api/tasks/${t.id}/place`, { note_id: host.id });
      expect(await bodyOf(host.id)).toBe("Some text\n\n- [x] Finished already {task}\n");
      expect((await row(t.id)).status).toBe("done");
    });

    it("takes the line out of the note and leaves a standalone task with its fields and text", async () => {
      as(alice);
      const host = await note(`out host ${stamp}`, "keep me\n");
      const t = await create({ title: "Out again", when_date: day(2), evening: true });
      await send("PATCH", `/api/nodes/${t.id}`, { markdown: "the task's own text" });
      const placed = await json<Row & { block_ref: string }>(await send("POST", `/api/tasks/${t.id}/place`, { note_id: host.id }));
      expect(await bodyOf(host.id)).toContain("Out again");
      const out = await send("POST", `/api/tasks/${t.id}/unplace`);
      expect(out.status).toBe(200);
      expect(await json<Row>(out)).toMatchObject({ id: t.id, node_id: null, when_date: day(2), evening: true, has_body: true, space_id: aliceSpace });
      expect(await bodyOf(host.id)).toBe("keep me\n");
      expect(await bodyOf(t.id)).toBe("the task's own text");
      expect((await q(`SELECT 1 FROM block_nodes WHERE task_id = $1`, [t.id])).rows).toHaveLength(0);
      // The line is gone on purpose: its anchor is not left as a "maybe here" that points at some other text.
      expect((await q<{ status: string; candidate_from_utf16: number | null }>(`SELECT status, candidate_from_utf16 FROM block_anchors WHERE note_id = $1 AND anchor_id = $2`, [host.id, placed.block_ref])).rows)
        .toEqual([{ status: "lost", candidate_from_utf16: null }]);
      // the same task can go in again
      const again = await send("POST", `/api/tasks/${t.id}/place`, { note_id: host.id });
      expect(again.status).toBe(200);
      expect(placed.block_ref).not.toBe((await json<Row & { block_ref: string }>(again)).block_ref);
    });

    it("taking the line out leaves its anchor lost, not a guess at a neighbouring paragraph that reads alike", async () => {
      as(alice);
      const host = await note(`alike host ${stamp}`, "Buy milk and eggs today\n\nkeep me\n");
      const t = await create({ title: "Buy milk and eggs" });
      const placed = await json<Row & { block_ref: string }>(await send("POST", `/api/tasks/${t.id}/place`, { note_id: host.id }));
      expect((await send("POST", `/api/tasks/${t.id}/unplace`)).status).toBe(200);
      expect((await q<{ status: string; candidate_from_utf16: number | null }>(`SELECT status, candidate_from_utf16 FROM block_anchors WHERE note_id = $1 AND anchor_id = $2`, [host.id, placed.block_ref])).rows)
        .toEqual([{ status: "lost", candidate_from_utf16: null }]);
    });

    it("takes out a task that was added under a note without a line: it only moves", async () => {
      as(alice);
      const host = await note(`under host ${stamp}`, "body\n");
      const added = await json<Row>(await send("POST", `/api/nodes/${host.id}/tasks`, { id: randomUUID(), title: "Added under" }));
      expect(added.node_id).toBe(host.id);
      const out = await json<Row>(await send("POST", `/api/tasks/${added.id}/unplace`));
      expect(out).toMatchObject({ node_id: null, space_id: aliceSpace });
      expect(await bodyOf(host.id)).toBe("body\n");
    });

    it("moves a task into the note's space when they differ", async () => {
      as(alice);
      const host = await note(`team host ${stamp}`, "team page\n", teamSpace);
      const t = await create({ title: "Goes to the team" });
      expect(t.space_id).toBe(aliceSpace);
      const placed = await json<Row>(await send("POST", `/api/tasks/${t.id}/place`, { note_id: host.id }));
      expect(placed).toMatchObject({ node_id: host.id, space_id: teamSpace });
      expect((await agendaIds(bob)).has(t.id)).toBe(true);
      expect((await agendaIds(carol)).has(t.id)).toBe(false);
    });

    it("refuses with the status that says why", async () => {
      as(alice);
      const host = await note(`refuse host ${stamp}`, "- a {mark}\n");
      const t = await create({ title: "Refused" });
      const place = (who: ActorCtx, id: string, body: Record<string, unknown>) => { as(who); return send("POST", `/api/tasks/${id}/place`, body); };
      // a block that is not there / a note that is not a note / a note that is not there
      expect((await place(alice, t.id, { note_id: host.id, after_block_ref: "zzzzzz" })).status).toBe(404);
      const canvas = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
         VALUES ($1, 'manual', 'canvas', $2, $3, '', $4) RETURNING id`, [WS, `canvas ${stamp}`, `canvas-${stamp}`, aliceSpace])).rows[0]!;
      expect((await place(alice, t.id, { note_id: canvas.id })).status).toBe(409);
      expect((await place(alice, t.id, { note_id: randomUUID() })).status).toBe(404);
      expect((await place(alice, t.id, { note_id: "not-a-uuid" })).status).toBe(400);
      // a note the maker may not write
      const teamNote = await (async () => { as(alice); return note(`view-only ${stamp}`, "x", teamSpace); })();
      const viewerTask = await (async () => { as(viola); return create({ title: "Viola's" }); })();
      expect((await place(viola, viewerTask.id, { note_id: teamNote.id })).status).toBe(403);
      // someone else's task, a task already in a note, a task not in one
      expect((await place(bob, t.id, { note_id: host.id })).status).toBe(404);
      expect((await place(alice, t.id, { note_id: host.id })).status).toBe(200);
      expect((await place(alice, t.id, { note_id: host.id })).status).toBe(409);
      as(bob);
      expect((await send("POST", `/api/tasks/${t.id}/unplace`)).status).toBe(404);
      as(alice);
      const loose = await create({ title: "Loose" });
      expect((await send("POST", `/api/tasks/${loose.id}/unplace`)).status).toBe(409);
      // nothing half-done: the failed attempts left the note as the one good place wrote it
      expect((await bodyOf(host.id)).match(/Refused/g)).toHaveLength(1);
    });

    it("a refused place leaves task and note as they were (one transaction)", async () => {
      as(alice);
      const host = await note(`atomic host ${stamp}`, "- a {mark}\n");
      const t = await create({ title: "Atomic" });
      const noteRow = await q<{ updated_at: string }>(`SELECT updated_at::text FROM content_nodes WHERE id = $1`, [host.id]);
      expect((await send("POST", `/api/tasks/${t.id}/place`, { note_id: host.id, after_block_ref: "nope" })).status).toBe(404);
      expect((await row(t.id)).node_id).toBeNull();
      expect(await bodyOf(host.id)).toBe("- a {mark}\n");
      expect((await q<{ updated_at: string }>(`SELECT updated_at::text FROM content_nodes WHERE id = $1`, [host.id])).rows[0]).toEqual(noteRow.rows[0]);
    });
  });

  describe("tasks written in a note stay as they were", () => {
    it("a `{task}` line makes a task under the note, and ticking either side completes both", async () => {
      as(alice);
      const host = await note(`lines ${stamp}`, "- [ ] Write it down {task}\n- [ ] only a box\n");
      const tasks = (await q<{ id: string; title: string }>(`SELECT id, title FROM content_nodes WHERE parent_id = $1 AND hidden`, [host.id])).rows;
      expect(tasks.map((t) => t.title)).toEqual(["Write it down"]);
      const t = tasks[0]!;
      expect(await row(t.id)).toMatchObject({ node_id: host.id, space_id: aliceSpace, status: "todo" });
      expect((await patch(t.id, { status: "done" })).status).toBe(200);
      expect(await bodyOf(host.id)).toMatch(/^- \[x\] Write it down \{task\}/);
      // a task line is also readable like any: by the people of the note's space only
      expect((await agendaIds(bob)).has(t.id)).toBe(false);
    });
  });

  describe("the tag", () => {
    it("is the tasks module's tag: marked, not inherited by blocks, and protected from being deleted or merged away", async () => {
      // a task does not make the tag (it references the tasks function); the module's own tag is made by turning the module on
      as(alice);
      const tagId = await reservedTagFixture(WS, "task");
      const tag = (await q<{ reserved_key: string | null; title: string }>(
        `SELECT reserved_key, title FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!;
      expect(tag).toMatchObject({ reserved_key: null, title: "task" });
      const del = await send("DELETE", `/api/nodes/${tagId}`);
      expect(del.status).toBe(409);
      expect(await json(del)).toMatchObject({ error: "reserved_tag" });
    });
  });

  describe("turned off", () => {
    it("keeps the tasks and their tag, refuses task writes, runs no scheduler, leaves note lines and checkboxes alone; turned on, it picks up", async () => {
      as(alice);
      const host = await note(`off host ${stamp}`, "- [ ] Line task {task}\n- [ ] plain box\n");
      const line = (await q<{ id: string }>(`SELECT id FROM content_nodes WHERE parent_id = $1 AND hidden`, [host.id])).rows[0]!.id;
      const rolling = await create({ title: "Off rolling", when_date: day(-3), recur: "1d" });
      const tagBefore = await taskModuleTagId(WS);

      await q(`UPDATE workspaces SET modules_off = '["tasks"]'::jsonb WHERE id = $1`, [WS]);
      // writes under the module's paths answer 409, as for every module that is off; reads stay open
      for (const [method, path, body] of [
        ["POST", "/api/tasks", { id: randomUUID(), title: "off" }],
        ["PATCH", `/api/tasks/${rolling.id}`, { status: "done" }],
        ["POST", `/api/tasks/${rolling.id}/place`, { note_id: host.id }],
        ["POST", `/api/tasks/${rolling.id}/unplace`, {}],
        ["POST", `/api/nodes/${host.id}/tasks`, { title: "off" }],
      ] as const) {
        const res = await send(method, path, body);
        expect(res.status, `${method} ${path}`).toBe(409);
        expect(await json(res)).toEqual({ error: "module_not_imported", module: "tasks" });
      }
      expect((await agendaIds(alice)).has(rolling.id)).toBe(true);
      // the scheduler skips the workspace
      await drainDueTasks({ today: localDayId() });
      expect((await row(rolling.id)).status).toBe("todo");
      expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND title = 'Off rolling'`, [WS])).rows).toHaveLength(1);
      // a checkbox is core Markdown: it ticks; a new `{task}` line makes no task; the old one is left as it is
      const edited = `- [x] Line task {task}\n- [x] plain box\n- [ ] Brand new {task}\n`;
      expect((await send("PATCH", `/api/nodes/${host.id}`, { markdown: edited })).status).toBe(200);
      expect(await bodyOf(host.id)).toContain("- [x] plain box");
      expect((await row(line)).status).toBe("todo");
      expect((await q(`SELECT 1 FROM content_nodes WHERE parent_id = $1 AND hidden AND title = 'Brand new'`, [host.id])).rows).toHaveLength(0);
      expect((await q(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [line])).rows[0]).toEqual({ deleted_at: null });
      expect(await taskModuleTagId(WS)).toBe(tagBefore);

      // on again: the next save brings the lines and their tasks in step
      await q(`UPDATE workspaces SET modules_off = '[]'::jsonb WHERE id = $1`, [WS]);
      expect((await send("PATCH", `/api/nodes/${host.id}`, { markdown: edited + "\n" })).status).toBe(200);
      expect((await row(line)).status).toBe("done");
      expect((await q(`SELECT 1 FROM content_nodes WHERE parent_id = $1 AND hidden AND title = 'Brand new'`, [host.id])).rows).toHaveLength(1);
      expect((await patch(rolling.id, { status: "doing" })).status).toBe(200);
      await drainDueTasks({ today: localDayId() });
      expect((await row(rolling.id)).status).toBe("cancelled");
    });
  });
});
