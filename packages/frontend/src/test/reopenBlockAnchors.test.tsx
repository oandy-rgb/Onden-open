// An ordinary reload (a local copy and a cursor) must still know whether the server has paragraph anchors on: the flag
// used to be set only by the whole bootstrap, which a reopen does not fetch (it reads ?nodes=none, or nothing offline).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { getAppState } from "../lib/appStore";
import { getLastFullRefresh } from "../lib/localDb";
import { blockAnchorsEnabled, setBlockAnchorsEnabled, applyServerFeatures } from "../lib/blockAnchorStore";
import { bindAccountStorage } from "../lib/accountStorage";

const workspace = { id: "ws", name: "T", slug: "default", home_node_id: null };
const cached = {
  bodies: "full", workspace, actor_role: "admin", tags: [], edges: [], tasks: [], suggestions: [], events: [],
  nodes: [{ id: "n1", title: "Cached", slug: "cached", markdown: "body", node_type: "content", source_type: "manual", parent_id: null, hidden: false, sort_order: 0 }],
};
const meta = { ...cached, nodes: [], nodes_omitted: true, features: { block_nodes: true, paragraph_anchors: true } };
const emptyDelta = { last_event_id: 7, nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };

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

beforeEach(() => {
  bindAccountStorage("u", "");
  localStorage.clear();
  setBlockAnchorsEnabled(false);
  apiMock.mockReset();
  vi.mocked(getLastFullRefresh).mockResolvedValue(Date.now() - 60_000); // refreshed today: a reopen reads only ?nodes=none
  (globalThis as Record<string, unknown>).requestIdleCallback = (cb: () => void) => { cb(); return 1; };
});

describe("reopening with a local copy", () => {
  it("the meta read turns paragraph anchors on", async () => {
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p === "/api/bootstrap?nodes=none") return structuredClone(meta);
      if (p.startsWith("/api/canvases")) return [];
      if (p.startsWith("/api/sync")) return structuredClone(emptyDelta);
      throw new Error("unexpected " + p);
    });
    renderHook(() => useAppData());
    await waitFor(() => expect(blockAnchorsEnabled()).toBe(true));
  });

  it("offline, the last answer of the server for this account still holds", async () => {
    applyServerFeatures({ paragraph_anchors: true }); // an earlier session
    setBlockAnchorsEnabled(false); // the page was reloaded: memory starts off
    apiMock.mockImplementation(async (path: string) => {
      if (String(path).startsWith("/api/canvases")) return [];
      throw new TypeError("Failed to fetch");
    });
    renderHook(() => useAppData());
    await waitFor(() => expect(getAppState().online).toBe(false));
    expect(blockAnchorsEnabled()).toBe(true);
  });

  it("a device that never heard from the server keeps them off", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (String(path).startsWith("/api/canvases")) return [];
      throw new TypeError("Failed to fetch");
    });
    renderHook(() => useAppData());
    await waitFor(() => expect(getAppState().online).toBe(false));
    expect(blockAnchorsEnabled()).toBe(false);
  });
});
