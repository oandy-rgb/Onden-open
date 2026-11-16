// Which device a write came from (X-Onden-Device-Id) is recorded on the event it appends, and goes nowhere else.
// Through the real assembled app (app.ts), so the header middleware is part of what is tested.
// SAFETY: only runs against a *_test database; skips otherwise.

import { CLIENT_PROTOCOL } from "@onden/markdown";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DEVICE_ID_HEADER } from "@onden/markdown";
import { q, event } from "../db.js";
import { app } from "../app.js";
import { withRequestDevice } from "../requestContext.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const session = vi.hoisted(() => ({ workspaceId: "", user: null as null | { id: string; email: string; name: string } }));
vi.mock("../db.js", async (original) => ({
  ...await original<typeof import("../db.js")>(),
  getWorkspaceId: async () => session.workspaceId,
}));
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => (session.user ? { user: session.user } : null)) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

async function call(method: string, path: string, body?: unknown, device?: string) {
  const res = await app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-onden-expected-user": session.user!.id,
      "x-onden-client-protocol": String(CLIENT_PROTOCOL),
      "idempotency-key": randomUUID(),
      ...(device !== undefined ? { [DEVICE_ID_HEADER]: device } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text };
}

const deviceOf = async (noteId: string) =>
  (await q<{ device_id: string | null }>(
    `SELECT device_id::text AS device_id FROM domain_events WHERE target_id = $1 ORDER BY id`, [noteId],
  )).rows.map((r) => r.device_id);

describe.skipIf(!isTestDb)("device id on writes (DB)", () => {
  beforeAll(async () => {
    session.workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('device id', $1) RETURNING id::text`, [`device-${randomUUID()}`])).rows[0]!.id;
    session.user = { id: `user-${randomUUID()}`, email: `owner-${randomUUID()}@example.test`, name: "Owner" };
    await call("GET", "/api/me");
  });

  it("records the sending device on the event of a write", async () => {
    const device = randomUUID();
    const id = randomUUID();
    expect((await call("POST", "/api/nodes", { id, title: "A", markdown: "" }, device)).status).toBeLessThan(300);
    expect(await deviceOf(id)).toEqual([device]);
  });

  it("records no device, and still succeeds, when the header is missing or malformed", async () => {
    for (const header of [undefined, "", "not-a-uuid", "12345678-1234-1234-1234-12345678901"]) {
      const id = randomUUID();
      expect((await call("POST", "/api/nodes", { id, title: "B", markdown: "" }, header)).status).toBeLessThan(300);
      expect(await deviceOf(id)).toEqual([null]);
    }
  });

  it("keeps two devices' writes apart", async () => {
    const [one, two] = [randomUUID(), randomUUID()];
    const id = randomUUID();
    await call("POST", "/api/nodes", { id, title: "C", markdown: "" }, one);
    await call("PATCH", `/api/nodes/${id}`, { title: "C2" }, two);
    expect(await deviceOf(id)).toEqual([one, two]);
  });

  it("gives the events a write cascades into the device of the write that started it", async () => {
    const device = randomUUID();
    const parent = randomUUID();
    const child = randomUUID();
    await call("POST", "/api/nodes", { id: parent, title: "P", markdown: "" }, randomUUID());
    await call("POST", "/api/nodes", { id: child, title: "Kid", markdown: "", parent_id: parent }, randomUUID());
    const before = Number((await q<{ m: string }>(`SELECT COALESCE(max(id), 0)::text AS m FROM domain_events`)).rows[0]!.m);
    expect((await call("DELETE", `/api/nodes/${parent}`, undefined, device)).status).toBeLessThan(300);
    const rows = (await q<{ device_id: string | null; triggered_by_event_id: string | null }>(
      `SELECT device_id::text AS device_id, triggered_by_event_id::text AS triggered_by_event_id
         FROM domain_events WHERE workspace_id = $1 AND id > $2`, [session.workspaceId, before])).rows;
    expect(rows.some((r) => r.triggered_by_event_id !== null)).toBe(true); // the cascade really produced events
    expect(rows.every((r) => r.device_id === device)).toBe(true);
  });

  it("records no device for a system event, even inside a request", async () => {
    const ws = session.workspaceId;
    const id = await withRequestDevice(randomUUID(), () => event(ws, "SYSTEM_TICK", "node", randomUUID(), {}, "system", "system"));
    const row = (await q<{ device_id: string | null }>(`SELECT device_id::text AS device_id FROM domain_events WHERE id = $1`, [id])).rows[0]!;
    expect(row.device_id).toBeNull();
  });

  it("never shows the device in what the API returns", async () => {
    const device = randomUUID();
    const id = randomUUID();
    await call("POST", "/api/nodes", { id, title: "D", markdown: "x" }, device);
    for (const path of [`/api/nodes/${id}`, "/api/history/activity", "/api/history/feed", "/api/events", "/api/sync?since=0", `/api/nodes/${id}/history`, `/api/nodes/${id}/versions`]) {
      const res = await call("GET", path);
      expect(res.status, path).toBe(200);
      expect(res.text).not.toContain(device);
      expect(res.text).not.toContain("device_id");
    }
  });
});
