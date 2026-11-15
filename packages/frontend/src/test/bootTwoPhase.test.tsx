// Warm boot step 3 (perf F4): the cached list paints from loadBootstrapList
// alone; the edges, tasks and attrs are read when idle, in separate requests,
// and merged. An offline warm boot gets them too. A whole server bootstrap that
// lands first makes the cached rest stale, so it is not merged.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { getAppState, resetAppState } from "../lib/appStore";
import { loadBootstrapRelations, loadAttributePage, getLastFullRefresh } from "../lib/localDb";
import { hydrateFullBootstrap } from "../lib/data/syncEngine";

const cachedNodes = [
  { id: "n1", title: "Cached", slug: "cached", markdown: "", node_type: "content", source_type: "manual", parent_id: null, hidden: false, sort_order: 0 },
  { id: "n2", title: "Other", slug: "other", markdown: "", node_type: "content", source_type: "manual", parent_id: null, hidden: false, sort_order: 1 },
];
const cached = {
  bodies: "full",
  workspace: { id: "ws", name: "T", slug: "default", home_node_id: null },
  nodes: cachedNodes,
  edges: [], tasks: [], suggestions: [], events: [], actor_role: "admin", tags: [],
};

vi.mock("../lib/localDb", () => ({
  initLocalDb: vi.fn(async () => null),
  loadBootstrapList: vi.fn(async () => structuredClone(cached)),
  loadBootstrapRelations: vi.fn(async () => ({ edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] })),
  loadAttributePage: vi.fn(async () => ({ rows: [], next: null })),
  persistBootstrap: vi.fn(async (data) => data),
  persistRemoteNode: vi.fn(async (node) => node),
  applySync: vi.fn(async (delta) => delta),
  getLastEventId: vi.fn(async () => 7),
  setLastEventId: vi.fn(async () => {}),
  getMembershipEpoch: vi.fn(async () => 0),
  getLastFullRefresh: vi.fn(async () => 0),
  setMembershipEpoch: vi.fn(async () => {}),
  getAllMembershipIds: vi.fn(async () => []),
  getPendingWrites: vi.fn(async () => []),
  clearPendingWrite: vi.fn(async () => {}),
  exportDatabase: vi.fn(),
  importDatabase: vi.fn(),
  installUnloadFlush: vi.fn(() => () => {}),
  flushLocalDbSync: vi.fn(async () => {}),
  loadCanvases: vi.fn(async () => []),
  upsertCanvas: vi.fn(async () => {}),
  removeCanvas: vi.fn(async () => {}),
  loadCanvas: vi.fn(async () => null),
  missingBodyIds: vi.fn(async () => ({ ids: [], next: null })),
}));
vi.mock("../lib/fileSystemStorage", () => ({
  getStoragePref: () => "opfs",
  getStoredDirHandle: vi.fn(async () => null),
  requestDirPermission: vi.fn(async () => false),
  readDbFromDir: vi.fn(async () => null),
  writeDbToDir: vi.fn(async () => {}),
}));
vi.mock("../lib/data/syncStatus", () => ({ refreshPendingCount: vi.fn(), bumpPending: vi.fn() }));

const apiMock = vi.fn();
vi.mock("../lib/api", async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: (...a: unknown[]) => apiMock(...a) };
});

import { useAppData } from "../lib/useAppData";


let idleQueue: Array<() => void> = [];
const flushIdle = () => { for (const cb of idleQueue.splice(0)) cb(); };
const emptyDelta = { last_event_id: 7, nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
const edge = { id: "e1", source_node_id: "n1", target_node_id: "n2", edge_type: "link", status: "active" };

beforeEach(() => {
  resetAppState();
  apiMock.mockReset();
  vi.mocked(getLastFullRefresh).mockResolvedValue(Date.now()); // the daily refresh is not due
  vi.mocked(loadBootstrapRelations).mockReset().mockResolvedValue({ edges: [edge], pointers: [], tasks: [], suggestions: [], graph_positions: [] } as never);
  vi.mocked(loadAttributePage).mockReset().mockResolvedValue({ rows: [{ node_id: "n1", key: "status", value: "open" }], next: null });
  idleQueue = [];
  (globalThis as Record<string, unknown>).requestIdleCallback = (cb: () => void) => { idleQueue.push(cb); return idleQueue.length; };
  apiMock.mockImplementation(async (path: string) => {
    const p = String(path);
    if (p.startsWith("/api/canvases")) return [];
    if (p.startsWith("/api/sync")) return structuredClone(emptyDelta);
    if (p.startsWith("/api/bootstrap")) return { ...structuredClone(cached), attrs_omitted: undefined };
    throw new Error("unexpected " + p);
  });
});

describe("warm boot, two phases", () => {
  it("paints the list without reading the rest, then merges it when idle", async () => {
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    await waitFor(() => expect(getAppState().membershipGated).toBe(false));
    expect(result.current.data.nodes.map((n) => n.title)).toEqual(["Cached", "Other"]);
    expect(loadBootstrapRelations).not.toHaveBeenCalled();
    expect(loadAttributePage).not.toHaveBeenCalled();
    expect(result.current.data.edges).toEqual([]);
    flushIdle();
    await waitFor(() => expect(getAppState().data.edges).toHaveLength(1));
    await waitFor(() => expect(getAppState().data.nodes[0]!.attrs).toEqual({ status: "open" }));
  });

  it("reads the attributes page by page, each page its own request", async () => {
    vi.mocked(loadAttributePage)
      .mockResolvedValueOnce({ rows: [{ node_id: "n1", key: "a", value: "1" }], next: 11 })
      .mockResolvedValueOnce({ rows: [{ node_id: "n2", key: "b", value: "2" }], next: null });
    renderHook(() => useAppData());
    await waitFor(() => expect(idleQueue.length).toBeGreaterThan(0));
    flushIdle();
    await waitFor(() => expect(getAppState().data.nodes[1]!.attrs).toEqual({ b: "2" }));
    expect(vi.mocked(loadAttributePage).mock.calls.map(([after]) => after)).toEqual([0, 11]);
    expect(getAppState().data.nodes[0]!.attrs).toEqual({ a: "1" });
  });

  it("offline warm boot gets the rest too", async () => {
    apiMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    renderHook(() => useAppData());
    await waitFor(() => expect(getAppState().online).toBe(false));
    await waitFor(() => expect(idleQueue.length).toBeGreaterThan(0));
    flushIdle();
    await waitFor(() => expect(getAppState().data.edges).toHaveLength(1));
    expect(getAppState().data.nodes[0]!.attrs).toEqual({ status: "open" });
  });

  it("a whole server bootstrap that lands first is not overwritten by the older cached rest", async () => {
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    await waitFor(() => expect(getAppState().membershipGated).toBe(false));
    // The server says: no edges, status already changed.
    apiMock.mockImplementation(async (p: string) => String(p).startsWith("/api/bootstrap")
      ? { ...structuredClone(cached), nodes: cachedNodes.map((n) => ({ ...n, attrs: { status: "done" } })), edges: [] } : []);
    await hydrateFullBootstrap();
    flushIdle();
    await new Promise((r) => setTimeout(r, 20));
    expect(loadBootstrapRelations).not.toHaveBeenCalled();
    expect(getAppState().data.edges).toEqual([]);
    expect(getAppState().data.nodes[0]!.attrs).toEqual({ status: "done" });
  });

  it("a text edit made before the rest arrived is kept", async () => {
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    const { setData } = await import("../lib/appStore");
    setData((prev) => ({ ...prev, nodes: prev.nodes.map((n) => n.id === "n1" ? { ...n, title: "Retitled", attrs: { status: "mine" } } : n) }));
    flushIdle();
    await waitFor(() => expect(getAppState().data.edges).toHaveLength(1));
    expect(getAppState().data.nodes[0]).toMatchObject({ title: "Retitled", attrs: { status: "mine" } });
  });
});
