// Boot with the "own folder" copy configured. The folder is imported only into
// a browser that has no workspace yet: the import replaces the local database
// and its queue of unsent writes, so a local read that merely FAILED (worker
// timeout, a busy snapshot) must not be taken for "nothing here".
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
  importDatabase: vi.fn(async () => {}),
  installUnloadFlush: vi.fn(() => () => {}),
  flushLocalDbSync: vi.fn(async () => {}),
  loadCanvases: vi.fn(async () => []),
  upsertCanvas: vi.fn(async () => {}),
  removeCanvas: vi.fn(async () => {}),
  loadCanvas: vi.fn(async () => null),
}));
vi.mock("../lib/fileSystemStorage", () => ({
  getStoragePref: () => "fs-access",
  getStoredDirHandle: vi.fn(async () => ({ name: "vault" })),
  requestDirPermission: vi.fn(async () => true),
  readDbFromDir: vi.fn(async () => new ArrayBuffer(8)),
  writeDbToDir: vi.fn(async () => {}),
}));
vi.mock("../lib/data/syncStatus", () => ({ refreshPendingCount: vi.fn(), bumpPending: vi.fn() }));

const apiMock = vi.fn();
vi.mock("../lib/api", async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: (...a: unknown[]) => apiMock(...a) };
});

import { resetAppState } from "../lib/appStore";
import { importDatabase, loadBootstrapList } from "../lib/localDb";
import { readDbFromDir } from "../lib/fileSystemStorage";
import { useAppData } from "../lib/useAppData";

const slim = {
  bodies: "none",
  last_event_id: "5",
  workspace: { id: "ws", name: "T", slug: "default", home_node_id: null },
  nodes: [{ id: "n1", title: "Server title", slug: "n-1", markdown: "", body_len: 5, node_type: "content", source_type: "manual", parent_id: null, hidden: false, order_key: "a0" }],
  edges: [], tasks: [], suggestions: [], events: [], actor_role: "admin", tags: [],
};

beforeEach(() => {
  resetAppState();
  apiMock.mockReset();
  vi.mocked(importDatabase).mockClear();
  vi.mocked(readDbFromDir).mockClear();
  vi.mocked(loadBootstrapList).mockReset();
  (globalThis as Record<string, unknown>).requestIdleCallback = () => 1;
  apiMock.mockImplementation(async (path: string) => {
    const p = String(path);
    if (p.startsWith("/api/bootstrap")) return structuredClone(slim);
    if (p.startsWith("/api/canvases")) return [];
    if (p.startsWith("/api/sync")) return { last_event_id: 5, nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
    throw new Error("unexpected " + p);
  });
});

describe("boot with a folder copy", () => {
  it("imports the folder into a browser that has no workspace", async () => {
    vi.mocked(loadBootstrapList).mockResolvedValue(null);
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    expect(importDatabase).toHaveBeenCalledTimes(1);
  });

  it("leaves the local database alone when reading it failed", async () => {
    vi.mocked(loadBootstrapList).mockRejectedValue(new Error("localDb loadBootstrapList timed out"));
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    expect(readDbFromDir).not.toHaveBeenCalled();
    expect(importDatabase).not.toHaveBeenCalled();
  });
});
