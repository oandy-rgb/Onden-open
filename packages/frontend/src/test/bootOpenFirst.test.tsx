// Open first, tidy up in the background (2026-10-30). What the people waiting
// at the first screen need: a cold start paints before the worker has written
// the mirror (the queue is read first, so the paint is not stuck behind the
// write), a mirror that this session just filled from the server does not hide
// the workspace for its first check, and the offline body download does not
// run alongside the check that holds the gate. Everything that makes the gate
// fail-closed stays: a cached copy is gated up front, a differing or failing
// check keeps it up.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { ApiError } from "../lib/api";
import { getAppState, resetAppState, subscribeApp } from "../lib/appStore";
import { getAllMembershipIds, getLastEventId, clearPendingWrite, getPendingWrites, loadBootstrapList, missingBodyIds, persistBootstrap } from "../lib/localDb";
import { SLIM_MODE_NODE_THRESHOLD } from "../lib/slimMode";
import { projectBootstrapForPaint } from "../lib/data/bootPaint";
import { membershipDigestOf, webCryptoSha256 } from "../lib/data/membershipDigest";

const note = (id: string, markdown: string) => ({
  id, title: id, slug: id, markdown, body_len: markdown.length, node_type: "content", source_type: "manual", parent_id: null, hidden: false, order_key: "a0",
});
const bootstrap = (nodes: ReturnType<typeof note>[], bodies = "full") => ({
  bodies, workspace: { id: "ws", name: "T", slug: "default", home_node_id: null },
  nodes, edges: [], tasks: [], suggestions: [], events: [], actor_role: "admin", tags: [], last_event_id: "0",
});

vi.mock("../lib/localDb", () => ({
  initLocalDb: vi.fn(async () => null),
  loadBootstrapList: vi.fn(async () => null),
  loadBootstrapRelations: vi.fn(async () => ({ edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] })),
  loadAttributePage: vi.fn(async () => ({ rows: [], next: null })),
  persistBootstrap: vi.fn(async (data) => data),
  persistRemoteNode: vi.fn(async (node) => node),
  applySync: vi.fn(async (delta) => delta),
  getLastEventId: vi.fn(async () => 0),
  setLastEventId: vi.fn(async () => {}),
  getMembershipEpoch: vi.fn(async () => 0),
  getLastFullRefresh: vi.fn(async () => Date.now()),
  setMembershipEpoch: vi.fn(async () => {}),
  getAllMembershipIds: vi.fn(async () => []),
  getPendingWrites: vi.fn(async () => []),
  bumpPendingWriteAttempt: vi.fn(async () => {}),
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
vi.mock("../lib/data/syncStatus", () => ({ refreshPendingCount: vi.fn(), bumpPending: vi.fn(), setStuckReason: vi.fn() }));

const apiMock = vi.fn();
vi.mock("../lib/api", async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: (...a: unknown[]) => apiMock(...a) };
});

import { useAppData } from "../lib/useAppData";
import { __resetSyncEngineForTests } from "../lib/data/syncEngine";

const emptyDelta = (epoch: number) => ({
  last_event_id: 0, membership_epoch: epoch, nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] },
  tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null,
});

/** Every value `membershipGated` took, in order, from now on. */
function watchGate(): boolean[] {
  const seen: boolean[] = [getAppState().membershipGated];
  subscribeApp(() => { const now = getAppState().membershipGated; if (seen[seen.length - 1] !== now) seen.push(now); });
  return seen;
}

const idleQueue: Array<() => void> = [];
const sha256 = webCryptoSha256();

/** A server whose readable set is `ids` at membership epoch 3, with `nodes` as its bootstrap.
 *  `projection` answers the fetch of notes the device lacks (default: refuses). */
async function serve(ids: string[], nodes: ReturnType<typeof note>[], bodies = "full") {
  const digest = sha256 ? await membershipDigestOf(ids, sha256) : null;
  apiMock.mockImplementation(async (path: string) => {
    const p = String(path);
    if (p.startsWith("/api/canvases")) return [];
    if (p.startsWith("/api/sync/membership/digest")) { if (!digest) throw new ApiError(404, "none"); return { epoch: 3, event_cursor: "0", ...digest }; }
    if (p.startsWith("/api/sync/membership")) return { epoch: 3, event_cursor: "0", ids, next_cursor: null };
    if (p === "/api/sync/nodes") throw new ApiError(500, "boom");
    if (p.startsWith("/api/sync")) return emptyDelta(3);
    if (p.startsWith("/api/bootstrap")) return bootstrap(nodes, bodies);
    if (p.startsWith("/api/nodes/")) return nodes[0];
    throw new Error("unexpected " + p);
  });
}

beforeEach(async () => {
  await __resetSyncEngineForTests();
  resetAppState();
  apiMock.mockReset();
  idleQueue.length = 0;
  (globalThis as Record<string, unknown>).requestIdleCallback = (cb: () => void) => { idleQueue.push(cb); return idleQueue.length; };
  vi.mocked(loadBootstrapList).mockResolvedValue(null);
  vi.mocked(getLastEventId).mockResolvedValue(0);
  vi.mocked(getPendingWrites).mockResolvedValue([]);
  vi.mocked(getAllMembershipIds).mockResolvedValue([]);
  vi.mocked(persistBootstrap).mockClear().mockImplementation(async (data) => data);
  vi.mocked(missingBodyIds).mockClear();
});
afterEach(async () => { await __resetSyncEngineForTests(); });

describe("cold start paints before the mirror is written", () => {
  it("reads the queue first, shows the pending edit, and only then asks the worker to write", async () => {
    const order: string[] = [];
    const queue = [{ id: 1, method: "PATCH", path: "/api/nodes/n1", body: JSON.stringify({ markdown: "typed offline" }), idem_key: "k1", attempts: 0 }];
    vi.mocked(getPendingWrites).mockImplementation(async () => { order.push("queue"); return [...queue] as never; });
    vi.mocked(clearPendingWrite).mockImplementation(async (id) => { queue.splice(queue.findIndex((w) => w.id === id), 1); });
    let finishWrite!: () => void;
    const written = new Promise<void>((resolve) => { finishWrite = resolve; });
    await serve(["n1"], [note("n1", "server text")], "none");
    vi.mocked(getAllMembershipIds).mockResolvedValue(["n1"]);
    // The worker answers with the queue's text applied, as the real one does.
    vi.mocked(persistBootstrap).mockImplementation(async (data) => {
      order.push("write");
      await written;
      return projectBootstrapForPaint(data, await getPendingWrites());
    });
    const { result } = renderHook(() => useAppData());
    try {
      // Typable while the worker is still writing: the data is on screen, the
      // pending edit is not shown reverted, and the gate never rose.
      await waitFor(() => expect(result.current.bootstrapped).toBe(true));
      await waitFor(() => expect(order).toContain("write"));
      expect(order.indexOf("queue")).toBeLessThan(order.indexOf("write"));
      await waitFor(() => expect(result.current.data.nodes[0]?.markdown).toBe("typed offline"));
      expect(getAppState().membershipGated).toBe(false);
    } finally { finishWrite(); }
    await waitFor(() => expect(queue).toHaveLength(0)); // the queued edit was sent once the sync ran
  });
});

describe("the first membership check", () => {
  it.skipIf(!sha256)("a mirror this session just filled from the server is not hidden for its check", async () => {
    await serve(["n1"], [note("n1", "from the server")]);
    vi.mocked(getAllMembershipIds).mockResolvedValue(["n1"]);
    const gate = watchGate();
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(vi.mocked(getAllMembershipIds)).toHaveBeenCalled());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(gate).toEqual([false]);
  });

  it.skipIf(!sha256)("…but the gate rises the moment the server's set differs, and stays while the check fails", async () => {
    await serve(["n1", "n2"], [note("n1", "from the server")]);
    vi.mocked(getAllMembershipIds).mockResolvedValue(["n1"]);
    const gate = watchGate();
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    await waitFor(() => expect(gate).toEqual([false, true]));
    await new Promise((r) => setTimeout(r, 30));
    expect(getAppState().membershipGated).toBe(true);
  });

  it.skipIf(!sha256)("a cached copy is still gated up front, and lifted after the check", async () => {
    await serve(["n1"], [note("n1", "from the server")]);
    vi.mocked(loadBootstrapList).mockResolvedValue(bootstrap([note("n1", "cached")]) as never);
    vi.mocked(getLastEventId).mockResolvedValue(7);
    vi.mocked(getAllMembershipIds).mockResolvedValue(["n1"]);
    const gate = watchGate();
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    await waitFor(() => expect(gate).toEqual([false, true, false]));
    expect(result.current.data.nodes[0]!.markdown).toBe("cached");
  });
});

describe("the offline body download", () => {
  it("starts once the boot check is through, not beside it", async () => {
    const big = bootstrap(Array.from({ length: SLIM_MODE_NODE_THRESHOLD }, (_, i) => note(`n${i}`, "")), "none");
    vi.mocked(loadBootstrapList).mockResolvedValue(big as never);
    vi.mocked(getLastEventId).mockResolvedValue(7);
    const order: string[] = [];
    vi.mocked(missingBodyIds).mockImplementation(async () => { order.push("download"); return { ids: [], next: null }; });
    await serve(["n0"], [note("n0", "")]);
    const served = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, ...rest: unknown[]) => { if (String(path) === "/api/sync") order.push("sync"); return served(path, ...rest); });
    renderHook(() => useAppData());
    await waitFor(() => expect(order).toContain("download"));
    expect(order.indexOf("sync")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("sync")).toBeLessThan(order.indexOf("download"));
  });
});
