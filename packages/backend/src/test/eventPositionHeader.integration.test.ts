// A write's event position on its response (EVENT_POSITION_HEADER, spine/eventPosition.ts + eventPositionHeader.ts):
// the id of the last domain_events row the write committed, after commit only; none on a refusal, a write with no
// event, a rolled-back write or an idempotent replay; and the sync answer that reads the write has a head at or above it
// and says which server's log it counts in (server_id).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { EVENT_POSITION_HEADER, READ_HEAD_HEADER, READ_SERVER_HEADER } from "@onden/markdown/contract";
import { q, getWorkspaceId, event, withTransaction } from "../db.js";
import { collectEventPosition } from "../spine/eventPosition.js";
import { serverIdentityField } from "../spine/stamps.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

async function req(path: string, init: { method?: string; json?: unknown; idem?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: "http://localhost" };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  if (init.idem) headers["Idempotency-Key"] = init.idem;
  return app.request(path, { method: init.method ?? "GET", headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined });
}
const lastEventOf = async (targetId: string) =>
  (await q<{ id: string }>(`SELECT max(id)::text AS id FROM domain_events WHERE target_id = $1`, [targetId])).rows[0]!.id;
const head = async () =>
  (await q<{ id: string }>(`SELECT COALESCE(max(id), 0)::text AS id FROM domain_events WHERE workspace_id = $1`, [await getWorkspaceId()])).rows[0]!.id;

describe.skipIf(!isTestDb)("a write's event position", () => {
  let nodeId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const workspaceId = await getWorkspaceId();
    const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
    const created = await req("/api/nodes", { method: "POST", json: { title: `position ${Date.now()}`, markdown: "x", space_id: space } });
    expect(created.status).toBeLessThan(300);
    nodeId = ((await created.json()) as { id: string }).id;
    expect(created.headers.get(EVENT_POSITION_HEADER)).toBe(await lastEventOf(nodeId));
  });

  it("is the last event the write committed, and the sync answer that reads it has a head at or above it", async () => {
    const res = await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: `renamed ${Date.now()}` } });
    expect(res.status).toBeLessThan(300);
    const position = res.headers.get(EVENT_POSITION_HEADER);
    expect(position).toBe(await lastEventOf(nodeId));
    expect(position).toBe(await head());
    const answer = (await (await req("/api/sync", { method: "POST", json: { since: Number(position) - 1 } })).json()) as { head_event_id: string; server_id?: string };
    expect(BigInt(answer.head_event_id) >= BigInt(position!)).toBe(true);
    const node = (await q<{ node_id: string }>(`SELECT node_id FROM sync_node WHERE singleton`)).rows[0]!.node_id;
    // Derived from the node id, never the id itself (node ids appear in no answer: syncStamps.integration).
    expect(answer.server_id).toBe((await serverIdentityField()).server_id);
    expect(answer.server_id).not.toBe(node);
    const boot = (await (await req("/api/bootstrap")).json()) as { server_id?: string };
    expect(boot.server_id).toBe(answer.server_id);
  });

  it("is exposed to a page on another origin (CORS)", async () => {
    const res = await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: `cors ${Date.now()}` } });
    expect(res.headers.get("access-control-expose-headers") ?? "").toContain(EVENT_POSITION_HEADER);
  });

  it("is absent on a refusal and on a write that commits no event", async () => {
    const missing = await req(`/api/nodes/${crypto.randomUUID()}`, { method: "PATCH", json: { title: "nobody" } });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.headers.get(EVENT_POSITION_HEADER)).toBeNull();
    const bad = await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: 42 } });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.headers.get(EVENT_POSITION_HEADER)).toBeNull();
    // Removing a property that is not there writes nothing (it only spends the key).
    const before = await head();
    const noop = await req(`/api/nodes/${nodeId}/attributes/never-set-${Date.now()}`, { method: "DELETE", idem: crypto.randomUUID() });
    expect(noop.status).toBeLessThan(300);
    expect(await head()).toBe(before);
    expect(noop.headers.get(EVENT_POSITION_HEADER)).toBeNull();
    // A read never carries one.
    expect((await req(`/api/nodes/${nodeId}`)).headers.get(EVENT_POSITION_HEADER)).toBeNull();
  });

  it("leaves no position for a write that rolled back", async () => {
    const workspaceId = await getWorkspaceId();
    const { position } = await collectEventPosition(async () => {
      await withTransaction(async () => {
        await event(workspaceId, "NODE_UPDATED", "node", nodeId, {}, "system", "test");
        throw new Error("rolled back");
      }).catch(() => undefined);
    });
    expect(position).toBeNull();
    const committed = await collectEventPosition(() => event(workspaceId, "NODE_UPDATED", "node", nodeId, {}, "system", "test"));
    expect(committed.position).toBe(committed.result);
  });

  // The replay of a key already used answers {deduped:true} with the ORIGINAL position (kept with the key, migration 212):
  // after the server has moved on it is still the first write's, never the current head.
  it("a replay after the server moved on carries the original position, not the current head", async () => {
    const key = crypto.randomUUID();
    const first = await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: `once ${Date.now()}` }, idem: key });
    const original = first.headers.get(EVENT_POSITION_HEADER);
    expect(original).not.toBeNull();
    await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: `moved on ${Date.now()}` } });
    expect(BigInt(await head()) > BigInt(original!)).toBe(true);
    const replay = await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: "again" }, idem: key });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { deduped?: boolean }).deduped).toBe(true);
    expect(replay.headers.get(EVENT_POSITION_HEADER)).toBe(original);
    // A key whose write committed no event replays with none.
    const noopKey = crypto.randomUUID();
    await req(`/api/nodes/${nodeId}/attributes/never-${Date.now()}`, { method: "DELETE", idem: noopKey });
    const noopReplay = await req(`/api/nodes/${nodeId}/attributes/never-again`, { method: "DELETE", idem: noopKey });
    expect(noopReplay.status).toBe(200);
    expect(noopReplay.headers.get(EVENT_POSITION_HEADER)).toBeNull();
  });

  // Two sends of the same key at once (a retry fired while the first was still in flight): one write, and both answers
  // carry that write's position — the second one either waits on the first's claim (IdempotentReplay) or finds it
  // committed (the early replay in app.ts), whichever the timing gives.
  it("two requests with the same key at once: one write, the same position on both answers", async () => {
    const key = crypto.randomUUID();
    const before = await head();
    const [a, b] = await Promise.all([
      req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: `race ${Date.now()}` }, idem: key }),
      req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: `race other ${Date.now()}` }, idem: key }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const written = await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE target_id = $1 AND id > $2`, [nodeId, before]);
    expect(written.rows[0]!.n).toBe("1");
    expect(a.headers.get(EVENT_POSITION_HEADER)).toBe(await head());
    expect(b.headers.get(EVENT_POSITION_HEADER)).toBe(a.headers.get(EVENT_POSITION_HEADER));
  });

  it("answers that say where they were read are never kept by a cache (an old copy replayed would read as the server going back)", async () => {
    for (const res of [
      await req(`/api/nodes/${nodeId}`),
      await req("/api/sync", { method: "POST", json: { since: 0 } }),
      await req("/api/bootstrap?nodes=none"),
      await req("/api/sync/membership/digest?expected_epoch=0"),
    ]) expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // A single note read says where it was read: the head read before the row (services/sync/delta.ts workspaceHead).
  it("a single note read carries the head it was read at", async () => {
    await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: `read ${Date.now()}` } });
    const res = await req(`/api/nodes/${nodeId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get(READ_HEAD_HEADER)).toBe(await head());
    expect(res.headers.get("access-control-expose-headers") ?? "").toContain(READ_HEAD_HEADER);
    // And whose log it counts in: the same derived identity as the sync answers (a read just after an identity change is
    // then not judged against the old log's positions).
    expect(res.headers.get(READ_SERVER_HEADER)).toBe((await serverIdentityField()).server_id);
    expect(res.headers.get("access-control-expose-headers") ?? "").toContain(READ_SERVER_HEADER);
  });
});
