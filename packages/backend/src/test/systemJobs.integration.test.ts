// System actors (spine/systemJobs.ts): a background job runs through mutate()
// as actor_type 'system', holds only what its declaration lists, and cannot be
// made from request data. Runs the task scheduler for one round and checks the
// events it wrote and what /api/sync's delta (buildSyncDelta) carries.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import { mountModules } from "../modules/index.js";
import { tasksModule } from "../modules/tasks/index.js";
import { drainDueTasks } from "../modules/tasks/scheduler.js";
import { localDayId } from "../localDay.js";
import { buildSyncDelta } from "../services/sync/delta.js";
import { insertTaskNodeTx } from "../services/tasksStore.js";
import { mutate, runCascade, AuthorityError, requireActor } from "../spine/mutate.js";
import { systemActorFor } from "../spine/systemJobs.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

type EventRow = {
  id: string; event_type: string; actor_type: string; actor_id: string; target_id: string;
  triggered_by: string | null; tx_meta: Record<string, unknown> | null; payload: Record<string, unknown>;
};

describe.skipIf(!isTestDb)("system actor through mutate (DB)", () => {
  const stamp = Date.now();
  const alice: ActorCtx = { id: "sys-alice", name: "Alice", role: "admin", type: "human" };
  const scheduler = systemActorFor("task-scheduler");
  let aliceSpace = "";
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", alice); await next(); });

  const day = (offset: number) => {
    const d = new Date(`${localDayId()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const createTask = async (body: Record<string, unknown>): Promise<{ id: string }> => {
    const res = await app.request("/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: randomUUID(), ...body }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };
  const eventsOf = async (targetId: string): Promise<EventRow[]> => (await q<EventRow>(
    `SELECT id::text, event_type, actor_type, actor_id, target_id, triggered_by_event_id::text AS triggered_by, tx_meta, payload
       FROM domain_events WHERE workspace_id = $1 AND target_id = $2 ORDER BY domain_events.id`, [WS, targetId])).rows;
  const cursor = async () => Number((await q<{ m: string }>(
    `SELECT COALESCE(max(id), 0)::text AS m FROM domain_events WHERE workspace_id = $1`, [WS])).rows[0]!.m);
  const standalone = (id: string, title: string) => insertTaskNodeTx({ workspaceId: WS, id, hostId: null, spaceId: aliceSpace, title });

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('System jobs', $1) RETURNING id`, [`system-jobs-${stamp}`])).rows[0]!.id;
    Object.assign(alice, await persistActor(WS, alice));
    aliceSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [alice.id])).rows[0]!.id;
    await setModulesOn(WS, null);
    mountModules(app, [tasksModule]);
    await createTask({ title: "Makes the tasks tag" });
  });

  it("one scheduler round: both events are system events of the job, linked, with the undo a person's task has; /api/sync carries the cancel and the new task", async () => {
    const task = await createTask({ title: "Roll me", when_date: day(-3), recur: "1d" });
    const since = await cursor();
    expect((await drainDueTasks({ today: localDayId() })).rolled).toBeGreaterThanOrEqual(1);

    const [missed] = (await eventsOf(task.id)).filter((e) => e.event_type === "TASK_OCCURRENCE_MISSED");
    expect(missed).toMatchObject({ actor_type: "system", actor_id: "system-task-scheduler" });
    expect(missed!.payload).toEqual({ title: "Roll me", due_date: day(-3), when_date: day(-3), recur: "1d" });
    const created = (await q<EventRow>(
      `SELECT id::text, event_type, actor_type, actor_id, target_id, triggered_by_event_id::text AS triggered_by, tx_meta, payload
         FROM domain_events WHERE workspace_id = $1 AND event_type = 'NODE_CREATED' AND payload->>'rolled_from' = $2`, [WS, task.id])).rows;
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actor_type: "system", actor_id: "system-task-scheduler", triggered_by: missed!.id });
    expect(created[0]!.tx_meta).toEqual({ inverse_op: "node.deleted", ui_context: "task.scheduler" });
    expect(created[0]!.payload).toEqual({
      node_id: null, title: "Roll me", due_date: day(1), when_date: day(1), recur: "1d", task: true, rolled_from: task.id,
    });

    const delta = await buildSyncDelta(alice, WS, { since, known: [] });
    expect(delta.tasks.upsert.find((t) => t.id === task.id)).toMatchObject({ status: "cancelled" });
    expect(delta.tasks.upsert.find((t) => t.id === created[0]!.target_id)).toMatchObject({ status: "todo", when_date: day(1), recur: "1d" });
  });

  it("a workspace with the tasks module off is not touched, and the declaration refuses the write itself", async () => {
    const task = await createTask({ title: "Module off", when_date: day(-3), recur: "1d" });
    await q(`UPDATE workspaces SET modules_off = '["tasks"]'::jsonb WHERE id = $1`, [WS]);
    try {
      await expect(mutate({
        actor: scheduler, workspaceId: WS, authority: { kind: "system" },
        event: { type: "TASK_OCCURRENCE_MISSED", targetType: "node", targetId: task.id },
        apply: async () => {},
      })).rejects.toThrow(AuthorityError);
    } finally {
      await q(`UPDATE workspaces SET modules_off = '[]'::jsonb WHERE id = $1`, [WS]);
    }
    expect(await eventsOf(task.id)).toHaveLength(1); // only its NODE_CREATED
  });

  describe("inside the declaration / outside it", () => {
    it("allows a declared event, attributed to the job", async () => {
      const id = randomUUID();
      await mutate({
        actor: scheduler, workspaceId: WS, authority: { kind: "system" },
        event: { type: "NODE_CREATED", targetType: "node", targetId: id, payload: { task: true } },
        apply: () => standalone(id, "Declared"),
      });
      expect(await eventsOf(id)).toMatchObject([{ actor_type: "system", actor_id: "system-task-scheduler" }]);
    });

    it.each([
      ["an event kind it does not declare", { type: "NODE_UPDATED", targetType: "node" }],
      ["a target kind it does not declare", { type: "NODE_CREATED", targetType: "tag" }],
    ])("refuses %s, writing nothing", async (_, ev) => {
      const id = randomUUID();
      await expect(mutate({
        actor: scheduler, workspaceId: WS, authority: { kind: "system" },
        event: { ...ev, targetId: id }, apply: () => standalone(id, "Refused"),
      })).rejects.toThrow(AuthorityError);
      expect(await eventsOf(id)).toHaveLength(0);
      expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [id])).rows).toHaveLength(0);
    });

    it.each<[string, Parameters<typeof mutate>[0]["authority"]]>([
      ["open", { kind: "open", why: "test" }],
      ["a principal_admin check", { kind: "principal_admin" }],
      ["a node write", { kind: "node", nodeId: randomUUID(), op: "write_node" }],
      ["a cascade with no cascade around it", { kind: "cascade" }],
    ])("does not get %s authority: no owner shortcut", async (_, authority) => {
      await expect(mutate({
        actor: scheduler, workspaceId: WS, authority,
        event: { type: "NODE_CREATED", targetType: "node", targetId: randomUUID() }, apply: async () => {},
      })).rejects.toThrow(AuthorityError);
    });

    it("has no personal space: a create naming neither a parent nor a space is refused and leaves no event", async () => {
      const id = randomUUID();
      await expect(mutate({
        actor: scheduler, workspaceId: WS, authority: { kind: "system" },
        event: { type: "NODE_CREATED", targetType: "node", targetId: id },
        apply: () => insertTaskNodeTx({ workspaceId: WS, id, hostId: null, spaceId: null, title: "Nowhere" }),
      })).rejects.toThrow(/no personal space/);
      expect(await eventsOf(id)).toHaveLength(0);
    });
  });

  describe("who can be a system actor", () => {
    it("the system authority is refused to a person", async () => {
      await expect(mutate({
        actor: alice, workspaceId: WS, authority: { kind: "system" },
        event: { type: "NODE_CREATED", targetType: "node", targetId: randomUUID() }, apply: async () => {},
      })).rejects.toThrow(AuthorityError);
    });

    it("a value that only looks like a system actor is refused: built by hand, copied, or from request data", async () => {
      const lookalike = JSON.parse(JSON.stringify({ id: "system-task-scheduler", name: "任務排程器", type: "system" })) as ActorCtx;
      for (const actor of [lookalike, { ...scheduler }]) {
        await expect(mutate({
          actor, workspaceId: WS, authority: { kind: "system" },
          event: { type: "NODE_CREATED", targetType: "node", targetId: randomUUID() }, apply: async () => {},
        })).rejects.toThrow(AuthorityError);
        await expect(runCascade({ actor, workspaceId: WS, authority: { kind: "system" }, causeEventId: undefined }, async () => {}))
          .rejects.toThrow(AuthorityError);
      }
    });

    it("the HTTP boundary hands out ordinary actors only: requireActor passes a person through, and `actors` cannot hold type 'system'", async () => {
      expect(requireActor(alice)).toBe(alice);
      expect(() => requireActor(null)).toThrow();
      await expect(q(
        `INSERT INTO actors (workspace_id, name, type, external_id) VALUES ($1, 'Imposter', 'system', 'imposter')`, [WS],
      )).rejects.toThrow(/actors_type_check/);
    });
  });

  describe("a system actor as the root of a cascade", () => {
    it("nested mutates sign as the job whatever actor they claim, link triggered_by, and stay inside the declaration", async () => {
      const root = randomUUID();
      const child = randomUUID();
      await mutate({
        actor: scheduler, workspaceId: WS, authority: { kind: "system" },
        event: { type: "NODE_CREATED", targetType: "node", targetId: root },
        apply: async () => {
          await standalone(root, "Root");
          await mutate({
            actor: alice, // claimed; the cascade's root actor wins
            workspaceId: WS, authority: { kind: "cascade" },
            event: { type: "NODE_CREATED", targetType: "node", targetId: child },
            apply: () => standalone(child, "Child"),
          });
        },
      });
      const [rootEvent] = await eventsOf(root);
      const [childEvent] = await eventsOf(child);
      expect(childEvent).toMatchObject({ actor_type: "system", actor_id: "system-task-scheduler", triggered_by: rootEvent!.id });
    });

    it("a nested event outside the declaration rolls the whole operation back", async () => {
      const root = randomUUID();
      await expect(mutate({
        actor: scheduler, workspaceId: WS, authority: { kind: "system" },
        event: { type: "NODE_CREATED", targetType: "node", targetId: root },
        apply: async () => {
          await standalone(root, "Rolled back");
          await mutate({
            actor: scheduler, workspaceId: WS, authority: { kind: "cascade" },
            event: { type: "NODE_UPDATED", targetType: "node", targetId: root }, apply: async () => {},
          });
        },
      })).rejects.toThrow(AuthorityError);
      expect(await eventsOf(root)).toHaveLength(0);
      expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [root])).rows).toHaveLength(0);
    });

    it("runCascade roots a cascade on the job, whose children then use `cascade` authority", async () => {
      const id = randomUUID();
      await runCascade({ actor: scheduler, workspaceId: WS, authority: { kind: "system" }, causeEventId: undefined }, () =>
        mutate({
          actor: alice, workspaceId: WS, authority: { kind: "cascade" },
          event: { type: "NODE_CREATED", targetType: "node", targetId: id }, apply: () => standalone(id, "Via runCascade"),
        }));
      expect(await eventsOf(id)).toMatchObject([{ actor_type: "system", actor_id: "system-task-scheduler", triggered_by: null }]);
    });
  });
});
