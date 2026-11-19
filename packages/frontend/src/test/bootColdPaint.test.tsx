// Cold boot step 2 (perf F2): the list paints from the downloaded payload
// before the worker has written the mirror. The queue is read once on the main
// thread and its note text applied, so a pending edit is never shown reverted.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("../lib/localDb", () => ({
  getWatermark: async () => ({ position: null, server: null }), raiseWatermark: async () => {}, rewindCursor: async () => {}, forgetCopyWatermark: async () => ({ alreadyOwed: false }),
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

import { getAppState, resetAppState } from "../lib/appStore";
import { persistBootstrap, getPendingWrites } from "../lib/localDb";
import { useAppData } from "../lib/useAppData";
import { forgetWatermark } from "../lib/data/writePositions";


const slim = {
  bodies: "none",
  last_event_id: "5",
  workspace: { id: "ws", name: "T", slug: "default", home_node_id: null },
  nodes: [
    { id: "n1", title: "Server title", slug: "n-1", markdown: "", body_len: 50, node_type: "content", source_type: "manual", parent_id: null, hidden: false, order_key: "a0" },
    { id: "n2", title: "Other", slug: "n-2", markdown: "", body_len: 5, node_type: "content", source_type: "manual", parent_id: null, hidden: false, order_key: "a1" },
  ],
  edges: [], tasks: [], suggestions: [], events: [], actor_role: "admin", tags: [],
};
const pendingEdit = { id: 1, method: "PATCH", path: "/api/nodes/n1", body: JSON.stringify({ title: "Typed offline", markdown: "my unsent text" }), idem_key: "k1", attempts: 0 };

beforeEach(() => {
  resetAppState();
  forgetWatermark(); // the page's watermark outlives a test: a later test reads at an older position
  apiMock.mockReset();
  vi.mocked(persistBootstrap).mockReset();
  vi.mocked(getPendingWrites).mockReset();
  (globalThis as Record<string, unknown>).requestIdleCallback = () => 1;
  apiMock.mockImplementation(async (path: string) => {
    const p = String(path);
    if (p.startsWith("/api/bootstrap")) return structuredClone(slim);
    if (p.startsWith("/api/canvases")) return [];
    if (p.startsWith("/api/sync")) return { last_event_id: 5, nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
    throw new Error("unexpected " + p);
  });
});

describe("cold boot paints before the mirror is written", () => {
  it("shows the list while persistBootstrap is still running, with the pending edit applied", async () => {
    vi.mocked(getPendingWrites).mockResolvedValue([pendingEdit]);
    let finishPersist!: (b: unknown) => void;
    vi.mocked(persistBootstrap).mockImplementation(() => new Promise((resolve) => { finishPersist = resolve as (b: unknown) => void; }));
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    // The worker has not answered: this is the main-thread projection.
    expect(finishPersist).toBeTypeOf("function");
    const shown = getAppState().data.nodes;
    expect(shown.map(n => n.title)).toEqual(["Typed offline", "Other"]);
    expect(shown[0]!.markdown).toBe("my unsent text");
    // The worker answers with the same projection: still the pending text.
    finishPersist({ ...structuredClone(slim), nodes: [{ ...slim.nodes[0]!, title: "Typed offline", markdown: "my unsent text", body_len: 14 }, slim.nodes[1]] });
    await waitFor(() => expect(getAppState().online).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(getAppState().data.nodes[0]).toMatchObject({ title: "Typed offline", markdown: "my unsent text" });
  });

  it("never shows the server's older text for a pending edit, at any point of the boot", async () => {
    vi.mocked(getPendingWrites).mockResolvedValue([pendingEdit]);
    vi.mocked(persistBootstrap).mockImplementation(async (data) => ({ ...data, nodes: data.nodes.map(n => n.id === "n1" ? { ...n, title: "Typed offline", markdown: "my unsent text", body_len: 14 } : n) }));
    const seen: string[] = [];
    const { result } = renderHook(() => { const r = useAppData(); seen.push(...r.data.nodes.filter(n => n.id === "n1").map(n => n.title)); return r; });
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain("Server title");
  });

  it("an empty queue paints the payload as downloaded", async () => {
    vi.mocked(getPendingWrites).mockResolvedValue([]);
    vi.mocked(persistBootstrap).mockImplementation(async (data) => data);
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    expect(result.current.data.nodes.map(n => n.title)).toEqual(["Server title", "Other"]);
  });

  it("a mirror write that fails after the paint keeps the painted list (the full fetch that follows replaces it)", async () => {
    vi.mocked(getPendingWrites).mockResolvedValue([]);
    vi.mocked(persistBootstrap).mockImplementationOnce(async () => { throw new Error("disk full"); });
    vi.mocked(persistBootstrap).mockImplementation(async (data) => data);
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.data.nodes.length).toBeGreaterThan(0);
  });
  it("a save acknowledged while the copy stores the boot download: downloaded again, the device stays online", async () => {
    vi.mocked(getPendingWrites).mockResolvedValue([]);
    // The copy was told of an acknowledgement at 7 while it stored the bootstrap read at 5: it refuses that one.
    vi.mocked(persistBootstrap).mockImplementation(async (data) => (data.last_event_id === "5" ? { ...data, answer_stale: true } : data));
    let downloads = 0; // the first is read at 5, every later one at 7
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.startsWith("/api/bootstrap")) {
        downloads++;
        return downloads === 1 ? structuredClone(slim) : { ...structuredClone(slim), last_event_id: "7", nodes: [{ ...slim.nodes[0]!, title: "Saved meanwhile" }, slim.nodes[1]] };
      }
      if (p.startsWith("/api/canvases")) return [];
      if (p.startsWith("/api/sync")) return { last_event_id: 7, nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
      throw new Error("unexpected " + p);
    });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(getAppState().online).toBe(true));
    expect(result.current.bootstrapped).toBe(true);
    // Downloaded again where it was refused (the slim paint), not abandoned for the whole one: a cached big workspace
    // has no whole download to fall back on and was left offline.
    const bootstraps = apiMock.mock.calls.map((c) => String(c[0])).filter((p) => p.startsWith("/api/bootstrap"));
    expect(bootstraps.slice(0, 2)).toEqual(["/api/bootstrap?bodies=none", "/api/bootstrap?bodies=none"]);
    await waitFor(() => expect(getAppState().data.nodes[0]!.title).toBe("Saved meanwhile"));
  });
});
