// Real PG, actor reload, routes AND the frontend reconciliation algorithm.
// Only the local mirror and request scheduling are controlled here.
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import syncRouter from "../routes/sync.js";
import { mutate } from "../spine/mutate.js";
import { createTaskNode } from "../services/tasksStore.js";
import type { ActorCtx } from "../types.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";

let ws: string, actor: ActorCtx;
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/sync", syncRouter);

type Version = { epoch: number; event_cursor: string };
type Page = Version & { ids: string[]; next_cursor: string | null; retry_required?: boolean };
type Projection = Version & {
  nodes: Array<{ id: string; markdown: string }>;
  tasks: Array<{ id: string; node_id: string }>;
  attributes: { upsert: Array<{ node_id: string; key: string }> };
  edges: Array<{ id: string }>;
  retry_required?: boolean;
};
// Runtime import keeps the backend build independent of frontend DOM types.
const clientModule = new URL("../../../frontend/src/lib/data/membershipReconcile.ts", import.meta.url).href;
const { reconcileMembership } = await import(/* @vite-ignore */ clientModule) as {
  reconcileMembership: (deps: unknown) => Promise<{ status: string; epoch?: number; eventCursor?: string; revoked?: number; granted?: number }>;
};
const digestModule = new URL("../../../frontend/src/lib/data/membershipDigest.ts", import.meta.url).href;
const { webCryptoSha256 } = await import(/* @vite-ignore */ digestModule) as { webCryptoSha256: () => (text: string) => Promise<string> };
async function digest(expectedEpoch?: number) {
  const params = new URLSearchParams();
  if (expectedEpoch !== undefined) params.set("expected_epoch", String(expectedEpoch));
  const res = await app.request(`/api/sync/membership/digest?${params}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}
/** A page as the client asks for it with the digest: scoped to `prefixes`. */
async function scopedPage(cursor: string, expectedEpoch: number, prefixes?: readonly string[]): Promise<Page> {
  const params = new URLSearchParams({ cursor, limit: "2", expected_epoch: String(expectedEpoch) });
  if (prefixes) params.set("prefixes", prefixes.join(","));
  const res = await app.request(`/api/sync/membership?${params}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}
async function page(cursor = "", expectedEpoch?: number, expectedCursor?: string): Promise<Page> {
  const params = new URLSearchParams({ cursor, limit: "2" });
  if (expectedEpoch !== undefined) params.set("expected_epoch", String(expectedEpoch));
  if (expectedCursor !== undefined) params.set("expected_event_cursor", expectedCursor);
  const res = await app.request(`/api/sync/membership?${params}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}
async function hydrate(ids: string[], expected?: Version) {
  return app.request("/api/sync/nodes", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids, expected_epoch: expected?.epoch, expected_event_cursor: expected?.event_cursor }),
  });
}
async function create(prefix: string) {
  const id = `${prefix.repeat(8)}-1111-4111-8111-${randomUUID().slice(-12)}`;
  await mutate({ actor, workspaceId: ws, authority: { kind: "principal_admin" },
    event: { type: "NODE_CREATED", targetType: "node", targetId: id },
    apply: async () => { await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
      VALUES($1::uuid,$2,'manual','content','Page fixture',($1::uuid)::text,'before')`, [id,ws]); },
  });
  return id;
}
async function edit(id: string, remove = false) {
  await mutate({ actor, workspaceId: ws, authority: { kind: "principal_admin" },
    event: { type: remove ? "NODE_DELETED" : "NODE_UPDATED", targetType: "node", targetId: id },
    apply: async () => { await seedQ(remove
      ? "UPDATE content_nodes SET deleted_at=NOW() WHERE id=$1"
      : "UPDATE content_nodes SET markdown='after' WHERE id=$1", [id]); },
  });
}
function localDeps(local: Set<string>, start: Page) {
  return {
    // The client pins only the epoch between pages (membershipReconcile.ts).
    startEpoch: start.epoch, fetchPage: (cursor: string, epoch: number) => page(cursor, epoch),
    getLocalKnown: async () => [...local],
    isolateRevoked: async (ids: string[]) => { for (const id of ids) local.delete(id); },
    fetchProjection: async (ids: string[], epoch: number): Promise<Projection> => {
      const res = await hydrate(ids, { epoch, event_cursor: undefined as unknown as string });
      expect(res.status).toBe(200);
      return res.json();
    },
    applyProjection: async (p: Projection) => { for (const n of [...p.nodes, ...p.tasks]) local.add(n.id); },
    saveEpoch: vi.fn(async () => {}),
  };
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("membership protocol across requests (PG + client)", () => {
  let a: string, c: string, e: string;
  beforeAll(async () => {
    ws = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Membership pages',$1) RETURNING id", [randomUUID()])).rows[0].id;
    actor = (await q<ActorCtx>("INSERT INTO actors(workspace_id,name,type) VALUES($1,'Page reader','human') RETURNING id,name,type", [ws])).rows[0];
  });
  beforeEach(async () => {
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]);
    a = await create("1"); c = await create("3"); e = await create("5");
  });
  afterAll(async () => {
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]);
    await deleteWorkspaceActors(ws);
  });

  it.each(["create", "delete"] as const)("%s at unchanged epoch invalidates later pages", async change => {
    const first = await page();
    expect(first.ids).toEqual([a,c]);
    if (change === "create") await create("2"); else await edit(a, true);
    const next = await page(first.next_cursor!, first.epoch, first.event_cursor);
    expect(next.epoch).toBe(first.epoch);
    expect(next.event_cursor).not.toBe(first.event_cursor);
    expect(next).toMatchObject({ retry_required: true, ids: [], next_cursor: null });
  });

  it("by-id rejects an old content position at the same epoch, then returns fresh content on retry", async () => {
    const first = await page();
    await edit(a);
    const refused = await (await hydrate([a], first)).json();
    expect(refused).toMatchObject({ epoch: first.epoch, retry_required: true, nodes: [], tasks: [], edges: [], attributes: { upsert: [], delete: [] } });
    const fresh = await page();
    expect((await (await hydrate([a], fresh)).json()).nodes[0].markdown).toBe("after");
    expect((await (await hydrate([], first)).json()).retry_required).toBe(true);
  });

  it("by-id rejects stale policy epoch even when the expected event position is current", async () => {
    const current = await page();
    const refused = await (await hydrate([a], { ...current, epoch: current.epoch - 1 })).json();
    expect(refused).toMatchObject({ retry_required: true, nodes: [], epoch: current.epoch, event_cursor: current.event_cursor });
  });

  it("by-id rejects oversized batches instead of claiming partial success", async () => {
    const response = await hydrate(Array.from({ length: 50_001 }, () => a));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_many_ids", limit: 50_000 });
    expect((await (await hydrate([e])).json()).nodes.map((n: { id: string }) => n.id)).toEqual([e]); // legacy request still supported
  });

  it("a new id behind the client's page cursor at the same epoch keeps the local creation, with no restart", async () => {
    const initial = await page(), local = new Set([a,c,e]);
    let reads = 0, created = "";
    const d = localDeps(local, initial);
    const result = await reconcileMembership({ ...d,
      fetchPage: async (cursor: string, epoch: number) => {
        if (++reads === 2) { created = await create("2"); local.add(created); }
        return page(cursor, epoch);
      },
    });
    expect(result).toMatchObject({ status: "done", epoch: initial.epoch });
    expect(local).toEqual(new Set([a,c,e,created]));
    expect(reads).toBeLessThanOrEqual(3);
    expect(d.saveEpoch).toHaveBeenCalledTimes(1);
  });

  it("a node deleted after the client read it, at an unchanged epoch, is left to the event scan", async () => {
    const initial = await page(), local = new Set([a,c,e]);
    let reads = 0;
    const result = await reconcileMembership({ ...localDeps(local, initial),
      fetchPage: async (cursor: string, epoch: number) => {
        if (++reads === 2) await edit(a, true);
        return page(cursor, epoch);
      },
    });
    expect(result).toMatchObject({ status: "done", epoch: initial.epoch });
    expect(local).toEqual(new Set([a,c,e]));
    // The deletion is an event after the first read: sync scans from its position.
    const delta = await (await app.request(`/api/sync?since=${initial.event_cursor}`)).json();
    expect(delta.nodes.delete).toContain(a);
  });

  it("a grant deleted while it was being hydrated is left to the event scan, not lost", async () => {
    const taskId = await createTaskNode({ workspaceId: ws, actor, hostId: c, title: "Hydrated task" });
    // Also verify that the completeness check accepts task rows and that the
    // matching projection carries tasks/edges through this client boundary.
    const edge = (await seedQ<{ id: string }>("INSERT INTO node_edges(workspace_id,source_node_id,target_node_id,edge_type,status) VALUES($1,$2,$3,'related','active') RETURNING id", [ws,c,e])).rows[0].id;
    const initial = await page(), local = new Set<string>();
    const d = localDeps(local, initial);
    let changed = false;
    const result = await reconcileMembership({ ...d,
      applyProjection: async (p: Projection) => {
        if (p.nodes.length || p.tasks.length) {
          expect(p.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: taskId, node_id: c })]));
          // A task node travels as its task row; its attributes are not sent (as the bootstrap and the delta do).
          expect(p.attributes.upsert.some((a) => a.node_id === taskId)).toBe(false);
          expect(p.edges).toEqual(expect.arrayContaining([expect.objectContaining({ id: edge })]));
        }
        await d.applyProjection(p);
        if (!changed && (p.nodes.length || p.tasks.length)) { changed = true; await edit(a, true); }
      },
    });
    expect(result).toMatchObject({ status: "done", epoch: initial.epoch });
    expect(local).toEqual(new Set([a,c,e,taskId]));
    expect(d.saveEpoch).toHaveBeenCalledTimes(1);
    // Membership's read position did not consume the edit: delta still reads it.
    const response = await app.request(`/api/sync?since=${initial.event_cursor}`);
    const delta = await response.json();
    expect(delta.nodes.delete).toContain(a);
    // The result's position is where the first read stood; the deletion came after it.
    expect(BigInt(delta.last_event_id)).toBeGreaterThan(BigInt(result.eventCursor!));
  });

  // The digest first (GET /sync/membership/digest): the client's own hash
  // against the route's, then the scoped pages when they differ.
  it("digest: an unchanged set reconciles with the digest alone, no pages", async () => {
    const initial = await page(), local = new Set([a,c,e]);
    const pages = vi.fn(scopedPage);
    const d = localDeps(local, initial);
    const result = await reconcileMembership({ ...d, fetchPage: pages, fetchDigest: digest, sha256: webCryptoSha256() });
    expect(result).toMatchObject({ status: "done", epoch: initial.epoch, revoked: 0, granted: 0 });
    expect(pages).not.toHaveBeenCalled();
    expect(local).toEqual(new Set([a,c,e]));
    expect(d.saveEpoch).toHaveBeenCalledWith(initial.epoch);
  });

  it("digest: a note no longer readable is removed, paging only its bucket", async () => {
    const initial = await page(), local = new Set([a,c,e]);
    await edit(c, true); // c leaves the readable set
    const pages = vi.fn(scopedPage);
    const result = await reconcileMembership({ ...localDeps(local, initial), fetchPage: pages, fetchDigest: digest, sha256: webCryptoSha256() });
    expect(result).toMatchObject({ status: "done", revoked: 1, granted: 0 });
    expect(local).toEqual(new Set([a,e]));
    expect(pages.mock.calls.length).toBeGreaterThan(0);
    for (const call of pages.mock.calls) expect(call[2]).toEqual([c.slice(0, 2)]);
  });

  it("digest: a stale expectation answers retry_required with no digest", async () => {
    const current = await digest();
    expect(current).toMatchObject({ count: 3 });
    expect(typeof current.digest).toBe("string");
    const stale = await digest(current.epoch + 1);
    expect(stale).toMatchObject({ retry_required: true, epoch: current.epoch });
    expect(stale.digest).toBeUndefined();
  });
});
