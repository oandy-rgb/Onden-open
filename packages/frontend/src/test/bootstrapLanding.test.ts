// A whole bootstrap takes seconds to download on a phone while sync() applies
// newer deltas. Landing it must neither run beside a sync nor leave the mirror
// older than its cursor: the older payload rewinds the cursor (the worker) and
// a sync replays the difference.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mirror = vi.hoisted(() => ({ cursor: 100 }));
vi.mock("../lib/localDb", () => ({
  initLocalDb: vi.fn(async () => null),
  loadBootstrapList: vi.fn(async () => null),
  persistBootstrap: vi.fn(async (data: { last_event_id?: string }) => {
    mirror.cursor = Math.min(mirror.cursor, Number(data.last_event_id)); // the worker's rule
    return data;
  }),
  persistRemoteNode: vi.fn(async (node) => node),
  applySync: vi.fn(async (delta: { last_event_id: number }) => { mirror.cursor = Math.max(mirror.cursor, delta.last_event_id); return delta; }),
  getLastEventId: vi.fn(async () => mirror.cursor),
  setLastEventId: vi.fn(async (id: number) => { mirror.cursor = Math.max(mirror.cursor, Number(id)); }),
  getMembershipEpoch: vi.fn(async () => 0),
  getLastFullRefresh: vi.fn(async () => Date.now()),
  setMembershipEpoch: vi.fn(async () => {}),
  getAllMembershipIds: vi.fn(async () => []),
  getPendingWrites: vi.fn(async () => []),
  catchUpWithOtherTabs: vi.fn(async () => {}),
  clearPendingWrite: vi.fn(async () => {}),
  loadCanvases: vi.fn(async () => []),
  loadCanvas: vi.fn(async () => null),
}));
vi.mock("../lib/data/syncStatus", () => ({ refreshPendingCount: vi.fn(), bumpPending: vi.fn() }));
const apiMock = vi.fn();
vi.mock("../lib/api", async (orig) => ({ ...await orig<typeof import("../lib/api")>(), api: (...a: unknown[]) => apiMock(...a) }));

import { persistBootstrap, applySync } from "../lib/localDb";
import { refresh, sync } from "../lib/data/syncEngine";

const note = (id: string, title: string) => ({ id, source_type: "manual", node_type: "content", title, slug: id, markdown: "", parent_id: null, hidden: false, sort_order: 0 });
const bootstrapAt = (cursor: string) => ({
  workspace: { id: "ws", name: "T", slug: "t", home_node_id: null }, actor_role: "editor", last_event_id: cursor,
  nodes: [note("n1", "old")], edges: [], tasks: [], suggestions: [], events: [], tags: [],
});
const deltaTo = (id: number) => ({
  last_event_id: id, membership_epoch: 0, nodes: { upsert: id > 100 ? [note("n1", "NEW")] : [], delete: [] },
  edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const syncSinces = () => apiMock.mock.calls.filter(([path]) => path === "/api/sync").map(([, init]) => JSON.parse((init as { body: string }).body).since);

beforeEach(() => {
  mirror.cursor = 100;
  apiMock.mockReset();
  vi.mocked(persistBootstrap).mockClear();
  vi.mocked(applySync).mockClear();
  (globalThis as Record<string, unknown>).requestIdleCallback = (cb: () => void) => setTimeout(cb, 0);
});

describe("landing a downloaded bootstrap", () => {
  it("a slow download that lands after newer deltas rewinds the cursor and a sync replays them", async () => {
    const download = deferred<unknown>();
    apiMock.mockImplementation(async (path: string, init?: { body?: string }) => {
      if (path === "/api/bootstrap") return download.promise;
      if (path === "/api/sync") {
        const since = JSON.parse(init!.body!).since;
        return deltaTo(since >= 105 ? since : 105);
      }
      return {};
    });
    const refreshing = refresh(); // fetch started at event 100
    await sync(); // meanwhile the deltas arrive: the mirror is at 105
    expect(mirror.cursor).toBe(105);
    download.resolve(bootstrapAt("100"));
    await refreshing;
    await vi.waitFor(() => expect(syncSinces().filter((since) => since === 100)).toHaveLength(2)); // the replay starts at the bootstrap's own position
    await vi.waitFor(() => expect(mirror.cursor).toBe(105));
  });

  it("does not land beside a sync that is applying deltas, and a sync waits for a landing", async () => {
    const delta = deferred<unknown>();
    const download = deferred<unknown>();
    const order: string[] = [];
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/bootstrap") return download.promise;
      if (path === "/api/sync") return delta.promise;
      return {};
    });
    vi.mocked(persistBootstrap).mockImplementationOnce(async (data) => { order.push("landed"); return data; });
    const syncing = sync();
    await vi.waitFor(() => expect(syncSinces()).toHaveLength(1));
    const refreshing = refresh();
    download.resolve(bootstrapAt("100"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(persistBootstrap).not.toHaveBeenCalled(); // waits for the sync in flight
    delta.resolve(deltaTo(100));
    await syncing;
    order.push("sync done");
    await refreshing;
    expect(order).toEqual(["sync done", "landed"]);
  });
});
