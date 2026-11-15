// Audit #3/#4: the sync loop advances the cursor through projection-empty
// 500-event windows (governance batches used to wedge it forever), and
// sync()/flushPendingWrites() are single-flight (concurrent entry points used
// to double-drain the same pending writes).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { createHash } from "node:crypto";

const calls: string[] = [];
const setLastEventId = vi.fn(async (...args: unknown[]) => { calls.push(`cursor:${args[0]}`); });
const applySync = vi.fn(async (delta: unknown) => { calls.push("apply"); return delta; });
const getLastEventId = vi.fn(async () => 100);
const getPendingWrites = vi.fn(async () => [] as Array<{ id: number; path: string; method: string; body: string | null }>);
const clearPendingWrite = vi.fn(async (..._args: unknown[]) => {});

vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  initLocalDb: vi.fn(async () => null),
  loadBootstrapList: vi.fn(async () => null),
  loadBootstrapRelations: vi.fn(async () => ({ edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] })),
  loadAttributePage: vi.fn(async () => ({ rows: [], next: null })),
  persistBootstrap: vi.fn(async (data) => data),
  persistRemoteNode: vi.fn(async (node) => node),
  getStoredBody: vi.fn(async () => null),
  applySync: (...a: unknown[]) => applySync(a[0]),
  getLastEventId: () => getLastEventId(),
  setLastEventId: (id: number | string) => setLastEventId(id),
  getAllNodeIds: vi.fn(async () => [] as string[]),
  getAllMembershipIds: vi.fn(async () => [] as string[]),
  getMembershipEpoch: vi.fn(async () => 0),
  setMembershipEpoch: vi.fn(async () => {}),
  getPendingWrites: () => getPendingWrites(),
  rejectPendingWrite: vi.fn(async (write, rejection) => {
    getPendingWrites.mockResolvedValue([]);
    return { ...write, rejection };
  }),
  clearPendingWrite: async (id: number) => { await clearPendingWrite(id); getPendingWrites.mockResolvedValue([]); },
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
  getStoragePref: vi.fn(() => "opfs"),
  getStoredDirHandle: vi.fn(async () => null),
  requestDirPermission: vi.fn(async () => false),
  readDbFromDir: vi.fn(async () => null),
  writeDbToDir: vi.fn(async () => {}),
}));
vi.mock("../lib/data/syncStatus", () => ({ refreshPendingCount: vi.fn() }));

const apiMock = vi.fn();
vi.mock("../lib/api", async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: (...a: unknown[]) => apiMock(...a) };
});

import { canvasWriter } from "../lib/data/domainWriters";
import { useAppData } from "../lib/useAppData";
import { __idleSyncEngineForTests, __resetSyncEngineForTests, wentOffline } from "../lib/data/syncEngine";
import { dataSync } from "../lib/data";

const { markSyncDirty, membershipChanged, liveStreamReconnected, hydrateFullBootstrap, hydrateNode, refresh, sync, flushQueue: flushPendingWrites } = dataSync;
import { getAppState, setMembershipGated, resetAppState, subscribeApp } from "../lib/appStore";
import { loadBootstrapList, importDatabase, persistBootstrap, persistRemoteNode, getAllMembershipIds, getMembershipEpoch, setMembershipEpoch, upsertCanvas } from "../lib/localDb";
import { ApiError } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { getStoragePref, getStoredDirHandle, requestDirPermission, readDbFromDir } from "../lib/fileSystemStorage";
import type { Bootstrap, Canvas, ContentNode } from "../lib/api";
import type { SyncDelta } from "../lib/localDb";

const EMPTY = (le: number) => ({
  last_event_id: le,
  nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] },
  tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] },
  workspace: null,
});

describe("remote reads use the worker's pending-text projection", () => {
  const node: ContentNode = { id: "n", title: "server", markdown: "server", source_type: "manual", node_type: "content", slug: "n" };
  const remote: Bootstrap = { workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor", nodes: [node], edges: [], tasks: [], suggestions: [], events: [] };

  it.each(["refresh", "full hydration"])("%s paints the accepted local projection, not the raw response", async operation => {
    apiMock.mockImplementation(async path => path.startsWith("/api/bootstrap") ? remote : []);
    vi.mocked(persistBootstrap).mockResolvedValueOnce({ ...remote, nodes: [{ ...remote.nodes[0], markdown: "still queued" }] });
    await (operation === "refresh" ? refresh() : hydrateFullBootstrap());
    expect(getAppState().data.nodes[0].markdown).toBe("still queued");
  });

  it.each(["refresh", "full hydration"])("%s answered after the browser went offline leaves the app offline", async operation => {
    resetAppState({ online: true });
    let answer!: (value: Bootstrap) => void;
    apiMock.mockImplementation(path => path.startsWith("/api/bootstrap") ? new Promise<Bootstrap>((resolve) => { answer = resolve; }) : Promise.resolve([]));
    const pending = operation === "refresh" ? refresh() : hydrateFullBootstrap();
    await vi.waitFor(() => expect(answer).toBeDefined());
    wentOffline();
    answer(remote);
    await pending;
    expect(getAppState().online).toBe(false);
    // Asked after the event, the answer does mean the server is reachable.
    apiMock.mockImplementation(async path => path.startsWith("/api/bootstrap") ? remote : []);
    await (operation === "refresh" ? refresh() : hydrateFullBootstrap());
    expect(getAppState().online).toBe(true);
  });

  it("lazy hydration and deltas also use the worker result", async () => {
    resetAppState({ data: remote });
    apiMock.mockResolvedValueOnce(node);
    vi.mocked(persistRemoteNode).mockResolvedValueOnce({ ...remote.nodes[0], markdown: "queued lazy text" });
    await hydrateNode("n");
    expect(getAppState().data.nodes[0].markdown).toBe("queued lazy text");
    const raw = { ...EMPTY(101), nodes: { upsert: remote.nodes, delete: [] } };
    apiMock.mockResolvedValueOnce(raw).mockResolvedValueOnce(EMPTY(101));
    applySync.mockResolvedValueOnce({ ...raw, nodes: { upsert: [{ ...remote.nodes[0], markdown: "queued delta text" }], delete: [] } });
    expect(await sync()).toEqual({ ok: true });
    expect(getAppState().data.nodes[0].markdown).toBe("queued delta text");
  });
});

// The engine defers background work (hydration, offline downloads) to idle
// time. setup.ts runs those callbacks on a timer, so they would fire after the
// test that scheduled them, against the next test's mocks. Hold them instead and
// drop them when the test ends; nothing here asserts on idle work.
const idleCallbacks: Array<() => void> = [];

beforeEach(async () => {
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => idleCallbacks.push(callback));
  vi.stubGlobal("cancelIdleCallback", () => {});
  await canvasWriter.select(null);
  calls.length = 0; apiMock.mockReset(); setLastEventId.mockClear(); applySync.mockClear();
  // Back to the factory defaults: some tests give the local DB a cursor,
  // pending writes or a membership epoch of their own.
  getLastEventId.mockReset(); getPendingWrites.mockReset();
  for (const mock of [getAllMembershipIds, getMembershipEpoch, setMembershipEpoch, persistBootstrap, persistRemoteNode, upsertCanvas]) vi.mocked(mock).mockReset();
  vi.mocked(getStoragePref).mockReturnValue("opfs");
  vi.mocked(loadBootstrapList).mockReset().mockResolvedValue(null);
  vi.mocked(importDatabase).mockReset().mockResolvedValue(undefined);
  vi.mocked(readDbFromDir).mockReset().mockResolvedValue(null);
});

// Every mounted hook starts a boot and its sync pass; unmounting only removes
// the listeners. Let that work end, and drop the engine's timers and latches,
// before the next test replaces the mocks it would otherwise reach.
afterEach(async () => {
  cleanup(); // hooks run in reverse order: unmount here, before the reset below
  await Promise.resolve(); // attachConnectivity's disposer stops on a microtask
  idleCallbacks.length = 0;
  await __resetSyncEngineForTests();
  resetAppState(); // after the engine is idle: nothing is left to write into it
});

function bootQuiet() {
  // init() fires /api/bootstrap + /api/canvases — keep them inert
  apiMock.mockImplementation(async (path: string) => {
    if (String(path).startsWith("/api/bootstrap")) throw new Error("offline for test");
    if (String(path).startsWith("/api/canvases")) return [];
    throw new Error("unexpected " + path);
  });
}

describe("folder copies at startup", () => {
  const local: Bootstrap = { workspace: { id: "w", name: "Vault", slug: "vault", home_node_id: null }, nodes: [], edges: [], tasks: [], suggestions: [], events: [], actor_role: "admin" };
  const folder = { name: "Saved folder" } as FileSystemDirectoryHandle;
  beforeEach(() => {
    bootQuiet();
    vi.mocked(getStoragePref).mockReturnValue("fs-access");
    vi.mocked(getStoredDirHandle).mockResolvedValue(folder);
    vi.mocked(requestDirPermission).mockResolvedValue(true);
    vi.mocked(readDbFromDir).mockResolvedValue(new ArrayBuffer(10));
  });
  it("keeps an existing browser snapshot instead of loading a possibly older folder copy", async () => {
    vi.mocked(loadBootstrapList).mockResolvedValue(local);
    await act(async () => { renderHook(() => useAppData()); });
    expect(readDbFromDir).not.toHaveBeenCalled();
    expect(importDatabase).not.toHaveBeenCalled();
    expect(getAppState().data?.workspace.id).toBe("w");
  });
  it("loads a folder when this browser has no local workspace", async () => {
    vi.mocked(loadBootstrapList).mockResolvedValueOnce(null).mockResolvedValue(local);
    await act(async () => { renderHook(() => useAppData()); });
    expect(importDatabase).toHaveBeenCalledOnce();
    expect(getAppState().data?.workspace.id).toBe("w");
  });
  it("keeps the browser snapshot available when folder permission is refused", async () => {
    vi.mocked(loadBootstrapList).mockResolvedValue(local);
    vi.mocked(requestDirPermission).mockResolvedValue(false);
    await act(async () => { renderHook(() => useAppData()); });
    expect(importDatabase).not.toHaveBeenCalled();
    expect(getAppState().data?.workspace.id).toBe("w");
  });
});

describe("sync cursor (audit #3)", () => {
  it("fast-forwards through projection-empty windows, then stops when caught up", async () => {
    bootQuiet();
    const { result } = renderHook(() => useAppData());
    const seq = [EMPTY(600), EMPTY(1100), EMPTY(1100)]; // two governance batches, then caught up
    apiMock.mockImplementation(async (path: string) => {
      if (String(path) === "/api/sync") return seq.shift() ?? EMPTY(1100);
      if (String(path).startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    await act(async () => { await result.current.sync(); });
    expect(setLastEventId.mock.calls.map((c) => c[0])).toEqual([600, 1100]);
    expect(applySync).not.toHaveBeenCalled();
  });

  it("keeps pulling until caught up (doesn't stop after the first projecting delta)", async () => {
    // Review #2: a non-empty batch used to RETURN, leaving the client half-synced
    // after a long offline gap (>500 events) when the server is then idle (no more
    // SSE ticks to resume). Now it advances the cursor and keeps pulling within the
    // pass until an empty caught-up delta.
    bootQuiet();
    const { result } = renderHook(() => useAppData());
    const projecting = { ...EMPTY(700), nodes: { upsert: [{ id: "n1" } as never], delete: [] } };
    const seq = [EMPTY(500), projecting]; // empty fast-forward → projecting batch → caught up (fallback EMPTY(700))
    apiMock.mockImplementation(async (path: string) => {
      if (String(path) === "/api/sync") return seq.shift() ?? EMPTY(700);
      if (String(path).startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    await act(async () => { await result.current.sync(); });
    // 500 (empty window) → 700 (projecting; cursor advanced, loop continues) → EMPTY(700)==caught up → return.
    expect(setLastEventId.mock.calls.map((c) => c[0])).toEqual([500, 700]);
    expect(applySync).toHaveBeenCalledTimes(1);
  });
});

describe("single-flight (audit #4)", () => {
  it("concurrent sync() calls share one pass — /api/sync hit once", async () => {
    bootQuiet();
    const { result } = renderHook(() => useAppData());
    let syncHits = 0;
    apiMock.mockImplementation(async (path: string) => {
      if (String(path) === "/api/sync") {
        syncHits++;
        await new Promise((r) => setTimeout(r, 30)); // hold the pass open
        return EMPTY(100); // caught up immediately
      }
      if (String(path).startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    await act(async () => {
      await Promise.all([result.current.sync(), result.current.sync(), result.current.sync()]);
    });
    expect(syncHits).toBe(1);
  });

  it("a membership signal mid-sync (dirty-latch) triggers exactly one extra reconcile pass", async () => {
    // C2 fail-open fix: an SSE membership tick during an in-flight sync must NOT
    // be coalesced away — markSyncDirty() latches it so the finally re-runs sync()
    // once to reconcile the NEW epoch (the in-flight pass reconciled the stale one
    // and would have lowered the gate). Exactly one extra pass, then it settles.
    bootQuiet();
    const { result } = renderHook(() => useAppData());
    let syncHits = 0;
    apiMock.mockImplementation(async (path: string) => {
      if (String(path) === "/api/sync") {
        syncHits++;
        if (syncHits === 1) markSyncDirty(); // SSE membership tick arrives mid-flight
        await new Promise((r) => setTimeout(r, 10));
        return EMPTY(100); // caught up
      }
      if (String(path).startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    // The latched re-run starts as the first pass ends, so this joins it; a
    // missing re-run would instead start a third pass and fail the count.
    await act(async () => { await result.current.sync(); await sync(); });
    expect(syncHits).toBe(2); // original pass + one latched reconcile, then no more
  });

  it("concurrent drains never double-send the same pending write", async () => {
    bootQuiet();
    getPendingWrites.mockResolvedValue([{ id: 1, path: "/api/nodes/x", method: "PATCH", body: "{}" }]);
    const { result } = renderHook(() => useAppData());
    const sent: string[] = [];
    apiMock.mockImplementation(async (path: string) => {
      if (String(path) === "/api/nodes/x") {
        sent.push("write");
        await new Promise((r) => setTimeout(r, 25));
        getPendingWrites.mockResolvedValue([]); // cleared after first send
        return {};
      }
      if (String(path).startsWith("/api/sync")) return EMPTY(100);
      if (String(path).startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    await act(async () => {
      await Promise.all([result.current.flushPendingWrites(), result.current.flushPendingWrites()]);
    });
    expect(sent).toEqual(["write"]);
  });
});

// Step D fail-closed display gate (membershipGated). Local epoch is mocked to 0,
// so any delta carrying a non-zero membership_epoch triggers a reconcile.
describe("membership display gate (Step D fail-closed)", () => {
  beforeEach(() => { setMembershipGated(false); });

  it("advances decimal-string event cursors across a digit boundary before releasing the gate", async () => {
    bootQuiet();
    // A cursorless device: boot reads the cursor once (to decide whether sync
    // must wait for the bootstrap's), then the sync pass reads it.
    vi.mocked(getLastEventId).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const { result } = renderHook(() => useAppData());
    const requested: Array<number | string> = [];
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/sync") {
        const since = JSON.parse(String(init?.body)).since as number | string;
        requested.push(since);
        const last = since === 0 ? "500" : String(since) === "500" ? "1000" : "1014";
        return { ...EMPTY(Number(last)), last_event_id: last, membership_epoch: 5 };
      }
      if (path.startsWith("/api/sync/membership")) return { ids: [], next_cursor: null, epoch: 5, event_cursor: "1014" };
      if (path.startsWith("/api/sync/nodes")) return { nodes: [], attributes: { upsert: [], delete: [] }, edges: [], tasks: [] };
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    await act(async () => { expect(await result.current.sync()).toEqual({ ok: true }); });
    expect(requested).toEqual([0, "500", "1000", "1014"]);
    expect(setLastEventId.mock.calls.map((call) => call[0])).toEqual(["500", "1000", "1014"]);
    expect(getAppState().membershipGated).toBe(false);
  });

  it("CLEARS the gate when a reconcile converges", async () => {
    bootQuiet();
    const { result } = renderHook(() => useAppData());
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      // caught-up event delta that advertises a NEW membership epoch (5 ≠ local 0)
      if (p.startsWith("/api/sync/membership")) return { ids: [], next_cursor: null, epoch: 5, event_cursor: "100" };
      if (p.startsWith("/api/sync/nodes")) return { nodes: [], attributes: { upsert: [], delete: [] }, edges: [], tasks: [] };
      if (p.startsWith("/api/sync")) return { ...EMPTY(100), membership_epoch: 5 };
      if (p.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + p);
    });
    await act(async () => { await result.current.sync(); });
    expect(getAppState().membershipGated).toBe(false); // converged → gate down
  });

  it("scans events committed during membership before lowering the gate, without acknowledging its MAX", async () => {
    bootQuiet();
    const { result } = renderHook(() => useAppData());
    let pulls = 0;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/sync/membership")) return { ids: [], next_cursor: null, epoch: 5, event_cursor: "102" };
      if (path === "/api/sync") {
        const since = JSON.parse(String(init?.body)).since;
        if (++pulls === 1) { expect(since).toBe(100); return { ...EMPTY(100), membership_epoch: 5 }; }
        expect(getAppState().membershipGated).toBe(true);
        if (pulls === 2) {
          expect(since).toBe(100); // membership MAX was NOT written as the cursor
          expect(setLastEventId).not.toHaveBeenCalled();
          return { ...EMPTY(101), membership_epoch: 5 }; // scanned first intervening event
        }
        if (pulls === 3) { expect(since).toBe(101); return { ...EMPTY(103), membership_epoch: 5 }; }
        expect(since).toBe(103); // may catch up beyond the membership read guard
        return { ...EMPTY(103), membership_epoch: 5 };
      }
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    await act(async () => { expect(await result.current.sync()).toEqual({ ok: true }); });
    expect(pulls).toBe(4);
    expect(setLastEventId.mock.calls.map(c => c[0])).toEqual([101, 103]);
    expect(getAppState().membershipGated).toBe(false);
  });

  it("failed event catch-up after membership remains gated and reports incomplete sync", async () => {
    bootQuiet();
    const { result } = renderHook(() => useAppData());
    let pulls = 0;
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/sync/membership")) return { ids: [], next_cursor: null, epoch: 5, event_cursor: "102" };
      if (path === "/api/sync") {
        if (++pulls === 1) return { ...EMPTY(100), membership_epoch: 5 };
        throw new Error("network lost");
      }
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    await act(async () => { expect(await result.current.sync()).toMatchObject({ ok: false }); });
    expect(getAppState().membershipGated).toBe(true);
    expect(setLastEventId).not.toHaveBeenCalled();
  });

  it("KEEPS the gate raised when reconciliation fails (never opens to stale data)", async () => {
    bootQuiet();
    const { result } = renderHook(() => useAppData());
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      // every membership page is a torn-read retry → the drain never converges →
      // restart-exhausted → throw → sync ok=false → gate STAYS up.
      if (p.startsWith("/api/sync/membership")) return { ids: [], next_cursor: null, epoch: 7, event_cursor: "100", retry_required: true };
      if (p.startsWith("/api/sync")) return { ...EMPTY(100), membership_epoch: 7 };
      if (p.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + p);
    });
    await act(async () => { await result.current.sync(); });
    expect(getAppState().membershipGated).toBe(true); // unresolved → gate stays up (fail-closed)
  });

  it("going offline LOWERS the gate (no stuck 'Updating permissions…' offline)", async () => {
    // If the browser drops network mid-cold-start-reconcile, the reconcile
    // raised the gate and then throws; sync() swallows it to ok=false, so the
    // gate would stick up forever and block offline capture. handleOffline must
    // lower it (offline-first: cached shows, membership re-checks on reconnect).
    bootQuiet();
    renderHook(() => useAppData());
    await act(async () => { await Promise.resolve(); }); // let init settle
    act(() => { setMembershipGated(true); });            // gate raised mid-reconcile
    expect(getAppState().membershipGated).toBe(true);
    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(getAppState().membershipGated).toBe(false);   // handleOffline lowered it
  });

  it("browser online RAISES the gate before reconnect sync resolves", async () => {
    // Offline mode intentionally lowers the gate so cached work can continue.
    // The moment the browser reports online again, the cached membership may be
    // stale, so the reconnect path must latch the gate before any async drain /
    // sync round-trip has a chance to reconcile it.
    bootQuiet();
    renderHook(() => useAppData());
    await act(async () => { await Promise.resolve(); }); // let init settle offline
    act(() => { setMembershipGated(false); });
    expect(getAppState().membershipGated).toBe(false);

    act(() => { window.dispatchEvent(new Event("online")); });
    expect(getAppState().membershipGated).toBe(true);
  });

  it("a live-stream reconnect re-syncs without locking unless permissions changed meanwhile", async () => {
    // Chrome on Linux drops every connection when the computer's network
    // interfaces change (a container starting, Tailscale updating routes), so
    // the stream reconnects often. Locking on each reconnect flashed the screen
    // and pulled the cursor out of the editor; the catch-up sync's epoch check
    // still locks when a permission changed while the stream was down.
    bootQuiet();
    const { result } = renderHook(() => useAppData());
    let epoch = 5;
    let membershipReads = 0;
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.startsWith("/api/sync/membership")) { membershipReads++; return { ids: [], next_cursor: null, epoch, event_cursor: "100" }; }
      if (p.startsWith("/api/sync/nodes")) return { nodes: [], attributes: { upsert: [], delete: [] }, edges: [], tasks: [] };
      if (p.startsWith("/api/sync")) return { ...EMPTY(100), membership_epoch: epoch };
      if (p.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + p);
    });
    // The session's first check reconciles; the device then holds epoch 5.
    await act(async () => { await result.current.sync(); });
    vi.mocked(getMembershipEpoch).mockResolvedValue(5);
    const transitions: boolean[] = [];
    let last = getAppState().membershipGated;
    const stop = subscribeApp(() => {
      const now = getAppState().membershipGated;
      if (now !== last) { transitions.push(now); last = now; }
    });
    try {
      const before = membershipReads;
      await act(async () => { liveStreamReconnected(); await sync(); });
      expect(transitions).toEqual([]); // never locked
      expect(membershipReads).toBe(before); // nothing to reconcile
      epoch = 6; // a permission changed while the stream was down
      await act(async () => { liveStreamReconnected(); await sync(); });
      expect(transitions).toEqual([true, false]); // locked, reconciled, released
      expect(membershipReads).toBeGreaterThan(before); // pages plus the final check
    } finally {
      stop();
      vi.mocked(getMembershipEpoch).mockResolvedValue(0);
    }
  });

  it("a burst of membership ticks is one lock and one reconcile, never released in between", async () => {
    // One rejected agent chain arrives as several ticks. Each used to run its
    // own lock → reconcile → release, and a keystroke landing in a locked
    // moment was dropped. Now the gate rises at once and stays up until the
    // burst has settled and a single pass has reconciled it.
    let syncHits = 0;
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/sync") { syncHits++; return EMPTY(100); }
      if (String(path).startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    setMembershipGated(false);
    const transitions: boolean[] = [];
    let last = getAppState().membershipGated;
    const stop = subscribeApp(() => {
      const now = getAppState().membershipGated;
      if (now !== last) { transitions.push(now); last = now; }
    });
    vi.useFakeTimers(); // the settle window is 300 ms of timer time, not of machine time
    try {
      act(() => { membershipChanged(); });
      expect(getAppState().membershipGated).toBe(true); // locked at once
      await act(async () => { await vi.advanceTimersByTimeAsync(120); });
      act(() => { membershipChanged(); }); // the next tick of the same burst
      await act(async () => { await vi.advanceTimersByTimeAsync(120); });
      act(() => { membershipChanged(); });
      expect(syncHits).toBe(0); // still settling: nothing reconciled yet
      await act(async () => { await vi.advanceTimersByTimeAsync(450); });
      expect(syncHits).toBe(1);
      expect(transitions).toEqual([true, false]); // one lock, one release
    } finally { stop(); vi.useRealTimers(); }
  });

  it("a sync that finishes while a burst is settling keeps the workspace locked", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (String(path).startsWith("/api/sync")) return EMPTY(100);
      if (String(path).startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    vi.useFakeTimers();
    try {
      act(() => { membershipChanged(); });
      // An unrelated "changed" tick runs a sync before the burst has settled.
      await act(async () => { await sync(); });
      expect(getAppState().membershipGated).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(450); });
      expect(getAppState().membershipGated).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("a membership tick raises the gate IMMEDIATELY (dirty-latch)", () => {
    // The latch BuilderApp's onMembershipChanged uses: the gate goes up the instant
    // the tick arrives, before any reconcile round-trip.
    setMembershipGated(false);
    setMembershipGated(true);
    expect(getAppState().membershipGated).toBe(true);
  });
});

describe("reconnect retry (no stuck-offline after a failed sync)", () => {
  it("a failed reconnect schedules a retry that recovers online when the server returns", async () => {
    vi.useFakeTimers();
    try {
      let serverUp = false;
      const BOOT = {
        nodes: [], edges: [], tasks: [], suggestions: [], events: [],
        tags: [], actor_role: "admin",
        workspace: { id: "w", name: "W", slug: "w", home_node_id: null },
      };
      apiMock.mockImplementation(async (path: string) => {
        const p = String(path);
        if (p.startsWith("/api/canvases")) return [];
        if (p.startsWith("/api/bootstrap")) {
          if (!serverUp) throw new Error("server unreachable"); // down during boot + first reconnect
          return BOOT; // back → refresh() succeeds → setOnline(true)
        }
        if (p.startsWith("/api/sync")) {
          if (!serverUp) throw new Error("server unreachable");
          return EMPTY(1);
        }
        throw new Error("unexpected " + p);
      });
      renderHook(() => useAppData());
      await act(async () => { await Promise.resolve(); }); // let init settle (boots offline)

      // The browser fires 'online' but the SERVER is still down → handleOnline's
      // sync() fails → online reverts to false and a retry is scheduled.
      await act(async () => { window.dispatchEvent(new Event("online")); await Promise.resolve(); });
      expect(getAppState().online).toBe(false);

      // Server comes back. The browser 'online' event will NOT re-fire (the network
      // never dropped), so only the self-scheduled retry can recover. Advance it.
      serverUp = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(getAppState().online).toBe(true); // recovered without a manual refresh
    } finally {
      vi.useRealTimers();
    }
  });

  // D82: a reconnect during a deploy — the gateway answers 502 while the
  // backend restarts. sync() reports it as unreachable (one rule:
  // writeErrors.isServerUnreachable), the workspace stays offline, and the
  // self-scheduled retry brings it back once the backend answers.
  it("a reconnect that meets a deploy's 502 reports unreachable, stays offline and recovers on the retry", async () => {
    vi.useFakeTimers();
    try {
      let serverUp = false;
      const BOOT = {
        nodes: [], edges: [], tasks: [], suggestions: [], events: [],
        collections: [], tags: [], actor_role: "admin",
        workspace: { id: "w", name: "W", slug: "w", home_node_id: null },
      };
      apiMock.mockImplementation(async (path: string) => {
        const p = String(path);
        if (p.startsWith("/api/canvases")) return [];
        if (!serverUp) throw new ApiError(502, "<html><body>502 Bad Gateway</body></html>");
        if (p.startsWith("/api/bootstrap")) return BOOT;
        if (p.startsWith("/api/sync")) return EMPTY(1);
        throw new Error("unexpected " + p);
      });
      renderHook(() => useAppData());
      await act(async () => { await Promise.resolve(); }); // boots offline
      expect(await sync()).toEqual({ ok: false, unreachable: true });

      await act(async () => { window.dispatchEvent(new Event("online")); await Promise.resolve(); });
      expect(getAppState().online).toBe(false);

      serverUp = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(getAppState().online).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a sync the server answered with a 500 was reached: not unreachable", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (String(path).startsWith("/api/sync")) throw new ApiError(500, "boom");
      throw new Error("unexpected " + path);
    });
    expect(await sync()).toEqual({ ok: false, unreachable: false });
  });
});

describe("going offline during a reconnect", () => {
  // offlineFlakyNetwork e2e: the browser came back, reconnect() raised the
  // gate and started sync(); the network dropped again before sync answered.
  // handleOffline lowered the gate (offline-first), then the failed sync must
  // not raise it again — the person is offline and would be locked out of
  // their cached work until the next reconnect.
  const setBrowserOnline = (value: boolean) => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
  afterEach(() => setBrowserOnline(true));

  it("the failed reconnect sync leaves the gate down and stays offline", async () => {
    let failSync: (error: Error) => void = () => {};
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.startsWith("/api/bootstrap")) throw new Error("offline for test");
      if (p.startsWith("/api/canvases")) return [];
      if (p === "/api/sync") return new Promise((_, reject) => { failSync = reject; });
      throw new Error("unexpected " + p); // boot's digest prefetch fails quietly
    });
    renderHook(() => useAppData());
    await act(async () => { await Promise.resolve(); }); // boots offline

    setBrowserOnline(true);
    await act(async () => { window.dispatchEvent(new Event("online")); await Promise.resolve(); });
    await act(async () => { await vi.waitFor(() => expect(apiMock.mock.calls.some(([p]) => p === "/api/sync")).toBe(true)); });
    expect(getAppState().membershipGated).toBe(true); // reconnecting: gated

    setBrowserOnline(false);
    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(getAppState().membershipGated).toBe(false);

    await act(async () => { failSync(new Error("network gone")); await __idleSyncEngineForTests(); });
    expect(getAppState().online).toBe(false);
    expect(getAppState().membershipGated).toBe(false);
  });

  it("a reconnect that fails while the browser is still online keeps the gate up", async () => {
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.startsWith("/api/canvases")) return [];
      throw new Error("server unreachable");
    });
    renderHook(() => useAppData());
    await act(async () => { await Promise.resolve(); });
    setBrowserOnline(true);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    // reconnect() drains the queue before it syncs: wait for the pass, then for it to end.
    await vi.waitFor(() => expect(apiMock.mock.calls.some(([p]) => p === "/api/sync")).toBe(true));
    await act(async () => { await __idleSyncEngineForTests(); });
    expect(getAppState().online).toBe(false);
    expect(getAppState().membershipGated).toBe(true); // fail-closed while only the server is down
  });
});

// A refused creation does not produce a server event or permission-epoch bump.
// Drive the real replay + membership orchestration, with controlled I/O only.
describe("replay refusals invalidate optimistic membership", () => {
  const existing: ContentNode = { id: "existing", title: "Readable existing note", markdown: "server text", slug: "existing", source_type: "manual", node_type: "content" };
  const ghost: ContentNode = { ...existing, id: "ghost", title: "Unaccepted creation", markdown: "recoverable input" };
  const snapshot: Bootstrap = { workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "viewer", nodes: [existing], tasks: [], edges: [], suggestions: [], events: [] };
  let known: string[];
  let localEpoch: number;
  let serverEpoch: number;
  let failMembership: boolean;
  let failSync: boolean;
  let onMembership: (() => Promise<void>) | null;
  let membershipReads: number;

  function queueCreate(nodeId: string) {
    getPendingWrites.mockResolvedValue([{ id: 500, method: "POST", path: "/api/nodes", body: JSON.stringify({ id: nodeId, title: "Queued create" }) }]);
  }
  function addGhost() {
    known.push(ghost.id);
    resetAppState({ data: { ...snapshot, nodes: [existing, ghost] } });
  }

  beforeEach(async () => {
    known = [existing.id]; localEpoch = 0; serverEpoch = 0;
    failMembership = false; failSync = false; onMembership = null; membershipReads = 0;
    getPendingWrites.mockResolvedValue([]);
    getLastEventId.mockResolvedValue(100);
    vi.mocked(getAllMembershipIds).mockImplementation(async () => [...known]);
    vi.mocked(getMembershipEpoch).mockImplementation(async () => localEpoch);
    vi.mocked(setMembershipEpoch).mockImplementation(async epoch => { localEpoch = epoch; });
    applySync.mockImplementation(async delta => {
      const d = delta as { nodes: { delete: string[] } };
      known = known.filter(id => !d.nodes.delete.includes(id));
      return delta;
    });
    resetAppState({ data: snapshot });
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/nodes") throw new ApiError(403, "permission denied");
      if (path.startsWith("/api/sync/membership")) {
        membershipReads++;
        if (failMembership) throw new Error("membership read temporarily failed");
        if (onMembership) { const action = onMembership; onMembership = null; await action(); }
        // The digest of the readable set [existing] (lib/data/membershipDigest).
        if (path.startsWith("/api/sync/membership/digest")) {
          const hash = createHash("sha256").update(existing.id).digest("hex");
          return { epoch: serverEpoch, event_cursor: "100", count: 1, digest: hash, buckets: { [existing.id.slice(0, 2)]: hash.slice(0, 16) } };
        }
        return { ids: [existing.id], next_cursor: null, epoch: serverEpoch, event_cursor: "100" };
      }
      if (path === "/api/sync") {
        if (failSync) throw new ApiError(503, "sync unavailable");
        return { ...EMPTY(100), membership_epoch: serverEpoch };
      }
      throw new Error("unexpected " + path);
    });
    expect(await sync()).toEqual({ ok: true }); // establish an unchanged epoch
    membershipReads = 0; applySync.mockClear();
  });

  it("removes a refused optimistic creation without a server event or epoch change", async () => {
    addGhost(); queueCreate(ghost.id);
    expect(await sync()).toEqual({ ok: true });
    expect(membershipReads).toBe(3); // digest (differs) + readable set + version confirmation
    expect(getAppState().data.nodes.map(n => n.id)).toEqual([existing.id]);
    expect(known).toEqual([existing.id]);
    expect(getAppState().membershipGated).toBe(false);
    membershipReads = 0;
    expect(await sync()).toEqual({ ok: true });
    expect(membershipReads).toBe(0); // no perpetual full reconciliation
  });

  it("retains the invalidation after a failed check, even though the queue is already empty", async () => {
    addGhost(); queueCreate(ghost.id); failMembership = true;
    expect(await sync()).toMatchObject({ ok: false });
    expect(getAppState().membershipGated).toBe(true);
    expect(await getPendingWrites()).toEqual([]);
    failMembership = false;
    expect(await sync()).toEqual({ ok: true });
    expect(getAppState().data.nodes.map(n => n.id)).toEqual([existing.id]);
    expect(getAppState().membershipGated).toBe(false);
  });

  it("does not delete a still-readable same-ID note merely because a create was refused", async () => {
    queueCreate(existing.id);
    expect(await sync()).toEqual({ ok: true });
    expect(membershipReads).toBe(1); // the digest matches: no pages
    expect(getAppState().data.nodes).toEqual([existing]);
    expect(applySync).not.toHaveBeenCalled();
  });

  it("hides an unverified optimistic row if delta loading fails before membership can start", async () => {
    addGhost(); queueCreate(ghost.id); failSync = true;
    expect(await sync()).toMatchObject({ ok: false });
    expect(getAppState().membershipGated).toBe(true);
    expect(await getPendingWrites()).toEqual([]);
    failSync = false;
    expect(await sync()).toEqual({ ok: true });
    expect(getAppState().data.nodes.map(n => n.id)).toEqual([existing.id]);
  });

  // D1: an older server (a rollback, a self-hosted one behind a newer app)
  // answers 404/405 for the digest. That is no digest — page everything —
  // not a failed check that keeps the workspace locked forever.
  for (const status of [404, 405]) {
    it(`a digest answered ${status} falls back to pages and still removes what is no longer readable`, async () => {
      const base = apiMock.getMockImplementation()!;
      const paths: string[] = [];
      apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
        paths.push(path);
        if (path.startsWith("/api/sync/membership/digest")) throw new ApiError(status, "Not Found");
        return base(path, init);
      });
      addGhost(); serverEpoch = 1;
      expect(await sync()).toEqual({ ok: true });
      expect(paths.some((p) => p.startsWith("/api/sync/membership?"))).toBe(true);
      expect(paths.some((p) => p.includes("prefixes="))).toBe(false);
      expect(known).toEqual([existing.id]);
      expect(getAppState().membershipGated).toBe(false);
    });
  }

  it("a digest request the server cannot be reached for still fails the check (gate stays up)", async () => {
    const base = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/sync/membership/digest")) throw new ApiError(503, "unavailable");
      return base(path, init);
    });
    serverEpoch = 1;
    expect(await sync()).toMatchObject({ ok: false, unreachable: true });
    expect(getAppState().membershipGated).toBe(true);
  });

  it("a refusal arriving during a check requires another check before success", async () => {
    serverEpoch = 1; // starts a check before the new local node exists
    onMembership = async () => { addGhost(); queueCreate(ghost.id); await flushPendingWrites(); };
    expect(await sync()).toEqual({ ok: true });
    // old check (its digest matches the set captured before the late node)
    // + the check that includes it (digest differs → page → confirmation)
    expect(membershipReads).toBe(4);
    expect(getAppState().data.nodes.map(n => n.id)).toEqual([existing.id]);
    expect(getAppState().membershipGated).toBe(false);
  });
});

describe("sync reconciles the open canvas after replay", () => {
  const server: Canvas = { id: "sync-board", title: "Board", created_at: "", updated_at: "",
    data: { nodes: [{ nodeId: "existing", x: 0, y: 0 }] } };
  const stale: Canvas = { ...server, data: { nodes: [...server.data.nodes, { nodeId: "refused-card", x: 300, y: 0 }] } };
  let failCanvas: boolean;
  let onCanvasRead: (() => Promise<void>) | null;
  let canvasReads: number;
  function queuedPlacement() {
    getPendingWrites.mockResolvedValue([{ id: 600, method: "PATCH", path: "/api/canvases/sync-board", body: JSON.stringify({ data: stale.data }) }]);
  }
  beforeEach(async () => {
    bindAccountStorage("canvas-sync-test-account", "");
    failCanvas = false; onCanvasRead = null; canvasReads = 0;
    getPendingWrites.mockResolvedValue([]); getLastEventId.mockResolvedValue(100);
    vi.mocked(getAllMembershipIds).mockResolvedValue([]); vi.mocked(getMembershipEpoch).mockResolvedValue(0);
    vi.mocked(upsertCanvas).mockClear();
    resetAppState();
    // A canvas is a node: the board list is the store's canvas nodes.
    resetAppState({ online: true, data: { ...getAppState().data, nodes: [{ id: server.id, title: server.title, slug: `canvas-${server.id}`, markdown: "", node_type: "canvas", source_type: "manual" }] } });
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/canvases/sync-board") {
        if (init?.method === "PATCH") throw new ApiError(403, "denied");
        canvasReads++;
        if (failCanvas) throw new ApiError(503, "unavailable");
        if (onCanvasRead) { const action = onCanvasRead; onCanvasRead = null; await action(); return stale; }
        return server;
      }
      if (path.startsWith("/api/sync/membership")) return { ids: [], next_cursor: null, epoch: 0, event_cursor: "100" };
      if (path === "/api/sync") return { ...EMPTY(100), membership_epoch: 0 };
      throw new Error("unexpected " + path);
    });
    // Open through the same public operation as the UI: a painted snapshot
    // alone does not establish which board a later reconnect should load.
    apiMock.mockResolvedValueOnce(stale);
    await canvasWriter.select(server.id);
    vi.mocked(upsertCanvas).mockClear();
  });

  it("clears a refused placement even with no node delta or epoch change", async () => {
    queuedPlacement();
    expect(await sync()).toEqual({ ok: true });
    expect(getAppState().activeCanvas).toEqual(server);
    expect(upsertCanvas).toHaveBeenLastCalledWith(server);
    expect(getAppState().membershipGated).toBe(false);
  });

  it("keeps the view gated after a failed layout check, then retries even though the queue is empty", async () => {
    queuedPlacement(); failCanvas = true;
    expect(await sync()).toMatchObject({ ok: false });
    expect(getAppState().membershipGated).toBe(true); expect(await getPendingWrites()).toEqual([]);
    expect(getAppState().activeCanvas).toEqual(stale);
    failCanvas = false;
    expect(await sync()).toEqual({ ok: true });
    expect(getAppState().activeCanvas).toEqual(server); expect(getAppState().membershipGated).toBe(false);
  });

  it("rechecks a refusal that arrives during the canvas read before releasing the workspace", async () => {
    onCanvasRead = async () => { queuedPlacement(); await flushPendingWrites(); };
    expect(await sync()).toEqual({ ok: true });
    expect(canvasReads).toBe(2); expect(getAppState().activeCanvas).toEqual(server);
    expect(getAppState().membershipGated).toBe(false);
  });
});

describe("bounded workspace-check reads", () => {
  it.each(["/api/sync", "/api/sync/membership"])("releases a stalled %s so a fresh retry can verify membership", async stalledPath => {
    vi.useFakeTimers();
    let rejectStalled: ((error: Error) => void) | undefined;
    let outcome: { ok: boolean } | undefined;
    let running: Promise<unknown> | undefined;
    try {
      setMembershipGated(true);
      apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
        if (path === stalledPath || (stalledPath.endsWith("membership") && path.startsWith(stalledPath))) {
          return new Promise((_, reject) => {
            rejectStalled = reject;
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Read timed out", "AbortError")), { once: true });
          });
        }
        if (path === "/api/sync") return { ...EMPTY(100), membership_epoch: 912 };
        throw new Error("unexpected " + path);
      });
      await act(async () => { running = sync().then(value => { outcome = value; }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
      expect(outcome).toMatchObject({ ok: false });
      expect(getAppState().membershipGated).toBe(true);
      apiMock.mockImplementation(async (path: string) => {
        if (path === "/api/sync") return { ...EMPTY(100), membership_epoch: 913 };
        if (path.startsWith("/api/sync/membership")) return { ids: [], next_cursor: null, epoch: 913, event_cursor: "100" };
        throw new Error("unexpected " + path);
      });
      await act(async () => { expect(await sync()).toEqual({ ok: true }); });
      expect(getAppState().membershipGated).toBe(false);
    } finally {
      rejectStalled?.(new Error("test cleanup"));
      await running;
      vi.useRealTimers();
    }
  });

  it("discards a late uncancellable response after a timeout and successful retry", async () => {
    vi.useFakeTimers();
    let finish!: (delta: SyncDelta) => void;
    let outcome: { ok: boolean } | undefined;
    let running: Promise<unknown> | undefined;
    try {
      setMembershipGated(true);
      apiMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      await act(async () => { running = sync().then(value => { outcome = value; }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
      expect(outcome).toMatchObject({ ok: false });
      expect(getAppState().membershipGated).toBe(true);
      apiMock.mockImplementation(async (path: string) => {
        if (path === "/api/sync") return { ...EMPTY(100), membership_epoch: 914 };
        if (path.startsWith("/api/sync/membership")) return { ids: [], next_cursor: null, epoch: 914, event_cursor: "100" };
        throw new Error("unexpected " + path);
      });
      await act(async () => { expect(await sync()).toEqual({ ok: true }); });
      applySync.mockClear();
      const stale = { ...EMPTY(200), nodes: { upsert: [{ id: "revoked-late-node" } as ContentNode], delete: [] } };
      await act(async () => { finish(stale); });
      expect(applySync).not.toHaveBeenCalled();
      expect(getAppState().membershipGated).toBe(false);
    } finally {
      finish?.(EMPTY(100));
      await running;
      vi.useRealTimers();
    }
  });

});
