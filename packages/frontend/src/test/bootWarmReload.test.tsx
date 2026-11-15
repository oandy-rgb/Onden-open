// Warm reload (2026-10-18): a workspace this device already holds (cached
// copy + a sync cursor) lifts 「正在確認工作區資料…」 after sync's check, without
// first downloading the full /api/bootstrap (every body and drawing — 9.9 MB,
// ~7 s on the production workspace). The full payload follows on idle.
// Could not reach the server → the offline cold start (cache usable, gate
// down). Reached but refused → online and still gated (fail-closed).
// 2026-10-19: the whole bootstrap follows at most daily (the mirror's
// full_refresh_at); in between, a reopen refreshes only ?nodes=none, and a
// large workspace no longer re-downloads the slim one either.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { ApiError } from "../lib/api";
import { getAppState } from "../lib/appStore";
import { loadBootstrapList, getLastFullRefresh, persistBootstrap, missingBodyIds } from "../lib/localDb";
import { SLIM_MODE_NODE_THRESHOLD } from "../lib/slimMode";

const cached = {
  bodies: "full",
  workspace: { id: "ws", name: "T", slug: "default", home_node_id: null },
  nodes: [{ id: "n1", title: "Cached", slug: "cached", markdown: "cached body", node_type: "content", source_type: "manual", parent_id: null, hidden: false, sort_order: 0 }],
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
const emptyDelta = { last_event_id: 7, nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };

beforeEach(() => {
  apiMock.mockReset();
  vi.mocked(getLastFullRefresh).mockResolvedValue(0); // never: the daily refresh is due
  vi.mocked(persistBootstrap).mockClear();
  idleQueue = [];
  (globalThis as Record<string, unknown>).requestIdleCallback = (cb: () => void) => { idleQueue.push(cb); return idleQueue.length; };
});

describe("warm reload", () => {
  it("lifts the gate after sync without waiting for the full bootstrap, which follows on idle", async () => {
    const calls: string[] = [];
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      calls.push(p);
      if (p.startsWith("/api/bootstrap")) return { ...structuredClone(cached), nodes: cached.nodes.map((n) => ({ ...n, markdown: "server body" })) };
      if (p.startsWith("/api/canvases")) return [];
      if (p.startsWith("/api/sync")) return structuredClone(emptyDelta);
      throw new Error("unexpected " + p);
    });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    await waitFor(() => expect(getAppState().membershipGated).toBe(false));
    expect(getAppState().online).toBe(true);
    // The cached copy is what shows; no bootstrap was fetched before the gate came down.
    expect(calls.some((p) => p.startsWith("/api/bootstrap"))).toBe(false);
    expect(result.current.data.nodes[0]!.markdown).toBe("cached body");
    // On idle the full payload refreshes the mirror.
    expect(idleQueue.length).toBeGreaterThan(0);
    for (const cb of idleQueue.splice(0)) cb();
    await waitFor(() => expect(calls.some((p) => p === "/api/bootstrap")).toBe(true));
    await waitFor(() => expect(result.current.data.nodes[0]!.markdown).toBe("server body"));
  });

  it("a server that cannot be reached is the offline cold start: cache usable, gate down", async () => {
    apiMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    await waitFor(() => expect(getAppState().online).toBe(false));
    expect(getAppState().membershipGated).toBe(false);
    expect(result.current.data.nodes[0]!.title).toBe("Cached");
  });

  // D82: during a deploy nginx answers 502/503 for the backend. That is the
  // server not being reached, as a failed fetch is — the warm reload hung on
  // 「正在確認工作區資料…」 because only a non-HTTP failure counted.
  for (const status of [502, 503, 504]) {
    it(`a gateway ${status} (a deploy) is the offline cold start too: cache usable, gate down`, async () => {
      apiMock.mockImplementation(async (path: string) => {
        if (String(path).startsWith("/api/canvases")) return [];
        throw new ApiError(status, "<html><body>Bad Gateway</body></html>");
      });
      const { result } = renderHook(() => useAppData());
      await waitFor(() => expect(result.current.bootstrapped).toBe(true));
      await waitFor(() => expect(getAppState().online).toBe(false));
      expect(getAppState().membershipGated).toBe(false);
      expect(result.current.data.nodes[0]!.title).toBe("Cached");
    });
  }

  it("a big cached workspace and a gateway 502: offline and usable, as before", async () => {
    const big = { ...structuredClone(cached), nodes: Array.from({ length: SLIM_MODE_NODE_THRESHOLD }, (_, i) => ({ ...cached.nodes[0]!, id: `n${i}`, slug: `n${i}` })) };
    vi.mocked(loadBootstrapList).mockResolvedValueOnce(big as never);
    const calls: string[] = [];
    apiMock.mockImplementation(async (path: string) => {
      calls.push(String(path));
      if (String(path).startsWith("/api/canvases")) return [];
      throw new ApiError(502, "<html><body>Bad Gateway</body></html>");
    });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    await waitFor(() => expect(getAppState().online).toBe(false));
    expect(getAppState().membershipGated).toBe(false);
    expect(calls.filter((p) => !p.startsWith("/api/sync/membership/digest"))[0]).toBe("/api/sync"); // sync-first, like a small workspace: no slim re-download
    expect(result.current.data.nodes).toHaveLength(SLIM_MODE_NODE_THRESHOLD);
  });

  const meta = {
    bodies: "full", nodes_omitted: true, workspace: cached.workspace, nodes: [], edges: [], tasks: [], suggestions: [], events: [],
    actor_role: "admin", tags: [], canvas_memberships: [{ canvas_id: "c1", canvas_title: "Board", node_id: "n1" }], graph_positions: [{ nodeId: "n1", x: 1, y: 2 }],
  };

  it("a big workspace refreshed today: gate after sync, then only ?nodes=none, never the slim bootstrap", async () => {
    vi.mocked(getLastFullRefresh).mockResolvedValue(Date.now() - 60_000);
    const big = { ...structuredClone(cached), bodies: "none", nodes: Array.from({ length: SLIM_MODE_NODE_THRESHOLD }, (_, i) => ({ ...cached.nodes[0]!, id: `n${i}`, slug: `n${i}`, markdown: "" })) };
    vi.mocked(loadBootstrapList).mockResolvedValueOnce(big as never);
    const calls: string[] = [];
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path); calls.push(p);
      if (p.startsWith("/api/canvases")) return [];
      if (p === "/api/bootstrap?nodes=none") return structuredClone(meta);
      if (p.startsWith("/api/bootstrap")) throw new Error("whole bootstrap fetched: " + p);
      if (p.startsWith("/api/sync")) return structuredClone(emptyDelta);
      throw new Error("unexpected " + p);
    });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(getAppState().membershipGated).toBe(false));
    expect(getAppState().online).toBe(true);
    for (const cb of idleQueue.splice(0)) cb();
    await waitFor(() => expect(result.current.data.canvas_memberships).toEqual(meta.canvas_memberships));
    expect(result.current.data.graph_positions).toEqual(meta.graph_positions);
    expect(result.current.data.nodes).toHaveLength(SLIM_MODE_NODE_THRESHOLD); // nodes untouched
    expect(result.current.data.bodies).toBe("none"); // still slim
    expect(calls.filter((p) => p.startsWith("/api/bootstrap"))).toEqual(["/api/bootstrap?nodes=none"]);
  });

  it("a small workspace refreshed today: no full bootstrap on reopen, the meta one keeps the cached bodies", async () => {
    vi.mocked(getLastFullRefresh).mockResolvedValue(Date.now() - 60_000);
    const calls: string[] = [];
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path); calls.push(p);
      if (p.startsWith("/api/canvases")) return [];
      if (p === "/api/bootstrap?nodes=none") return structuredClone(meta);
      if (p.startsWith("/api/bootstrap")) throw new Error("whole bootstrap fetched: " + p);
      if (p.startsWith("/api/sync")) return structuredClone(emptyDelta);
      throw new Error("unexpected " + p);
    });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(getAppState().membershipGated).toBe(false));
    for (const cb of idleQueue.splice(0)) cb();
    await waitFor(() => expect(result.current.data.canvas_memberships).toEqual(meta.canvas_memberships));
    expect(result.current.data.nodes[0]!.markdown).toBe("cached body");
    expect(calls.filter((p) => p.startsWith("/api/bootstrap"))).toEqual(["/api/bootstrap?nodes=none"]);
  });

  it("scan-03 M4: a small workspace whose first load only stored titles asks for the missing bodies on reopen", async () => {
    vi.mocked(getLastFullRefresh).mockResolvedValue(Date.now() - 60_000);
    vi.mocked(missingBodyIds).mockResolvedValueOnce({ ids: ["00000000-0000-4000-8000-000000000001"], next: null });
    const calls: string[] = [];
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path); calls.push(p);
      if (p.startsWith("/api/canvases")) return [];
      if (p === "/api/bootstrap?nodes=none") return structuredClone(meta);
      if (p.startsWith("/api/bootstrap")) throw new Error("whole bootstrap fetched: " + p);
      if (p === "/api/sync/bodies") return { bodies: [] };
      if (p.startsWith("/api/sync")) return structuredClone(emptyDelta);
      throw new Error("unexpected " + p);
    });
    renderHook(() => useAppData());
    await waitFor(() => expect(getAppState().membershipGated).toBe(false));
    for (const cb of idleQueue.splice(0)) cb();
    await waitFor(() => expect(calls).toContain("/api/sync/bodies"));
  });

  it("scan-03 M4: with no body missing the reopen check is one local query and no request, and it starts after the sync check", async () => {
    vi.mocked(getLastFullRefresh).mockResolvedValue(Date.now() - 60_000);
    const calls: string[] = [];
    const seenAtQuery: string[][] = [];
    vi.mocked(missingBodyIds).mockClear();
    vi.mocked(missingBodyIds).mockImplementation(async () => { seenAtQuery.push([...calls]); return { ids: [], next: null }; });
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path); calls.push(p);
      if (p.startsWith("/api/canvases")) return [];
      if (p === "/api/bootstrap?nodes=none") return structuredClone(meta);
      if (p.startsWith("/api/bootstrap")) throw new Error("whole bootstrap fetched: " + p);
      if (p.startsWith("/api/sync")) return structuredClone(emptyDelta);
      throw new Error("unexpected " + p);
    });
    renderHook(() => useAppData());
    await waitFor(() => expect(getAppState().membershipGated).toBe(false));
    for (const cb of idleQueue.splice(0)) cb();
    await waitFor(() => expect(missingBodyIds).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(missingBodyIds).toHaveBeenCalledTimes(1);          // one local query
    expect(calls).not.toContain("/api/sync/bodies");           // zero requests for bodies
    expect(seenAtQuery[0]).toContain("/api/sync");             // the membership/sync check had already run
    vi.mocked(missingBodyIds).mockImplementation(async () => ({ ids: [], next: null }));
  });

  it("a server that ignores ?nodes=none (no nodes_omitted): its payload is neither stored nor shown", async () => {
    vi.mocked(getLastFullRefresh).mockResolvedValue(Date.now() - 60_000);
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.startsWith("/api/canvases")) return [];
      if (p.startsWith("/api/bootstrap")) return { ...structuredClone(cached), nodes: [] }; // an older server's capped whole payload
      if (p.startsWith("/api/sync")) return structuredClone(emptyDelta);
      throw new Error("unexpected " + p);
    });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(getAppState().membershipGated).toBe(false));
    for (const cb of idleQueue.splice(0)) cb();
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/api/bootstrap?nodes=none"));
    await new Promise((r) => setTimeout(r, 20));
    expect(persistBootstrap).not.toHaveBeenCalled();
    expect(result.current.data.nodes).toHaveLength(1);
  });

  it("a server that answers with an error keeps the workspace gated (fail-closed)", async () => {
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.startsWith("/api/canvases")) return [];
      if (p.startsWith("/api/sync")) throw new ApiError(500, "boom");
      if (p.startsWith("/api/bootstrap")) return structuredClone(cached);
      throw new Error("unexpected " + p);
    });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    expect(getAppState().membershipGated).toBe(true);
    expect(getAppState().online).toBe(true);
  });

  it("the whole refresh asks for the lean shape and rebuilds each node's attrs from the typed rows", async () => {
    const inits: Array<RequestInit | undefined> = [];
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const p = String(path);
      if (p.startsWith("/api/canvases")) return [];
      if (p === "/api/bootstrap") {
        inits.push(init);
        return { ...structuredClone(cached), attrs_omitted: true, deferred_attribute_keys: ["ink_data"],
          nodes: cached.nodes.map(({ ...n }) => n),
          attributes: [{ node_id: "n1", key: "status", value: "open", value_type: "text", is_inheritable: false, source: "explicit" }] };
      }
      if (p.startsWith("/api/sync")) return structuredClone(emptyDelta);
      throw new Error("unexpected " + p);
    });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(getAppState().membershipGated).toBe(false));
    for (const cb of idleQueue.splice(0)) cb();
    await waitFor(() => expect(result.current.data.nodes[0]!.attrs).toEqual({ status: "open" }));
    expect(new Headers(inits[0]?.headers).get("X-Onden-Bootstrap")).toBe("lean2");
  });
});
