// The server went back under the SAME identity (a disk or VM snapshot restored, a pg_restore that kept the node id):
// an answer read below what this device knew when its request left (lib/data/writePositions.ts serverWentBack: the
// page's watermark, the shared copy's as learnt, the request's cursor). One such answer is the proof: the watermark starts
// over in the page and in the copy, a rebuild is owed until a whole bootstrap is taken (kept in the copy), the person is
// told once, membership is checked from the start. An answer merely late is only refused (#1794 review, rounds 3–4).
// The copy here is a fake that keeps its watermark, cursor and owed rebuild and judges answers the way the worker does
// (judgeAnswer); src/test/serverRolledBackRealCopy.test.tsx runs the same recovery over the real worker.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { READ_HEAD_HEADER } from "@onden/markdown/contract";

const copy = vi.hoisted(() => ({
  watermark: null as string | null, server: null as string | null, cursor: 0, forgotten: 0, owed: false,
  forgetFails: 0,
  pending: [] as Array<{ id: number; method: string; path: string; body: string | null; idem_key: string | null; attempts: number }>,
}));
const below = vi.hoisted(() => (head: string | number | undefined, serverId: string | undefined) =>
  copy.watermark !== null && head !== undefined && (serverId === undefined || copy.server === null || serverId === copy.server) && BigInt(head) < BigInt(copy.watermark));
const raise = vi.hoisted(() => (position: string | number) => {
  if (copy.watermark === null || BigInt(position) > BigInt(copy.watermark)) copy.watermark = String(position);
});
/** The copy's judgeAnswer for a bootstrap: one from the same identity below the watermark is refused (with the copy's
 *  watermark); a taken one sets the cursor to where it was read, and a whole one pays the owed rebuild. */
const judgedBootstrap = vi.hoisted(() => async (data: { last_event_id: string; server_id?: string; nodes_omitted?: boolean }) => {
  if (below(data.last_event_id, data.server_id)) return { ...data, answer_stale: true as const, answer_watermark: copy.watermark, answer_server: copy.server };
  copy.server = data.server_id ?? copy.server;
  raise(data.last_event_id);
  if (data.nodes_omitted !== true) { copy.cursor = Number(data.last_event_id); copy.owed = false; }
  return data;
});
const judgedDelta = vi.hoisted(() => async (d: { head_event_id?: string; server_id?: string }) => {
  if (below(d.head_event_id, d.server_id)) return { ...d, stale: true as const, answer_watermark: copy.watermark, answer_server: copy.server };
  if (d.head_event_id !== undefined) raise(d.head_event_id);
  return d;
});

vi.mock("../lib/localDb", () => ({
  getWatermark: async () => ({ position: copy.watermark, server: copy.server, rebuildOwed: copy.owed }),
  raiseWatermark: async (position: string) => { raise(position); },
  rewindCursor: async () => {},
  forgetCopyWatermark: async () => {
    if (copy.forgetFails > 0) { copy.forgetFails--; throw new Error("the copy could not be saved"); }
    const alreadyOwed = copy.owed;
    copy.watermark = null; copy.owed = true; copy.forgotten++;
    return { alreadyOwed };
  },
  initLocalDb: vi.fn(async () => null),
  loadBootstrapList: vi.fn(async () => ({
    workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
    nodes: [{ id: "n1", title: "held here", markdown: "x", source_type: "manual", node_type: "content", slug: "n1" }],
    edges: [], tasks: [], suggestions: [], events: [], last_event_id: String(copy.cursor),
  })),
  loadBootstrapRelations: vi.fn(async () => ({ edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] })),
  loadAttributePage: vi.fn(async () => ({ rows: [], next: null })),
  persistBootstrap: vi.fn(),
  persistRemoteNode: vi.fn(async (node, head?: string, serverId?: string) => {
    // Another log than the copy's: refused, with the copy's own watermark and identity (the page must not learn it).
    if (serverId !== undefined && copy.server !== null && serverId !== copy.server) return { ...node, answer_stale: true, answer_watermark: copy.watermark, answer_server: copy.server };
    if (head !== undefined && below(head, serverId)) return { ...node, answer_stale: true, answer_watermark: copy.watermark, answer_server: copy.server };
    if (head !== undefined) raise(head);
    return node;
  }),
  getStoredBody: vi.fn(async () => null),
  applySync: vi.fn(),
  getLastEventId: vi.fn(async () => copy.cursor),
  setLastEventId: vi.fn(async (id: number | string) => { if (Number(id) > copy.cursor) copy.cursor = Number(id); }),
  getAllMembershipIds: vi.fn(async () => [] as string[]),
  getMembershipEpoch: vi.fn(async () => 1),
  setMembershipEpoch: vi.fn(async () => {}),
  getPendingWrites: vi.fn(async () => copy.pending.map((w) => ({ ...w }))),
  clearPendingWrite: vi.fn(async (id: number) => { copy.pending = copy.pending.filter((w) => w.id !== id); }),
  bumpPendingWriteAttempt: vi.fn(async () => 1),
  catchUpWithOtherTabs: vi.fn(async () => {}),
  getOldestPendingWriteAt: vi.fn(async () => null),
  getLastFullRefresh: vi.fn(async () => Date.now()),
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
vi.mock("../lib/data/syncStatus", () => ({ refreshPendingCount: vi.fn(), bumpPending: vi.fn() }));

const apiMock = vi.fn();
vi.mock("../lib/api", async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: (...a: unknown[]) => apiMock(...a) };
});

import { dataSync } from "../lib/data";
import { applySync, getAllMembershipIds, loadBootstrapList, persistBootstrap } from "../lib/localDb";
import { ApiError } from "../lib/api";
import { __resetSyncEngineForTests, hydrateNode, refresh, refreshMeta } from "../lib/data/syncEngine";
import { getAppState, resetAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { _resetLocalCopyForTests } from "../lib/localCopyState";
import { declareLocalOnlyHost } from "../lib/localOnlyStatus";
import { forgetWatermark, pageWouldTake, startWatermarkFrom, syncPassEnded } from "../lib/data/writePositions";

const SERVER = "s1";
const RESTORED_HEAD = "120";
const note = (title: string) => ({ id: "n1", title, markdown: "x", source_type: "manual", node_type: "content", slug: "n1" });
const delta = (last: number | string, head: string, rows: unknown[] = [], extra: object = {}) => ({
  last_event_id: Number(last), head_event_id: head, server_id: SERVER,
  nodes: { upsert: rows, delete: [] }, edges: { upsert: [], delete: [] },
  tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null, ...extra,
});
const bootstrap = (head = RESTORED_HEAD) => ({
  workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes: [note("from the restored server")], edges: [], tasks: [], suggestions: [], events: [], last_event_id: head, server_id: SERVER,
});
/** The restored server: its log ends at 120; this device was told of writes up to 9000 before the restore. A sync from a
 *  cursor past 120 is answered as the server does (an empty page at the asked cursor). */
function restoredServer(extra: object = {}) {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/sync") {
      const since = Number(JSON.parse(String(init?.body)).since);
      return since >= Number(RESTORED_HEAD) ? delta(since, RESTORED_HEAD, [], extra) : delta(RESTORED_HEAD, RESTORED_HEAD, [note("from the restored server")], extra);
    }
    if (path.startsWith("/api/bootstrap")) return bootstrap();
    if (path.startsWith("/api/sync/membership/digest")) return { epoch: 1, event_cursor: RESTORED_HEAD };
    if (path.startsWith("/api/sync/membership")) return { ids: ["n1"], next_cursor: null, epoch: 1, event_cursor: RESTORED_HEAD };
    if (path.startsWith("/api/canvases")) return [];
    if (init?.method === "PATCH") return { id: "n1", title: "typed before the restore was noticed" };
    return {};
  });
}
const calls = (prefix: string) => apiMock.mock.calls.filter(([path]) => String(path).startsWith(prefix)).length;
/** Whole bootstraps (a rebuild); a ?nodes=none refresh (a reconnect left by an earlier test may ask one) is not one. */
const bootstraps = () => apiMock.mock.calls.filter(([path]) => String(path).startsWith("/api/bootstrap") && !String(path).includes("nodes=none")).length;
const warnings = () => getAppState().toasts.filter((t) => t.kind === "warning").length;

/** A page whose copy holds `state` (as after a reload); the page starts from the copy's watermark. */
function deviceKnows(state: Partial<typeof copy>, page: "from the copy" | "nothing" = "from the copy") {
  Object.assign(copy, state);
  forgetWatermark();
  if (page === "from the copy") startWatermarkFrom({ position: copy.watermark, server: copy.server });
}

beforeEach(async () => {
  await __resetSyncEngineForTests();
  bindAccountStorage("u", "");
  forgetWatermark();
  syncPassEnded();
  resetAppState();
  _resetLocalCopyForTests();
  apiMock.mockReset();
  Object.assign(copy, { watermark: "9000", server: SERVER, cursor: 9000, forgotten: 0, owed: false, forgetFails: 0, pending: [] });
  startWatermarkFrom({ position: copy.watermark, server: copy.server });
  vi.mocked(persistBootstrap).mockReset().mockImplementation(judgedBootstrap as never);
  vi.mocked(applySync).mockReset().mockImplementation(judgedDelta as never);
  vi.mocked(getAllMembershipIds).mockReset().mockResolvedValue(["n1"]);
  restoredServer();
});

describe("the server went back under the same identity", () => {
  it("cursor past the head: an open session comes back in one pass — the watermark starts over, the person is told, one bootstrap", async () => {
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect(copy.forgotten).toBe(1);
    expect(pageWouldTake(RESTORED_HEAD, SERVER)).toBe(true);
    expect(warnings()).toBe(1);
    expect(bootstraps()).toBe(1);
    expect(getAppState().data.nodes.map((n) => n.title)).toEqual(["from the restored server"]);
    expect([copy.cursor, copy.owed]).toEqual([120, false]); // the cursor went back in persistBootstrap
  });

  it("cursor at the head, watermark above it (an empty delta): recovered in one pass", async () => {
    deviceKnows({ watermark: "9000", cursor: 120 });
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect([copy.forgotten, warnings(), bootstraps()]).toEqual([1, 1, 1]);
  });

  it("this page knows little but the shared copy knows 9000 (another tab, the installed app): recovered in one pass", async () => {
    deviceKnows({ watermark: "9000", cursor: 100 }, "nothing");
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect([copy.forgotten, warnings(), bootstraps()]).toEqual([1, 1, 1]);
    expect(getAppState().data.nodes.map((n) => n.title)).toEqual(["from the restored server"]);
  });

  it("same, with nothing new on the server (an empty delta the copy never sees): the pass's start tells the page what the copy knows", async () => {
    deviceKnows({ watermark: "9000", cursor: 120 }, "nothing");
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect([copy.forgotten, warnings(), bootstraps()]).toEqual([1, 1, 1]);
  });

  it("an idle tab whose copy another tab raises during the pass: the copy's refusal is learnt, the next ask proves it", async () => {
    deviceKnows({ watermark: "100", cursor: 100 });
    vi.mocked(applySync).mockImplementationOnce((async (d: never) => { copy.watermark = "9000"; return judgedDelta(d); }) as never);
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect([copy.forgotten, warnings(), bootstraps()]).toEqual([1, 1, 1]);
  });

  it("membership is checked again from the start after the going back (the delta carries an epoch)", async () => {
    deviceKnows({ watermark: "100", cursor: 100 });
    restoredServer({ membership_epoch: 1 });
    // A healthy server at 120 first: the session's first check runs, the next pass needs none.
    copy.watermark = "100";
    expect(await dataSync.sync()).toEqual({ ok: true });
    const checks = () => calls("/api/sync/membership");
    const first = checks();
    expect(first).toBeGreaterThan(0);
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect(checks()).toBe(first);
    // Then it goes back below what this device was told (another save acknowledged at 9000 before the restore).
    startWatermarkFrom({ position: "9000", server: SERVER });
    copy.watermark = "9000";
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect(copy.forgotten).toBe(1);
    expect(checks()).toBeGreaterThan(first);
  });

  it("a reload lets the person in: the gate comes down once the check finishes, the note is there, the queued write is sent", async () => {
    copy.pending = [{ id: 1, method: "PATCH", path: "/api/nodes/n1", body: JSON.stringify({ title: "typed before the restore was noticed" }), idem_key: "k1", attempts: 0 }];
    await dataSync.boot();
    await vi.waitFor(() => expect(getAppState().membershipGated).toBe(false));
    expect(copy.forgotten).toBe(1);
    expect(getAppState().data.nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(apiMock.mock.calls.some(([path, init]) => path === "/api/nodes/n1" && (init as RequestInit | undefined)?.method === "PATCH")).toBe(true);
    expect(bootstraps()).toBe(1);
  });

  it("a cold boot whose first bootstrap is below the copy's watermark: the same recovery, not offline", async () => {
    vi.mocked(loadBootstrapList).mockResolvedValueOnce(null);
    deviceKnows({ watermark: "9000", cursor: 0 });
    await dataSync.boot();
    await vi.waitFor(() => expect(getAppState().membershipGated).toBe(false));
    expect(getAppState().online).toBe(true);
    expect([copy.forgotten, warnings()]).toEqual([1, 1]);
    expect(getAppState().data.nodes.map((n) => n.title)).toEqual(["from the restored server"]);
  });

  it("the bootstrap after the going back fails (cursor ≤ head): the rebuild is still owed, the next pass does it, told once", async () => {
    deviceKnows({ watermark: "9000", cursor: 120 });
    let down = true;
    const serve = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/bootstrap") && down) { down = false; throw new TypeError("Failed to fetch"); }
      return serve(path, init);
    });
    expect((await dataSync.sync()).ok).toBe(false);
    expect([copy.owed, copy.watermark]).toEqual([true, null]);
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect(bootstraps()).toBe(2); // the rebuild happened although nothing is below a watermark any more
    expect([copy.owed, copy.forgotten, warnings()]).toEqual([false, 1, 1]);
  });

  it("another tab found the going back first (the copy owes the rebuild): this tab recovers too, and the person is not told again", async () => {
    Object.assign(copy, { watermark: null, owed: true }); // tab A forgot the copy's watermark and told the person
    // This tab still holds the watermark it had (9000): its own bootstrap is below it, judged again here.
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect([warnings(), copy.owed, bootstraps()]).toEqual([0, false, 1]);
    expect(pageWouldTake(RESTORED_HEAD, SERVER)).toBe(true);
  });

  it("the copy cannot record the going back: nothing starts over in the page either; the next pass recovers", async () => {
    copy.forgetFails = 1;
    expect((await dataSync.sync()).ok).toBe(false);
    expect([copy.forgotten, warnings(), bootstraps()]).toEqual([0, 0, 0]);
    expect(pageWouldTake(RESTORED_HEAD, SERVER)).toBe(false); // the page kept its watermark
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect([copy.forgotten, warnings(), bootstraps()]).toEqual([1, 1, 1]);
  });

  it("a pending membership check whose pages are refused keeps the gate up: only a finished check lowers it", async () => {
    // Another tab keeps acknowledging writes, so the shared copy refuses this tab's membership pages (applySync stale).
    deviceKnows({ watermark: "100", cursor: 100 });
    vi.mocked(getAllMembershipIds).mockResolvedValue(["n9"]); // held here, gone from the server's readable set
    vi.mocked(applySync).mockImplementation(async (d) => ({ ...(d as object), stale: true }) as never);
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/sync") {
        const since = JSON.parse(String(init?.body)).since;
        return delta(Number(since) < 120 ? 120 : since, "120", [], { membership_epoch: 1 });
      }
      if (path.startsWith("/api/sync/membership/digest")) throw new ApiError(404, "{}");
      if (path.startsWith("/api/sync/membership")) return { ids: [], next_cursor: null, epoch: 1, event_cursor: "120" };
      if (path.startsWith("/api/canvases")) return [];
      return {};
    });
    resetAppState({ membershipGated: true });
    expect((await dataSync.sync()).ok).toBe(false);
    expect(getAppState().membershipGated).toBe(true);
    expect(copy.forgotten).toBe(0);
  });

  it("a whole bootstrap refused every time (the copy keeps being raised past it) keeps the gate up", async () => {
    // The server asks for a whole bootstrap; another tab is acknowledged past each one the copy is handed.
    deviceKnows({ watermark: "100", cursor: 100 });
    let head = 120;
    vi.mocked(persistBootstrap).mockImplementation((async (data: { last_event_id: string }) => {
      copy.watermark = String(Number(data.last_event_id) + 10);
      return judgedBootstrap(data);
    }) as never);
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/sync") return { ...delta(100, "120"), resync_required: true };
      if (path.startsWith("/api/bootstrap")) return bootstrap(String(head += 10));
      if (path.startsWith("/api/canvases")) return [];
      return {};
    });
    resetAppState({ membershipGated: true });
    expect((await dataSync.sync()).ok).toBe(false);
    expect(getAppState().membershipGated).toBe(true);
    expect(copy.forgotten).toBe(0); // late every time, never below what was known when asked
  });
});

describe("found outside the sync loop, or another identity", () => {
  it("another identity whose first rebuild fails: the next pass rebuilds first, and nobody is told the server went back", async () => {
    let down = true;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/sync") {
        const since = Number(JSON.parse(String(init?.body)).since);
        return { ...delta(Math.max(since, 300), "300"), server_id: "s2" };
      }
      if (path.startsWith("/api/bootstrap")) {
        if (down) { down = false; throw new TypeError("Failed to fetch"); }
        return { ...bootstrap("300"), server_id: "s2" };
      }
      if (path.startsWith("/api/canvases")) return [];
      return {};
    });
    expect((await dataSync.sync()).ok).toBe(false);
    expect([warnings(), copy.server]).toEqual([0, SERVER]); // the copy still counts in the old log, its cursor 9000
    expect(await dataSync.sync()).toEqual({ ok: true }); // rebuilt before that cursor is judged against the new log
    expect([warnings(), bootstraps(), copy.server, copy.cursor]).toEqual([0, 2, "s2", 300]);
  });

  it("a bootstrap outside sync() that is below what this device knew: a pass starts by itself and checks membership again", async () => {
    deviceKnows({ watermark: "100", cursor: 120 });
    restoredServer({ membership_epoch: 1 });
    expect(await dataSync.sync()).toEqual({ ok: true }); // the session's first check
    const checks = () => calls("/api/sync/membership");
    const first = checks();
    startWatermarkFrom({ position: "9000", server: SERVER }); // a save acknowledged at 9000 before the restore
    copy.watermark = "9000";
    await refresh(); // the whole bootstrap (a reopen, the daily refresh) finds it
    expect([copy.forgotten, warnings()]).toEqual([1, 1]);
    // Nobody calls sync() here: the going back asked for the pass itself.
    await vi.waitFor(() => expect(checks()).toBeGreaterThan(first));
  });

  it("found by a single read while a pass is already past its start: another pass runs after it", async () => {
    deviceKnows({ watermark: "100", cursor: 120 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let syncs = 0;
    apiMock.mockImplementation(async (path: string, init?: RequestInit & { onHeaders?: (h: Headers) => void }) => {
      if (path === "/api/sync") { if (syncs++ === 0) await held; return delta(Math.max(Number(JSON.parse(String(init?.body)).since), 120), RESTORED_HEAD); }
      if (path === "/api/nodes/n1") { init?.onHeaders?.(new Headers({ [READ_HEAD_HEADER]: RESTORED_HEAD, "X-Onden-Read-Server": SERVER })); return note("restored"); }
      if (path.startsWith("/api/bootstrap")) return bootstrap();
      if (path.startsWith("/api/canvases")) return [];
      return {};
    });
    const pass = dataSync.sync(); // its start (the owed rebuild) is behind it
    await vi.waitFor(() => expect(syncs).toBe(1));
    startWatermarkFrom({ position: "9000", server: SERVER });
    copy.watermark = "9000";
    await hydrateNode("n1"); // proves it: below 9000
    expect(copy.owed).toBe(true);
    release();
    await pass;
    await vi.waitFor(() => expect([bootstraps(), copy.owed]).toEqual([1, false])); // the next pass rebuilt
  });

  it("a single read from another identity (the server was restored with the restore script): no word, the next pass rebuilds", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit & { onHeaders?: (h: Headers) => void }) => {
      if (path === "/api/nodes/n1") { init?.onHeaders?.(new Headers({ [READ_HEAD_HEADER]: "300", "X-Onden-Read-Server": "s2" })); return note("from s2"); }
      if (path === "/api/sync") return { ...delta(Math.max(Number(JSON.parse(String(init?.body)).since), 300), "300"), server_id: "s2" };
      if (path.startsWith("/api/bootstrap")) return { ...bootstrap("300"), server_id: "s2" };
      if (path.startsWith("/api/canvases")) return [];
      return {};
    });
    await hydrateNode("n1"); // read before the first s2 delta is judged
    expect(warnings()).toBe(0);
    await vi.waitFor(() => expect([copy.server, copy.cursor]).toEqual(["s2", 300]));
    expect(warnings()).toBe(0);
  });

  it("the copy refuses in another log (page on s2, copy still on s1 at 9000): its watermark is not learnt", async () => {
    forgetWatermark("s2"); // the page took s2's identity; the copy did not yet
    const read = () => apiMock.mockImplementation(async (path: string, init?: RequestInit & { onHeaders?: (h: Headers) => void }) => {
      if (path === "/api/nodes/n1") { init?.onHeaders?.(new Headers({ [READ_HEAD_HEADER]: "300", "X-Onden-Read-Server": "s2" })); return note("from s2"); }
      throw new TypeError("Failed to fetch");
    });
    read();
    await hydrateNode("n1"); // the copy (s1, 9000) refuses it
    expect(pageWouldTake("300", "s2")).toBe(true); // 9000 of s1 was not taken into s2's watermark
    expect(warnings()).toBe(0);
  });

  it("a single note read that proves it keeps the proof: the rebuild is owed and the person told, whatever the next sync sees", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit & { onHeaders?: (h: Headers) => void }) => {
      if (path === "/api/nodes/n1") { init?.onHeaders?.(new Headers({ [READ_HEAD_HEADER]: "120" })); return note("restored"); }
      throw new TypeError("Failed to fetch"); // the sync it asks for does not get through here
    });
    await hydrateNode("n1");
    expect([copy.owed, copy.forgotten, warnings()]).toEqual([true, 1, 1]);
  });

  it("a ?nodes=none refresh from another identity is not taken as its whole state: the next pass rebuilds first, nobody is told", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/bootstrap?nodes=none")) return { ...bootstrap("300"), server_id: "s2", nodes_omitted: true };
      if (path.startsWith("/api/bootstrap")) return { ...bootstrap("300"), server_id: "s2" };
      if (path === "/api/sync") return { ...delta(Math.max(Number(JSON.parse(String(init?.body)).since), 300), "300"), server_id: "s2" };
      if (path.startsWith("/api/canvases")) return [];
      return {};
    });
    await expect(refreshMeta()).rejects.toThrow();
    expect([copy.server, warnings()]).toEqual([SERVER, 0]); // nothing of the new log stored over the old one
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect([warnings(), bootstraps(), copy.server, copy.cursor]).toEqual([0, 1, "s2", 300]);
  });
});

describe("a healthy server is never taken for one that went back", () => {
  it("a sync in flight while a single note read (another writer's newer head) is taken first: refused, asked again, no word", async () => {
    deviceKnows({ watermark: "100", cursor: 100 });
    let answerFirst!: () => void;
    const held = new Promise<void>((resolve) => { answerFirst = resolve; });
    let asks = 0;
    apiMock.mockImplementation(async (path: string, init?: RequestInit & { onHeaders?: (h: Headers) => void }) => {
      if (path === "/api/sync") {
        // S is read at 110; another writer commits 130 meanwhile; S's answer arrives after the note read below.
        if (asks++ === 0) { await held; return delta(110, "110", [note("as at 110")]); }
        return Number(JSON.parse(String(init?.body)).since) >= 130 ? delta(130, "130") : delta(130, "130", [note("as at 130")]);
      }
      if (path === "/api/nodes/n1") { init?.onHeaders?.(new Headers({ [READ_HEAD_HEADER]: "130" })); return note("as at 130"); }
      if (path.startsWith("/api/canvases")) return [];
      if (path.startsWith("/api/sync/membership")) return { ids: ["n1"], next_cursor: null, epoch: 1, event_cursor: "130" };
      return {};
    });
    const pass = dataSync.sync();
    await vi.waitFor(() => expect(asks).toBe(1));
    await hydrateNode("n1"); // the person opens a note: its GET is read at 130 and taken before S's answer
    expect(pageWouldTake("129", SERVER)).toBe(false);
    answerFirst();
    expect(await pass).toEqual({ ok: true });
    expect(asks).toBe(3); // S was only late: asked again (then caught up)
    // Nothing started over and nobody was told (a reopen refresh an earlier boot test left may still ask a bootstrap).
    expect([copy.forgotten, warnings(), copy.owed]).toEqual([0, 0, false]);
    expect(pageWouldTake("129", SERVER)).toBe(false); // the watermark is still there
  });
});

// The local edition (the browser version: one person, no server, no members) has no membership gate at all
// (lib/hostCapabilities.ts): the same check that can never finish leaves it usable. Owner report 2026-11-23: after
// 登出 there the workspace was locked behind 「正在確認工作區資料…」 for good. The server's gate above is unchanged.
describe("a check that never finishes, with and without other members", () => {
  afterEach(() => { declareLocalOnlyHost(false); });
  function checkNeverFinishes() {
    deviceKnows({ watermark: "100", cursor: 100 });
    vi.mocked(getAllMembershipIds).mockResolvedValue(["n9"]);
    vi.mocked(applySync).mockImplementation(async (d) => ({ ...(d as object), stale: true }) as never);
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/sync") {
        const since = JSON.parse(String(init?.body)).since;
        return delta(Number(since) < 120 ? 120 : since, "120", [], { membership_epoch: 1 });
      }
      if (path.startsWith("/api/sync/membership")) throw new ApiError(404, "{}");
      if (path.startsWith("/api/canvases")) return [];
      return {};
    });
  }

  it("on a server, the first check of the page raises the gate and a failed one keeps it up", async () => {
    checkNeverFinishes();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getAppState().membershipGated).toBe(false);
    expect((await dataSync.sync()).ok).toBe(false);
    expect(getAppState().membershipGated).toBe(true);
    // The server's gate says it on screen; the console line is only for the local edition.
    expect(warn.mock.calls.some(([line]) => line === "[onden] the workspace check did not finish")).toBe(false);
    warn.mockRestore();
  });

  it("in the local edition the gate never comes up, though the check still reports that it did not finish", async () => {
    declareLocalOnlyHost();
    checkNeverFinishes();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await dataSync.sync()).ok).toBe(false);
    expect(getAppState().membershipGated).toBe(false);
    // No gate to see, so the console keeps the one trace of why (the cause is still being looked for).
    expect(warn.mock.calls.some(([line]) => line === "[onden] the workspace check did not finish")).toBe(true);
    warn.mockRestore();
    // Any other path that asks for the gate (a membership tick, a refused replay) is answered the same way.
    dataSync.membershipChanged();
    expect(getAppState().membershipGated).toBe(false);
  });
});
