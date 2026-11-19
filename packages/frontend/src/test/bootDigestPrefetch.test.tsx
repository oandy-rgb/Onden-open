// Warm boot, step 1 (perf F4): the membership digest request starts before the
// cached copy is read, so it overlaps loadBootstrapList instead of following it.
// The reconcile uses it only when it answers the epoch sync reports.
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { ApiError } from "../lib/api";
import { getAppState } from "../lib/appStore";
import { getMembershipEpoch, loadBootstrapList, getLastFullRefresh, persistBootstrap, getAllMembershipIds, setMembershipEpoch } from "../lib/localDb";

const cached = {
  bodies: "full",
  workspace: { id: "ws", name: "T", slug: "default", home_node_id: null },
  nodes: [{ id: "n1", title: "Cached", slug: "cached", markdown: "cached body", node_type: "content", source_type: "manual", parent_id: null, hidden: false, order_key: "a0" }],
  edges: [], tasks: [], suggestions: [], events: [], actor_role: "admin", tags: [],
};

vi.mock("../lib/localDb", () => ({
  getWatermark: async () => ({ position: null, server: null }), raiseWatermark: async () => {}, rewindCursor: async () => {}, forgetCopyWatermark: async () => ({ alreadyOwed: false }),
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

import { membershipDigestOf, webCryptoSha256 } from "../lib/data/membershipDigest";
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


// The mirror holds no ids (getAllMembershipIds → []), so the equal digest is the empty set's.
let emptySet: Awaited<ReturnType<typeof membershipDigestOf>>;
beforeAll(async () => { emptySet = await membershipDigestOf([], webCryptoSha256()!); });
const digestReply = (epoch: number) => ({ epoch, event_cursor: "7", ...emptySet });

beforeEach(() => {
  apiMock.mockReset();
  vi.mocked(getLastFullRefresh).mockResolvedValue(Date.now());
  vi.mocked(getAllMembershipIds).mockClear();
  vi.mocked(setMembershipEpoch).mockClear();
  let stored = 1; // behind the server: the first reconcile runs, a later sync finds it current
  vi.mocked(getMembershipEpoch).mockImplementation(async () => stored);
  vi.mocked(setMembershipEpoch).mockImplementation(async (e: number) => { stored = e; });
  idleQueue = [];
  (globalThis as Record<string, unknown>).requestIdleCallback = (cb: () => void) => { idleQueue.push(cb); return idleQueue.length; };
});

describe("warm boot digest prefetch", () => {
  it("asks for the digest while loadBootstrapList is still reading, and reuses it when the epoch matches", async () => {
    const order: string[] = [];
    let releaseLoad!: () => void;
    vi.mocked(loadBootstrapList).mockImplementationOnce(async () => {
      order.push("load:start");
      await new Promise<void>((r) => { releaseLoad = r; });
      order.push("load:end");
      return structuredClone(cached) as never;
    });
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      order.push(p);
      if (p.startsWith("/api/sync/membership/digest")) return digestReply(3);
      if (p.startsWith("/api/canvases")) return [];
      if (p === "/api/sync") return { ...structuredClone(emptyDelta), membership_epoch: 3 };
      throw new Error("unexpected " + p);
    });
    renderHook(() => useAppData());
    await waitFor(() => expect(order).toContain("/api/sync/membership/digest"));
    expect(order).not.toContain("load:end");
    releaseLoad();
    await waitFor(() => expect(setMembershipEpoch).toHaveBeenCalled());
    await waitFor(() => expect(getAppState().membershipGated).toBe(false));
    // One digest request in all: the reconcile took the prefetched answer.
    expect(order.filter((p) => p.startsWith("/api/sync/membership/digest"))).toEqual(["/api/sync/membership/digest"]);
    expect(setMembershipEpoch).toHaveBeenCalledWith(3);
  });

  it("asks again, with the epoch, when sync reports another one than the prefetch saw", async () => {
    const digestPaths: string[] = [];
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.startsWith("/api/sync/membership/digest")) { digestPaths.push(p); return digestReply(p.includes("expected_epoch=5") ? 5 : 4); }
      if (p.startsWith("/api/canvases")) return [];
      if (p === "/api/sync") return { ...structuredClone(emptyDelta), membership_epoch: 5 };
      throw new Error("unexpected " + p);
    });
    renderHook(() => useAppData());
    await waitFor(() => expect(setMembershipEpoch).toHaveBeenCalled());
    await waitFor(() => expect(getAppState().membershipGated).toBe(false));
    expect(digestPaths).toEqual(["/api/sync/membership/digest", "/api/sync/membership/digest?expected_epoch=5"]);
    expect(setMembershipEpoch).toHaveBeenCalledWith(5);
  });

  it("a failed prefetch falls back to the normal request", async () => {
    let first = true;
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.startsWith("/api/sync/membership/digest")) {
        if (first) { first = false; throw new ApiError(500, "boom"); }
        return digestReply(3);
      }
      if (p.startsWith("/api/canvases")) return [];
      if (p === "/api/sync") return { ...structuredClone(emptyDelta), membership_epoch: 3 };
      throw new Error("unexpected " + p);
    });
    renderHook(() => useAppData());
    await waitFor(() => expect(setMembershipEpoch).toHaveBeenCalled());
    await waitFor(() => expect(getAppState().membershipGated).toBe(false));
    expect(setMembershipEpoch).toHaveBeenCalledWith(3);
  });
});
