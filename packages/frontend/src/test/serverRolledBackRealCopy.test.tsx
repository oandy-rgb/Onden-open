// The recovery from a server that went back (src/test/serverRolledBack.test.tsx), with the sync engine over the REAL
// local-copy worker (lib/localDbWorker, a real sql.js database): the copy refuses the restored log until the engine has
// it forget its watermark; then the bootstrap is taken and the cursor goes back to the restored head. A rebuild that
// could not be done is still owed after a reload (the mark is in the copy) and the person is told once (#1794 review,
// round 4, items 4 and 6).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap, ContentNode } from "../lib/api";
import { openWorker, reopen, rpc } from "./helpers/localDbWorkerHarness";

const disk = vi.hoisted(() => ({ bytes: null as ArrayBuffer | null }));
vi.mock("../lib/indexedDbStorage", () => ({
  idbLoad: async () => disk.bytes,
  idbSave: async (bytes: ArrayBuffer) => { disk.bytes = bytes; },
  idbIsStale: async () => false,
}));
vi.mock("sql.js", async (original) => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});
/** The engine's local copy is the real worker: the calls that judge, store and move the cursor go to it. */
const REAL = ["getWatermark", "forgetCopyWatermark", "raiseWatermark", "rewindCursor", "persistBootstrap", "applySync",
  "getLastEventId", "setLastEventId", "getPendingWrites", "getAllMembershipIds", "getMembershipEpoch", "setMembershipEpoch",
  "persistRemoteNode", "loadBootstrap"] as const;
vi.mock("../lib/localDb", () => ({
  ...Object.fromEntries(REAL.map((op) => [op, (...args: unknown[]) => rpc(op, ...args)])),
  initLocalDb: vi.fn(async () => null),
  loadBootstrapList: vi.fn(async () => null),
  loadBootstrapRelations: vi.fn(async () => ({ edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] })),
  loadAttributePage: vi.fn(async () => ({ rows: [], next: null })),
  getStoredBody: vi.fn(async () => null),
  clearPendingWrite: vi.fn(async () => {}),
  catchUpWithOtherTabs: vi.fn(async () => {}),
  getOldestPendingWriteAt: vi.fn(async () => null),
  getLastFullRefresh: vi.fn(async () => Date.now()),
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
const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: (...a: unknown[]) => apiMock(...a) };
});

const SERVER = "server-1";
const note = (markdown: string) =>
  ({ id: "n1", source_type: "manual", node_type: "content", title: "n1", slug: "n1", markdown, parent_id: null, hidden: false, order_key: "a0" }) as ContentNode;
const boot = (markdown: string, last: string) => ({
  workspace: { id: "w", name: "W", slug: "w", home_node_id: null }, actor_role: "editor", nodes: [note(markdown)],
  edges: [], tasks: [], suggestions: [], events: [], pointers: [], server_id: SERVER, last_event_id: last,
});
const empty = (last: number, head: string) => ({
  last_event_id: last, head_event_id: head, server_id: SERVER, nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] },
  tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null,
});
const text = async () => (await rpc<Bootstrap>("loadBootstrap")).nodes.find((n) => n.id === "n1")?.markdown;

/** The restored server (its log ends at 120); `bootstrapDown` fails its next whole bootstraps. */
let bootstrapDown = 0;
function restoredServer() {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/sync") {
      const since = Number(JSON.parse(String(init?.body)).since);
      return empty(Math.max(since, 120), "120");
    }
    if (path.startsWith("/api/bootstrap")) {
      if (bootstrapDown > 0) { bootstrapDown--; throw new TypeError("Failed to fetch"); }
      return boot("restored", "120");
    }
    if (path.startsWith("/api/canvases")) return [];
    return {};
  });
}

/** A page load over the copy on `disk`: the engine modules are fresh, as after a reload. */
async function page() {
  const { bindAccountStorage } = await import("../lib/accountStorage");
  bindAccountStorage("u", "");
  const { dataSync } = await import("../lib/data");
  const { getAppState } = await import("../lib/appStore");
  const { pageWouldTake } = await import("../lib/data/writePositions");
  return { dataSync, getAppState, pageWouldTake, warnings: () => getAppState().toasts.filter((t) => t.kind === "warning").length };
}

beforeEach(async () => {
  disk.bytes = null;
  bootstrapDown = 0;
  apiMock.mockReset();
  await openWorker();
  // What this device knew before the server was restored: its saves reached 9000.
  await rpc("persistBootstrap", boot("saved", "9000"));
  restoredServer();
});

describe("a server that went back, over the real local copy", () => {
  it("refused by the copy until the engine has it forget; then taken, and the cursor goes back to the restored head", async () => {
    expect((await rpc<{ answer_stale?: true }>("persistBootstrap", boot("restored", "120"))).answer_stale).toBe(true);
    const p = await page();
    expect(await p.dataSync.sync()).toEqual({ ok: true });
    expect(await text()).toBe("restored");
    expect(await rpc("getLastEventId")).toBe(120);
    expect(await rpc("getWatermark")).toMatchObject({ position: "120", rebuildOwed: false });
    expect(p.warnings()).toBe(1);
    expect(p.pageWouldTake("120", SERVER)).toBe(true);
  });

  it("the rebuild fails and the page is reloaded: it is still owed, the next pass does it, the person was told once", async () => {
    await rpc("rewindCursor", "100"); // cursor ≤ the restored head: after forgetting, nothing is below any watermark
    bootstrapDown = 1;
    const first = await page();
    expect((await first.dataSync.sync()).ok).toBe(false);
    expect(first.warnings()).toBe(1);
    expect(await rpc("getWatermark")).toMatchObject({ position: null, rebuildOwed: true });
    await reopen(); // a reload: fresh worker over the saved copy, fresh page modules
    const again = await page();
    expect(await again.dataSync.sync()).toEqual({ ok: true });
    expect(await text()).toBe("restored");
    expect(await rpc("getWatermark")).toMatchObject({ position: "120", rebuildOwed: false });
    expect(again.warnings()).toBe(0); // told before the reload, not again
  });

  it("the copy refuses a delta (another tab was told of 9000 during the pass): its watermark is learnt, the next ask proves it", async () => {
    disk.bytes = null;
    await openWorker();
    await rpc("persistBootstrap", boot("saved", "100"));
    let asks = 0;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/sync") {
        if (asks++ === 0) await rpc("raiseWatermark", "9000"); // another tab's save acknowledged at 9000, before the restore
        const since = Number(JSON.parse(String(init?.body)).since);
        return since >= 120 ? empty(since, "120") : { ...empty(120, "120"), nodes: { upsert: [note("restored")], delete: [] } };
      }
      if (path.startsWith("/api/bootstrap")) return boot("restored", "120");
      if (path.startsWith("/api/canvases")) return [];
      return {};
    });
    const p = await page();
    expect(await p.dataSync.sync()).toEqual({ ok: true });
    expect([await text(), await rpc("getLastEventId"), p.warnings()]).toEqual(["restored", 120, 1]);
  });

  it("an ordinary late answer (another tab told of 130 while it was out) is refused by the copy and asked again: no word", async () => {
    disk.bytes = null;
    await openWorker();
    await rpc("persistBootstrap", boot("saved", "100"));
    let asks = 0;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/sync") {
        const since = Number(JSON.parse(String(init?.body)).since);
        if (asks++ === 0) {
          await rpc("raiseWatermark", "130"); // acknowledged after this request was read at 110
          return { ...empty(110, "110"), nodes: { upsert: [note("as at 110")], delete: [] } };
        }
        return since >= 130 ? empty(since, "130") : { ...empty(130, "130"), nodes: { upsert: [note("as at 130")], delete: [] } };
      }
      if (path.startsWith("/api/canvases")) return [];
      return {};
    });
    const p = await page();
    expect(await p.dataSync.sync()).toEqual({ ok: true });
    expect([await text(), p.warnings()]).toEqual(["as at 130", 0]);
    expect(await rpc("getWatermark")).toMatchObject({ position: "130", rebuildOwed: false });
  });
});
