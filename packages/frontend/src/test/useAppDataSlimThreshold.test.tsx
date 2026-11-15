// ⑤ scale: past SLIM_MODE_NODE_THRESHOLD nodes the boot STAYS slim — the full
// /api/bootstrap (which pulls every body into the heap) is SKIPPED, so the LRU
// keeps evicting and the session never goes bodies==='full'. Below the
// threshold the full fetch lands as before (no behaviour change).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("../lib/localDb", () => ({
  initLocalDb: vi.fn(async () => null),
  loadBootstrapList: vi.fn(async () => null),
  loadBootstrapRelations: vi.fn(async () => ({ edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] })),
  loadAttributePage: vi.fn(async () => ({ rows: [], next: null })),
  persistBootstrap: vi.fn(async (data) => data),
  persistRemoteNode: vi.fn(async (node) => node),
  applySync: vi.fn(async (delta) => delta),
  getLastEventId: vi.fn(async () => 0),
  getMembershipEpoch: vi.fn(async () => 0),
  setLastEventId: vi.fn(async () => {}),
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
import { SLIM_MODE_NODE_THRESHOLD } from "../lib/slimMode";
import { loadBootstrapList } from "../lib/localDb";
import { getAppState, resetAppState } from "../lib/appStore";

const slimNode = (i: number) => ({
  id: `n${i}`, title: `Note ${i}`, slug: `n-${i}`, markdown: "",
  body_len: 50, node_type: "content", source_type: "manual",
  parent_id: null, hidden: false, sort_order: i,
});
function slimBoot(n: number) {
  return {
    bodies: "none",
    workspace: { id: "ws", name: "T", slug: "default", home_node_id: null },
    nodes: Array.from({ length: n }, (_, i) => slimNode(i)),
    edges: [], tasks: [], suggestions: [], events: [], actor_role: "admin",
    tags: [],
  };
}

// Track every distinct bootstrap path the hook hit.
function harness(nodeCount: number) {
  const paths: string[] = [];
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    const p = String(path);
    paths.push(p);
    if (p.startsWith("/api/bootstrap?bodies=none")) return structuredClone(slimBoot(nodeCount));
    if (p.startsWith("/api/bootstrap")) {
      return { ...structuredClone(slimBoot(nodeCount)), bodies: "full", nodes: slimBoot(nodeCount).nodes.map((nd) => ({ ...nd, markdown: `full ${nd.id}` })) };
    }
    if (p.startsWith("/api/canvases")) return [];
    if (p.startsWith("/api/sync")) return { last_event_id: 0, nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
    throw new Error("unexpected " + p);
  });
  return paths;
}

describe("slim-mode node threshold (⑤)", () => {
  beforeEach(() => { apiMock.mockReset(); resetAppState(); });

  it("big workspace stays slim: full /api/bootstrap is NEVER fetched, bodies stays 'none'", async () => {
    const paths = harness(SLIM_MODE_NODE_THRESHOLD);
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    // The boot's last step is the first sync (the canvas list is the nodes, D75).
    await waitFor(() => expect(paths.some((p) => p.startsWith("/api/sync"))).toBe(true));

    expect(result.current.data.bodies).toBe("none");
    expect(paths.some((p) => p.startsWith("/api/bootstrap?bodies=none"))).toBe(true);
    // The full-body bootstrap (no query string) must not have run.
    expect(paths.some((p) => p === "/api/bootstrap" || /^\/api\/bootstrap$/.test(p))).toBe(false);
  }, 30_000);

  it("small workspace below the threshold still lands the full bootstrap", async () => {
    const paths = harness(SLIM_MODE_NODE_THRESHOLD - 1);
    const { result } = renderHook(() => useAppData());
    // The store starts out "full" before any boot, so wait for the full
    // fetch itself rather than for the bodies flag alone.
    await waitFor(() => expect(paths.some((p) => p === "/api/bootstrap")).toBe(true));
    await waitFor(() => expect(result.current.data.nodes[0]?.markdown).toBe("full n0"));
    expect(result.current.data.bodies).toBe("full");
  }, 30_000);

  // GAP-20: a cached big workspace started without a connection is an offline
  // cold start — stay offline with the cache painted and the gate lowered, not
  // a "live" slim session stuck on "Checking your workspace…".
  it("a cached big workspace that cannot reach the server starts offline and usable", async () => {
    const cached = { ...slimBoot(SLIM_MODE_NODE_THRESHOLD), nodes: slimBoot(SLIM_MODE_NODE_THRESHOLD).nodes.map((n) => ({ ...n, markdown: "cached" })) };
    vi.mocked(loadBootstrapList).mockResolvedValueOnce(cached as never);
    apiMock.mockReset().mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    await waitFor(() => expect(getAppState().membershipGated).toBe(false));
    expect(result.current.online).toBe(false);
    expect(result.current.data.nodes).toHaveLength(SLIM_MODE_NODE_THRESHOLD);
  }, 30_000);
});
