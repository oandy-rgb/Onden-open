// slim-bootstrap-clobber: after the slim (?bodies=none) first paint, the FULL
// /api/bootstrap hydration must NOT run inline in the same init tick (doing so
// immediately clobbers the slim payload and throws away the memory/latency
// win). It is deferred to idle — the slim shell paints first, then the full
// bodies land once the main thread is quiet. When nothing painted at all
// (no local cache AND the slim fetch failed) the full fetch still runs inline.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

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
import { resetAppState } from "../lib/appStore";

// Take manual control of idle scheduling so we can observe the post-slim,
// pre-idle state deterministically (the default polyfill fires too fast to
// catch the transient slim window via waitFor).
let idleQueue: Array<() => void> = [];
const flushIdle = () => { const q = idleQueue; idleQueue = []; for (const cb of q) cb(); };

const slimBoot = {
  bodies: "none",
  workspace: { id: "ws", name: "T", slug: "default", home_node_id: null },
  nodes: [{ id: "n1", title: "Note 1", slug: "n-1", markdown: "", body_len: 50, node_type: "content", source_type: "manual", parent_id: null, hidden: false, order_key: "a0" }],
  edges: [], tasks: [], suggestions: [], events: [], actor_role: "admin", tags: [],
};

beforeEach(() => {
  // The app store is a module singleton: without this, a test that runs after
  // another inherits its online / bootstrapped / bodies and its waitFor passes
  // on the stale value (tests run in shuffled order).
  resetAppState();
  apiMock.mockReset();
  idleQueue = [];
  (globalThis as Record<string, unknown>).requestIdleCallback = (cb: () => void) => { idleQueue.push(cb); return idleQueue.length; };
});

describe("slim-bootstrap defer (slim-bootstrap-clobber)", () => {
  it("does NOT fetch the full bootstrap inline after a slim paint, but hydrates on idle", async () => {
    let fullHits = 0;
    let slimDoneAt = -1;
    let order = 0;
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.startsWith("/api/bootstrap?bodies=none")) { slimDoneAt = order++; return structuredClone(slimBoot); }
      if (p.startsWith("/api/bootstrap")) {
        fullHits++;
        // the full fetch must land AFTER the slim one (idle-deferred), never
        // racing it inside the same init tick
        expect(slimDoneAt).toBeGreaterThanOrEqual(0);
        return { ...structuredClone(slimBoot), bodies: "full", nodes: slimBoot.nodes.map((n) => ({ ...n, markdown: "full body" })) };
      }
      if (p.startsWith("/api/canvases")) return [];
      if (p.startsWith("/api/sync")) return { last_event_id: 0, nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
      throw new Error("unexpected " + p);
    });

    const { result } = renderHook(() => useAppData());

    // Slim paint arrives and the shell is interactive with bodies stripped.
    await waitFor(() => expect(result.current.data.bodies).toBe("none"));
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    // Critically: the full hydration is QUEUED for idle, not fired inline — the
    // slim payload still owns the store, so the memory/latency win holds.
    expect(fullHits).toBe(0);
    expect(result.current.data.nodes[0].markdown).toBe("");
    expect(idleQueue.length).toBe(1);

    // Once the browser goes idle, the full payload lands and body availability
    // is restored.
    await act(async () => { flushIdle(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.data.bodies).toBe("full"));
    expect(result.current.data.nodes[0].markdown).toBe("full body");
    // EXACTLY ONE full /api/bootstrap (the deferred one). The online-transition
    // effect must NOT have fired a second one off the boot online flip — that
    // duplicate refresh was the original clobber.
    await act(async () => { await Promise.resolve(); });
    expect(fullHits).toBe(1);
  }, 15_000);

  it("a genuine offline→online transition (after offline boot) DOES full-refresh", async () => {
    // Boot offline: slim AND full both fail, app stays offline. The first
    // online flip later is a real transition and must pull a full bootstrap.
    let online = false;
    let fullHits = 0;
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      if (!online) throw new Error("offline for test");
      if (p.startsWith("/api/bootstrap?bodies=none")) return structuredClone(slimBoot);
      if (p.startsWith("/api/bootstrap")) { fullHits++; return { ...structuredClone(slimBoot), bodies: "full", nodes: slimBoot.nodes.map((n) => ({ ...n, markdown: "full body" })) }; }
      if (p.startsWith("/api/canvases")) return [];
      if (p.startsWith("/api/sync")) return { last_event_id: 0, nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
      throw new Error("unexpected " + p);
    });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    expect(result.current.online).toBe(false);
    expect(fullHits).toBe(0);

    // Now the network returns and the browser fires its online event.
    online = true;
    await act(async () => { window.dispatchEvent(new Event("online")); await Promise.resolve(); });
    await waitFor(() => expect(fullHits).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(result.current.data.bodies).toBe("full"));
  }, 15_000);

  it("hydrates the full bootstrap INLINE when no shell painted (slim failed, no local cache)", async () => {
    apiMock.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p.startsWith("/api/bootstrap?bodies=none")) throw new Error("slim blocked for test");
      if (p.startsWith("/api/bootstrap")) return { ...structuredClone(slimBoot), bodies: "full", nodes: slimBoot.nodes.map((n) => ({ ...n, markdown: "full body" })) };
      if (p.startsWith("/api/canvases")) return [];
      if (p.startsWith("/api/sync")) return { last_event_id: 0, nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
      throw new Error("unexpected " + p);
    });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.data.bodies).toBe("full"));
    expect(result.current.data.nodes[0].markdown).toBe("full body");
  }, 15_000);
});
