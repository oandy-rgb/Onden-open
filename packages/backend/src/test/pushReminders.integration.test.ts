// Lock-screen reminders (Web Push): subscriptions are each person's own, the
// scheduler pushes a (task, moment) once, and nothing runs without VAPID keys.
// The push itself is an injected sender: no test reaches a push service.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import webpush from "web-push";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import pushRouter from "../routes/push.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import { drainPushReminders, startPushReminders } from "../modules/tasks/pushReminders.js";
import { resetDayClock, setDayClock } from "../localDay.js";
import type { PushSender } from "../services/webPush.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { stopAllPeriodicJobs } from "../backgroundJobs.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let current: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", current); await next(); });
app.route("/api/push", pushRouter);
app.route("/api/tasks", tasksRouter);
app.post("/api/nodes/:id/tasks", addTaskUnderNote);

const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const endpointOf = (tag: string) => `https://fcm.googleapis.com/fcm/send/${tag}`;
const keysOf = (tag: string) => ({ endpoint: endpointOf(tag), p256dh: `p256dh-${tag}`, auth: `auth-${tag}` });
const NOON = new Date("2026-10-30T09:05:00Z");

const ENV = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;

describe.skipIf(!isTestDb)("Web Push reminders (DB)", () => {
  let WS = "", hostId = "";
  let alice: ActorCtx, bob: ActorCtx;
  const saved: Record<string, string | undefined> = {};
  const stamp = Date.now();
  const made: string[] = [];

  const withKeys = () => {
    const k = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = k.publicKey;
    process.env.VAPID_PRIVATE_KEY = k.privateKey;
    process.env.VAPID_SUBJECT = "mailto:owner@example.com";
    return k;
  };

  async function addTask(title: string, fields: Record<string, unknown> = {}, host = hostId): Promise<string> {
    current = alice;
    const created = (await (await app.request(`/api/nodes/${host}/tasks`, json("POST", { title, due_date: "2026-10-30" }))).json()) as { id: string };
    const patch = await app.request(`/api/tasks/${created.id}`, json("PATCH", fields));
    expect(patch.status).toBe(200);
    made.push(created.id);
    return created.id;
  }
  const subscribe = async (who: ActorCtx, tag: string) => {
    current = who;
    return app.request("/api/push/subscriptions", json("POST", keysOf(tag)));
  };

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    await setModulesOn(WS, null);
    alice = await persistActor(WS, { id: "x", name: "Alice", role: "admin", type: "human" });
    bob = await persistActor(WS, { id: "x", name: "Bob", role: "editor", type: "human" });
    hostId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1,'manual','content','Push host','push-host-${stamp}') RETURNING id`, [WS])).rows[0]!.id;
    await seedQ(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       SELECT $1,'manual','class_tag','task','tag-task-push'
       WHERE NOT EXISTS (SELECT 1 FROM content_nodes WHERE workspace_id=$1 AND node_type='class_tag' AND deleted_at IS NULL AND title='task')`, [WS]);
  });
  beforeEach(async () => {
    withKeys();
    setDayClock({ timeZone: "UTC", dayStartHour: 0 });
    await q(`DELETE FROM push_subscriptions WHERE workspace_id = $1`, [WS]);
    await q(`DELETE FROM push_reminder_sent`);
    await setModulesOn(WS, null);
  });
  afterEach(async () => {
    resetDayClock(); stopAllPeriodicJobs();
    // Each case sees only its own tasks (the host note and tag are shared).
    await seedQ(`DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`, [made.splice(0)]);
  });
  afterAll(() => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  describe("subscriptions", () => {
    it("offers the public key, never the private one", async () => {
      current = alice;
      const keys = withKeys();
      const res = await app.request("/api/push/key");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ public_key: keys.publicKey });
      expect(text).not.toContain(keys.privateKey);
    });

    it("is absent (404) without keys, for the key and for subscribing", async () => {
      for (const k of ENV) delete process.env[k];
      current = alice;
      expect((await app.request("/api/push/key")).status).toBe(404);
      expect((await subscribe(alice, "off")).status).toBe(404);
      expect((await q(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [endpointOf("off")])).rowCount).toBe(0);
    });

    it("is off when the subject or key pair is unusable", async () => {
      current = alice;
      process.env.VAPID_SUBJECT = "owner@example.com";
      expect((await app.request("/api/push/key")).status).toBe(404);
      withKeys();
      process.env.VAPID_PRIVATE_KEY = "not-a-key";
      expect((await app.request("/api/push/key")).status).toBe(404);
    });

    it("saves, replaces on the same endpoint, and refuses endpoints that are not push services", async () => {
      expect((await subscribe(alice, "a1")).status).toBe(200);
      expect((await subscribe(alice, "a1")).status).toBe(200);
      expect((await q(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [endpointOf("a1")])).rowCount).toBe(1);
      current = alice;
      for (const endpoint of ["http://fcm.googleapis.com/x", "https://evil.example.com/x", "https://127.0.0.1/x", "https://fcm.googleapis.com.evil.com/x"]) {
        expect((await app.request("/api/push/subscriptions", json("POST", { ...keysOf("z"), endpoint }))).status).toBe(400);
      }
    });

    it("lets each person remove only their own device", async () => {
      await subscribe(alice, "mine");
      current = bob;
      expect((await app.request("/api/push/subscriptions", json("DELETE", { endpoint: endpointOf("mine") }))).status).toBe(200);
      expect((await q(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [endpointOf("mine")])).rowCount).toBe(1);
      current = alice;
      expect((await app.request("/api/push/subscriptions", json("DELETE", { endpoint: endpointOf("mine") }))).status).toBe(200);
      expect((await q(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [endpointOf("mine")])).rowCount).toBe(0);
    });

    it("is for a signed-in person only", async () => {
      current = null;
      expect((await app.request("/api/push/key")).status).toBe(401);
    });
  });

  describe("the every-minute pass", () => {
    it("sends a due reminder once, to every device of a person who can read it, with only the title and the time", async () => {
      await subscribe(alice, "p1"); await subscribe(alice, "p2"); await subscribe(bob, "p3");
      const id = await addTask("Call the dentist", { remind_at: "2026-10-30T09:00:00Z" });
      const send = vi.fn<PushSender>().mockResolvedValue();

      const first = await drainPushReminders({ at: NOON, send });
      expect(first.sent).toBe(3);
      expect(send.mock.calls.map((c) => c[0].endpoint).sort()).toEqual([endpointOf("p1"), endpointOf("p2"), endpointOf("p3")]);
      const payload = JSON.parse(send.mock.calls[0]![1]);
      expect(payload).toMatchObject({ title: "Call the dentist", body: "09:00", tag: `remind:${id}:2026-10-30T09:00:00Z`, data: { taskId: id, nodeId: hostId, url: `/?view=notes&node=${hostId}` } });
      expect(Object.keys(payload).sort()).toEqual(["body", "data", "tag", "title"]);

      const again = await drainPushReminders({ at: new Date(NOON.getTime() + 60_000), send });
      expect(again.sent).toBe(0);
      expect(send).toHaveBeenCalledTimes(3);
    });

    it("judges a start time on the workspace clock, and not before it has come", async () => {
      await subscribe(alice, "clock");
      setDayClock({ timeZone: "Asia/Taipei", dayStartHour: 0 });
      await addTask("Stand-up", { time: "17:00" });
      const send = vi.fn<PushSender>().mockResolvedValue();
      // 08:59Z = 16:59 in Taipei; 09:00Z = 17:00.
      expect((await drainPushReminders({ at: new Date("2026-10-30T08:59:00Z"), send })).sent).toBe(0);
      expect((await drainPushReminders({ at: new Date("2026-10-30T09:00:00Z"), send })).sent).toBe(1);
      expect(JSON.parse(send.mock.calls[0]![1]).body).toBe("17:00");
    });

    it("catches up for twelve hours after a stop, not longer", async () => {
      await subscribe(alice, "late");
      await addTask("Old", { remind_at: "2026-10-30T09:00:00Z" });
      const send = vi.fn<PushSender>().mockResolvedValue();
      expect((await drainPushReminders({ at: new Date("2026-10-30T21:01:00Z"), send })).sent).toBe(0);
      expect((await drainPushReminders({ at: new Date("2026-10-30T21:00:00Z"), send })).sent).toBe(1);
    });

    it("does not send for a finished, cancelled or waiting task, a trashed one, or with the module off", async () => {
      await subscribe(alice, "skip");
      const send = vi.fn<PushSender>().mockResolvedValue();
      for (const status of ["done", "cancelled", "waiting"]) await addTask(`s-${status}`, { remind_at: "2026-10-30T09:00:00Z", status });
      const trashed = await addTask("trashed", { remind_at: "2026-10-30T09:00:00Z" });
      await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [trashed]);
      expect((await drainPushReminders({ at: NOON, send })).sent).toBe(0);

      await addTask("open", { remind_at: "2026-10-30T09:00:00Z" });
      await setModulesOn(WS, ["ai"]); // tasks off; ai stays on for the other files sharing this workspace
      expect((await drainPushReminders({ at: NOON, send })).sent).toBe(0);
      await setModulesOn(WS, null);
      expect((await drainPushReminders({ at: NOON, send })).sent).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("tells only people who can read the task", async () => {
      await subscribe(alice, "r-a"); await subscribe(bob, "r-b");
      const space = await makeSpace(WS, `push-${stamp}`, [{ id: alice.id }]);
      const secret = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
         VALUES ($1,'manual','content','Private host','push-private-${stamp}') RETURNING id`, [WS])).rows[0]!.id;
      await putInSpace(secret, space);
      await addTask("Private task", { remind_at: "2026-10-30T09:00:00Z" }, secret);
      const send = vi.fn<PushSender>().mockResolvedValue();
      await drainPushReminders({ at: NOON, send });
      expect(send.mock.calls.map((c) => c[0].endpoint)).toEqual([endpointOf("r-a")]);
    });

    it("deletes a subscription the push service says is gone (404/410), and still reaches the others", async () => {
      await subscribe(alice, "gone"); await subscribe(alice, "live");
      await addTask("Gone", { remind_at: "2026-10-30T09:00:00Z" });
      const send = vi.fn<PushSender>(async (t) => { if (t.endpoint === endpointOf("gone")) throw Object.assign(new Error("gone"), { statusCode: 410 }); });
      const r = await drainPushReminders({ at: NOON, send });
      expect(r).toMatchObject({ sent: 1, removed: 1 });
      const left = await q<{ endpoint: string }>(`SELECT endpoint FROM push_subscriptions WHERE workspace_id = $1`, [WS]);
      expect(left.rows.map((x) => x.endpoint)).toEqual([endpointOf("live")]);
    });

    it("gives the moment back when every device failed in a way that may pass, then sends it", async () => {
      await subscribe(alice, "flaky");
      await addTask("Flaky", { remind_at: "2026-10-30T09:00:00Z" });
      const fail = vi.fn<PushSender>().mockRejectedValue(Object.assign(new Error("busy"), { statusCode: 503 }));
      expect((await drainPushReminders({ at: NOON, send: fail })).sent).toBe(0);
      expect((await q(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [endpointOf("flaky")])).rowCount).toBe(1);
      const ok = vi.fn<PushSender>().mockResolvedValue();
      expect((await drainPushReminders({ at: new Date(NOON.getTime() + 60_000), send: ok })).sent).toBe(1);
    });

    it("pushes a moment once even when two passes race (another process)", async () => {
      await subscribe(alice, "race");
      await addTask("Race", { remind_at: "2026-10-30T09:00:00Z" });
      const send = vi.fn<PushSender>().mockResolvedValue();
      await Promise.all([drainPushReminders({ at: NOON, send }), drainPushReminders({ at: NOON, send })]);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("does not claim a moment nobody can be told, so a device added later still gets it", async () => {
      await addTask("Later device", { remind_at: "2026-10-30T09:00:00Z" });
      const send = vi.fn<PushSender>().mockResolvedValue();
      expect((await drainPushReminders({ at: NOON, send })).sent).toBe(0);
      await subscribe(alice, "late-device");
      expect((await drainPushReminders({ at: new Date(NOON.getTime() + 60_000), send })).sent).toBe(1);
    });

    it("does nothing without keys: no query, no send, nothing scheduled", async () => {
      await subscribe(alice, "nokeys");
      await addTask("No keys", { remind_at: "2026-10-30T09:00:00Z" });
      for (const k of ENV) delete process.env[k];
      const send = vi.fn<PushSender>().mockResolvedValue();
      expect(await drainPushReminders({ at: NOON, send })).toEqual({ due: 0, sent: 0, removed: 0 });
      expect(send).not.toHaveBeenCalled();
      const spy = vi.spyOn(globalThis, "setInterval");
      startPushReminders();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
