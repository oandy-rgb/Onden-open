// Sync engine behaviour when the device's view of the server goes wrong: a
// server that went back in time (#10), a device with no local copy (#8), a
// failed refresh that is not a lost connection (#17), the canvas mirror pruned
// by the server's clock (#19) and a second boot (#20).
import { describe, it, expect, vi, beforeEach } from "vitest";

const setLastEventId = vi.fn(async (..._args: unknown[]) => {});
const getLastEventId = vi.fn(async () => 100);
const getPendingWrites = vi.fn(async () => [] as unknown[]);
const initLocalDb = vi.fn(async (): Promise<unknown> => null);

vi.mock("../lib/localDb", () => ({
  initLocalDb: () => initLocalDb(),
  useMemoryOnlyLocalCopy: vi.fn(() => { void import("../lib/localCopyState").then((m) => m.setLocalCopy("none")); }),
  loadBootstrapList: vi.fn(async () => null),
  loadBootstrapRelations: vi.fn(async () => ({ edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] })),
  loadAttributePage: vi.fn(async () => ({ rows: [], next: null })),
  persistBootstrap: vi.fn(async (data) => data),
  persistRemoteNode: vi.fn(async (node) => node),
  getStoredBody: vi.fn(async () => null),
  applySync: vi.fn(async (delta) => delta),
  getLastEventId: () => getLastEventId(),
  setLastEventId: (id: number | string) => setLastEventId(id),
  getAllMembershipIds: vi.fn(async () => [] as string[]),
  getMembershipEpoch: vi.fn(async () => 0),
  setMembershipEpoch: vi.fn(async () => {}),
  getPendingWrites: () => getPendingWrites(),
  getLastFullRefresh: vi.fn(async () => 0),
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

import { dataSync } from "../lib/data";
import { getIncomingProblem, setIncomingProblem } from "../lib/data/incomingStatus";
import { ApiError } from "../lib/api";
import { canvasWriter } from "../lib/data/domainWriters";
import { getAppState, resetAppState, subscribeApp } from "../lib/appStore";
import { createHash } from "node:crypto";
import { applySync, getAllMembershipIds, getMembershipEpoch, setMembershipEpoch, useMemoryOnlyLocalCopy } from "../lib/localDb";
import { _resetLocalCopyForTests, setLocalCopy } from "../lib/localCopyState";
import { bindAccountStorage } from "../lib/accountStorage";
import type { Bootstrap, ContentNode } from "../lib/api";

const EMPTY = (last: number, head?: string) => ({
  last_event_id: last, ...(head === undefined ? {} : { head_event_id: head }),
  nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] },
  tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] },
  workspace: null,
});
const note: ContentNode = { id: "n1", title: "from the server", markdown: "x", source_type: "manual", node_type: "content", slug: "n1" };
const remote = (extra: Partial<Bootstrap> = {}): Bootstrap => ({
  workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes: [note], edges: [], tasks: [], suggestions: [], events: [], last_event_id: "120", ...extra,
});

beforeEach(async () => {
  bindAccountStorage("u", "");
  await canvasWriter.select(null);
  resetAppState();
  _resetLocalCopyForTests();
  apiMock.mockReset();
  setLastEventId.mockClear();
  getLastEventId.mockReset().mockResolvedValue(100);
  getPendingWrites.mockReset().mockResolvedValue([]);
  initLocalDb.mockReset().mockResolvedValue(null);
  vi.mocked(setMembershipEpoch).mockReset();
  vi.mocked(useMemoryOnlyLocalCopy).mockClear();
});

describe("a server that went back in time (#10)", () => {
  it("a cursor past the server's head resets to the head and starts over from a whole bootstrap", async () => {
    getLastEventId.mockResolvedValue(9000);
    const asked: unknown[] = [];
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/sync") {
        const since = JSON.parse(String(init?.body)).since;
        asked.push(since);
        return since === 9000 ? EMPTY(9000, "120") : EMPTY(120, "120");
      }
      if (path.startsWith("/api/bootstrap")) return remote();
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect(setLastEventId).toHaveBeenCalledWith("120");
    expect(asked).toEqual([9000, "120"]); // the second pull starts at the server's position
    expect(apiMock.mock.calls.some(([path]) => String(path).startsWith("/api/bootstrap"))).toBe(true);
    expect(getAppState().data.nodes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("a cursor at or before the head is left alone (no bootstrap)", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/sync") return EMPTY(100, "100");
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect(apiMock.mock.calls.some(([path]) => String(path).startsWith("/api/bootstrap"))).toBe(false);
    expect(setLastEventId).not.toHaveBeenCalled();
  });
});

describe("a device with no local copy (#8)", () => {
  it("boot gives up on the copy, says so, and still shows the server's data", async () => {
    initLocalDb.mockRejectedValue(new Error("IndexedDB blocked"));
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/bootstrap")) return remote();
      if (path.startsWith("/api/sync")) return EMPTY(120, "120");
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    await dataSync.boot();
    expect(useMemoryOnlyLocalCopy).toHaveBeenCalledTimes(1);
    expect(getAppState().data.nodes.map((n) => n.title)).toEqual(["from the server"]);
    expect(getAppState().online).toBe(true);
  });

  it("sync() with no copy is a whole bootstrap: no delta, no cursor, and the gate comes down", async () => {
    setLocalCopy("none");
    resetAppState({ membershipGated: true });
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/bootstrap")) return remote();
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect(apiMock.mock.calls.some(([path]) => path === "/api/sync")).toBe(false);
    expect(setLastEventId).not.toHaveBeenCalled();
    expect(getAppState().data.nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(getAppState().membershipGated).toBe(false);
  });

  it("sync() with no copy reports not-ok when the bootstrap fails", async () => {
    setLocalCopy("none");
    apiMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await dataSync.sync()).toMatchObject({ ok: false });
  });
});

describe("refresh() failures (#17)", () => {
  it("a failure that is not a lost connection leaves the connection state alone", async () => {
    resetAppState({ online: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    apiMock.mockRejectedValue(new Error("could not decode the bootstrap"));
    await dataSync.refresh();
    expect(getAppState().online).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a server that cannot be reached still means offline", async () => {
    resetAppState({ online: true });
    apiMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await dataSync.refresh();
    expect(getAppState().online).toBe(false);
  });
});

describe("the canvas mirror is pruned by the server's clock (#19)", () => {
  it("passes the bootstrap's server_time, not this device's clock", async () => {
    const prune = vi.spyOn(canvasWriter, "pruneMirror").mockResolvedValue(undefined);
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/bootstrap")) return remote({ server_time: "2026-10-24T09:00:00.000Z" });
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    await dataSync.refresh();
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune.mock.calls[0]![1]).toBe("2026-10-24T09:00:00.000Z");
    prune.mockRestore();
  });

  it("from a server that sends none, the mirror is left as it is", async () => {
    const prune = vi.spyOn(canvasWriter, "pruneMirror").mockResolvedValue(undefined);
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/bootstrap")) return remote();
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    await dataSync.refresh();
    expect(prune).not.toHaveBeenCalled();
    prune.mockRestore();
  });
});

describe("a second boot (#20)", () => {
  it("releases a sync() that was waiting on the first boot instead of leaving it hanging", async () => {
    let openCopy!: () => void;
    initLocalDb.mockReturnValue(new Promise((resolve) => { openCopy = () => resolve(null); })); // both boots stop at opening the copy
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/sync") return EMPTY(100, "100");
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("offline for test");
    });
    const first = dataSync.boot();
    const waiting = dataSync.sync(); // waits for the first boot's cursor
    const second = dataSync.boot();
    await expect(waiting).resolves.toEqual({ ok: true });
    openCopy(); // let both boots end, so no later test waits on their cursor
    await Promise.all([first, second]);
  });
});

describe("the permission gate on an epoch change (#6)", () => {
  const EMPTY_SET_DIGEST = createHash("sha256").update("", "utf8").digest("hex");
  function serverAtEpoch(epoch: number) {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/sync") return { ...EMPTY(100, "100"), membership_epoch: epoch };
      if (path.startsWith("/api/sync/membership/digest")) {
        return { epoch, event_cursor: "100", count: 0, digest: EMPTY_SET_DIGEST, buckets: {}, tags: [] };
      }
      if (path.startsWith("/api/sync/membership")) return { ids: [], next_cursor: null, epoch, event_cursor: "100" };
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
  }
  /** Every value the gate took while `run` ran. */
  async function gateDuring(run: () => Promise<unknown>): Promise<boolean[]> {
    const seen: boolean[] = [];
    let previous = getAppState().membershipGated;
    const stop = subscribeApp(() => { const g = getAppState().membershipGated; if (g !== previous) { previous = g; seen.push(g); } });
    try { await run(); } finally { stop(); }
    return seen;
  }

  it("after the session's first check, a changed epoch whose digest matches never raises the gate", async () => {
    vi.mocked(getAllMembershipIds).mockResolvedValue([]);
    serverAtEpoch(5);
    vi.mocked(getMembershipEpoch).mockResolvedValue(0);
    expect(await dataSync.sync()).toEqual({ ok: true }); // the first check of the session may lock
    serverAtEpoch(6);
    vi.mocked(getMembershipEpoch).mockResolvedValue(5);
    const gate = await gateDuring(() => dataSync.sync());
    expect(gate).toEqual([]); // never raised
    expect(vi.mocked(setMembershipEpoch)).toHaveBeenLastCalledWith(6);
  });

  it("a differing set raises the gate before anything is removed, and the check lowers it", async () => {
    vi.mocked(getAllMembershipIds).mockResolvedValue(["ab-held-but-revoked"]);
    serverAtEpoch(7);
    vi.mocked(getMembershipEpoch).mockResolvedValue(6);
    let gateWhenRemoving: boolean | null = null;
    vi.mocked(applySync).mockImplementation(async (delta) => { gateWhenRemoving = getAppState().membershipGated; return delta; });
    const gate = await gateDuring(() => dataSync.sync());
    expect(gateWhenRemoving).toBe(true);
    expect(gate).toEqual([true, false]);
  });

  it("a check that fails midway leaves the gate raised", async () => {
    vi.mocked(getAllMembershipIds).mockResolvedValue([]);
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/sync") return { ...EMPTY(100, "100"), membership_epoch: 9 };
      if (path.startsWith("/api/sync/membership")) throw new TypeError("Failed to fetch");
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    vi.mocked(getMembershipEpoch).mockResolvedValue(8);
    expect(await dataSync.sync()).toMatchObject({ ok: false });
    expect(getAppState().membershipGated).toBe(true);
  });
});

describe("the server's newer content stops arriving (the sync status says so)", () => {
  beforeEach(() => setIncomingProblem(null));

  it("a sync the server refuses is a problem; the next good sync clears it", async () => {
    apiMock.mockRejectedValue(new ApiError(500, "{}"));
    expect(await dataSync.sync()).toMatchObject({ ok: false });
    expect(getIncomingProblem()).toBe("refused");
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/sync") return EMPTY(100, "100");
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect(getIncomingProblem()).toBeNull();
  });

  it("a sync that cannot reach the server is told apart from a refusal", async () => {
    apiMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await dataSync.sync()).toMatchObject({ ok: false, unreachable: true });
    expect(getIncomingProblem()).toBe("unreachable");
  });
});
