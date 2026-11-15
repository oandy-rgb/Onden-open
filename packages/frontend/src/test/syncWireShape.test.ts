// A server answer that is not the shape this page writes (a proxy's HTML page, a
// half-cut body, another version's payload) must not reach the on-device copy:
// nothing stored, the event cursor where it was, and the failure takes the
// ordinary sync-failure path. Extra fields from a newer server are fine.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mirror = vi.hoisted(() => ({ cursor: 100 }));
vi.mock("../lib/localDb", () => ({
  initLocalDb: vi.fn(async () => null),
  loadBootstrapList: vi.fn(async () => null),
  persistBootstrap: vi.fn(async (data: unknown) => data),
  persistRemoteNode: vi.fn(async (node) => node),
  applySync: vi.fn(async (delta: { last_event_id: number }) => delta),
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

import { persistBootstrap, applySync, setLastEventId } from "../lib/localDb";
import { refresh, sync, refreshMeta } from "../lib/data/syncEngine";

const note = (id: unknown) => ({ id, source_type: "manual", node_type: "content", title: "t", slug: "t", markdown: "", parent_id: null, hidden: false, sort_order: 0 });
const goodBootstrap = (over: Record<string, unknown> = {}) => ({
  workspace: { id: "ws", name: "T", slug: "t", home_node_id: null }, last_event_id: "100",
  nodes: [note("n1")], edges: [], tasks: [], suggestions: [], events: [], tags: [], ...over,
});
const goodDelta = (over: Record<string, unknown> = {}) => ({
  last_event_id: 105, membership_epoch: 0, nodes: { upsert: [note("n1")], delete: [] },
  edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null, ...over,
});

const badBootstraps: Array<[string, unknown]> = [
  ["an HTML page as a string", "<!doctype html><html><body>502</body></html>"],
  ["an empty object", {}],
  ["nodes that is not a list", goodBootstrap({ nodes: "oops" })],
  ["a node without an id", goodBootstrap({ nodes: [{ title: "no id" }] })],
  ["a numeric node id", goodBootstrap({ nodes: [note(7)] })],
  ["a payload cut off before its lists", { workspace: { id: "ws", name: "T" }, last_event_id: "100", nodes: [note("n1")] }],
];
const badDeltas: Array<[string, unknown]> = [
  ["an HTML page as a string", "<!doctype html><html></html>"],
  ["an empty object", {}],
  ["nodes that is not an object with lists", goodDelta({ nodes: [] })],
  ["a node without an id", goodDelta({ nodes: { upsert: [{ title: "x" }], delete: [] } })],
  ["a numeric node id", goodDelta({ nodes: { upsert: [note(7)], delete: [] } })],
  ["a cursor that is not a number", goodDelta({ last_event_id: "soon" })],
  ["a payload cut off after the cursor", { last_event_id: 105 }],
];

beforeEach(() => {
  mirror.cursor = 100;
  apiMock.mockReset();
  vi.mocked(persistBootstrap).mockClear();
  vi.mocked(applySync).mockClear();
  vi.mocked(setLastEventId).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  (globalThis as Record<string, unknown>).requestIdleCallback = (cb: () => void) => setTimeout(cb, 0);
});

describe("a bootstrap answer", () => {
  it.each(badBootstraps)("%s is not stored", async (_name, answer) => {
    apiMock.mockImplementation(async () => answer);
    await refresh();
    expect(persistBootstrap).not.toHaveBeenCalled();
    expect(mirror.cursor).toBe(100);
  });

  it("with fields this page does not know is stored", async () => {
    apiMock.mockImplementation(async () => goodBootstrap({ shiny_new_channel: [1, 2], workspace: { id: "ws", name: "T", slug: "t", home_node_id: null, from_the_future: true } }));
    await refresh();
    expect(persistBootstrap).toHaveBeenCalledTimes(1);
  });

  it("that is a ?nodes=none answer is not stored when its workspace is missing", async () => {
    apiMock.mockImplementation(async () => ({ nodes_omitted: true, suggestions: [] }));
    await expect(refreshMeta()).rejects.toThrow();
    expect(persistBootstrap).not.toHaveBeenCalled();
  });
});

describe("a sync delta answer", () => {
  it.each(badDeltas)("%s is not applied and the cursor stays", async (_name, answer) => {
    apiMock.mockImplementation(async (path: string) => (path === "/api/sync" ? answer : {}));
    const result = await sync();
    expect(result.ok).toBe(false);
    expect(applySync).not.toHaveBeenCalled();
    expect(setLastEventId).not.toHaveBeenCalled();
    expect(mirror.cursor).toBe(100);
  });

  it("with fields this page does not know is applied", async () => {
    let served = false;
    apiMock.mockImplementation(async (path: string) => {
      if (path !== "/api/sync") return {};
      if (served) return goodDelta({ last_event_id: 105, nodes: { upsert: [], delete: [] } });
      served = true;
      return goodDelta({ shiny_new_channel: { upsert: [] }, nodes: { upsert: [{ ...note("n1"), from_the_future: 1 }], delete: [] } });
    });
    await sync();
    expect(applySync).toHaveBeenCalledTimes(1);
  });
});
