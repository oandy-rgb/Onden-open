// A single note read (GET /api/nodes/:id) taken before a write this device was told about is not taken
// (lib/data/serverTruth.ts readServerNode). It is asked again while new writes wait; still refused, the note goes on the
// list sync() reads again (syncEngine readAgain), and a sync is asked for. Nobody has to open the note again
// (#1794 review by note-91, 2026-11-19, item 2). Here each refused read is overtaken by an acknowledgement that arrives
// while it is out (a write already on its way); one read below what was known when it LEFT is the server going back
// (lib/data/writePositions.ts serverWentBack: the sync is asked for at once, round 4 of that review).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { READ_HEAD_HEADER } from "@onden/markdown/contract";

vi.mock("../lib/localDb", () => ({
  getWatermark: async () => ({ position: null, server: null }), raiseWatermark: async () => {}, rewindCursor: async () => {}, forgetCopyWatermark: async () => ({ alreadyOwed: false }),
  initLocalDb: vi.fn(async () => null),
  loadBootstrapList: vi.fn(async () => null),
  loadBootstrapRelations: vi.fn(async () => ({ edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] })),
  loadAttributePage: vi.fn(async () => ({ rows: [], next: null })),
  persistBootstrap: vi.fn(async (data) => data),
  persistRemoteNode: vi.fn(async (node) => node),
  removeNode: vi.fn(async () => {}),
  getStoredBody: vi.fn(async () => null),
  forgetBody: vi.fn(async () => {}),
  applySync: vi.fn(async (delta) => delta),
  getLastEventId: vi.fn(async () => 100),
  setLastEventId: vi.fn(async () => {}),
  getAllMembershipIds: vi.fn(async () => [] as string[]),
  getMembershipEpoch: vi.fn(async () => 0),
  setMembershipEpoch: vi.fn(async () => {}),
  getPendingWrites: vi.fn(async () => []),
  heldNotesNowSent: vi.fn(async () => [] as string[]),
  clearPendingWrite: vi.fn(async () => {}),
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
import { getLastEventId, heldNotesNowSent } from "../lib/localDb";
import { hydrateNode, __resetSyncEngineForTests } from "../lib/data/syncEngine";
import { settleNodeToServer } from "../lib/data/serverTruth";
import { later, readAgain } from "../lib/data/serverTruthLoad";
import { ApiError, apiFetch } from "../lib/api";
import { getAppState, resetAppState, setData } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { _resetLocalCopyForTests } from "../lib/localCopyState";
import { forgetWatermark, startWatermarkFrom, syncPassEnded } from "../lib/data/writePositions";
import { optimisticFields } from "../lib/data/optimisticFields";
import type { Bootstrap, ContentNode } from "../lib/api";

const WATERMARK = "50"; // a save of this device was acknowledged at 50, while the first read was out
const slim: ContentNode = { id: "n2", title: "the next note", markdown: "", body_len: 9, source_type: "manual", node_type: "content", slug: "n2", parent_id: "p-moved-here" };
const server: ContentNode = { ...slim, markdown: "its text", parent_id: null };
const store = (): Bootstrap => ({
  workspace: { id: "w", name: "T", slug: "t", home_node_id: null }, actor_role: "editor",
  nodes: [slim], edges: [], tasks: [], suggestions: [], events: [], last_event_id: "100",
});
/** The server's GET answers: each one is read at the next head in `heads`, and every one but the last is overtaken by
 *  an acknowledgement 10 later that arrives while it is out (the last one is read after all of them). `forever`: every
 *  read is overtaken so. */
function reads(...heads: string[]) {
  let i = 0;
  const forever = heads[0] === "forever";
  let top = "0"; // the highest position acknowledged so far: a sync is read after it
  apiMock.mockImplementation(async (path: string, init?: RequestInit & { onHeaders?: (h: Headers) => void }) => {
    if (path === "/api/nodes/n2") {
      const head = forever ? String(40 + 10 * i++) : heads[Math.min(i++, heads.length - 1)]!;
      if (forever || i < heads.length) startWatermarkFrom({ position: top = String(Number(head) + 10), server: null });
      init?.onHeaders?.(new Headers({ [READ_HEAD_HEADER]: head }));
      return structuredClone(server);
    }
    if (path === "/api/sync") return { last_event_id: 100, head_event_id: String(Math.max(100, Number(top))), nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
    if (path.startsWith("/api/canvases")) return [];
    throw new Error("unexpected " + path);
  });
}
const gets = () => apiMock.mock.calls.filter(([path]) => path === "/api/nodes/n2").length;
const shown = () => getAppState().data.nodes.find((n) => n.id === "n2")!;

beforeEach(async () => {
  // Every test on a fake clock: the sync a refused read asks for later (setTimeout) must not fire in the next test.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await __resetSyncEngineForTests();
  readAgain.clear(); // module state, as the watermark
  vi.mocked(getLastEventId).mockResolvedValue(100);
  bindAccountStorage("u", "");
  forgetWatermark();
  syncPassEnded();
  resetAppState();
  _resetLocalCopyForTests();
  apiMock.mockReset();
  setData(() => store());
  later.forgetRounds?.(); // a note's refused rounds are module state too (serverTruth.ts)
});
afterEach(() => { vi.useRealTimers(); });

describe("a single note read taken before an acknowledged save", () => {
  it("is asked again at once: the note's text shows with no action of the person (the GET left before the save was acknowledged)", async () => {
    reads("40", WATERMARK);
    await hydrateNode("n2");
    expect(gets()).toBe(2);
    expect(shown().markdown).toBe("its text");
  });

  it("refused every time: given up after a few, put on the list, and the sync asked for a little later reads it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    reads("40", "50", "60", "70");
    await hydrateNode("n2");
    expect(gets()).toBe(3);
    expect(shown().markdown).toBe("");
    await vi.advanceTimersByTimeAsync(2_000); // the sync it asked for (dataSync.sync → releaseHeldNotes → hydrateNode)
    await vi.waitFor(() => expect(shown().markdown).toBe("its text"));
    expect(gets()).toBe(4);
  });

  it("a refused write's read-back (settleNodeToServer) that is refused puts the note on the list; the next sync settles where it is", async () => {
    reads("40", "50", "60", "70");
    expect(await settleNodeToServer("n2", setData)).toBe(false);
    expect(shown().parent_id).toBe("p-moved-here");
    expect(await dataSync.sync()).toEqual({ ok: true }); // the next sync, whatever starts it
    expect(shown().parent_id).toBeNull();
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect(gets()).toBe(4); // read once more, then off the list
  });

  it("while it asks again, new writes wait; they go when the ask ends — answered, or given up at the read deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { fetched.push(`${init?.method ?? "GET"} ${url}`); return new Response("{}", { status: 200 }); }));
    let finish!: (value: unknown) => void;
    let first = true;
    let firstHead = "40";
    apiMock.mockImplementation(async (path: string, init?: RequestInit & { onHeaders?: (h: Headers) => void; signal?: AbortSignal }) => {
      if (path !== "/api/nodes/n2") return {};
      if (first) {
        first = false;
        startWatermarkFrom({ position: String(Number(firstHead) + 10), server: null }); // acknowledged while it is out
        init?.onHeaders?.(new Headers({ [READ_HEAD_HEADER]: firstHead }));
        return structuredClone(server);
      }
      // The ask again: answered when the test says so, or never (then the read deadline ends it).
      return new Promise((resolve, reject) => {
        finish = (value) => { init?.onHeaders?.(new Headers({ [READ_HEAD_HEADER]: String(Number(firstHead) + 10) })); resolve(value); };
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    });
    // Answered: the write waits while the second GET is out, and leaves once it is in.
    const reading = hydrateNode("n2");
    await vi.waitFor(() => expect(gets()).toBe(2));
    const write = apiFetch("/api/nodes/n1", { method: "PATCH", body: "{}" });
    await vi.advanceTimersByTimeAsync(10);
    expect(fetched.filter((f) => f.startsWith("PATCH"))).toEqual([]);
    finish(structuredClone(server));
    await reading;
    await write;
    expect(fetched.filter((f) => f.startsWith("PATCH"))).toHaveLength(1);
    // Never answered: the write leaves when the read deadline gives the ask up.
    first = true;
    firstHead = "50";
    const stuck = hydrateNode("n2");
    await vi.waitFor(() => expect(gets()).toBe(4));
    const second = apiFetch("/api/nodes/n1", { method: "PATCH", body: "{}" });
    await vi.advanceTimersByTimeAsync(10);
    expect(fetched.filter((f) => f.startsWith("PATCH"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await stuck;
    await second;
    expect(fetched.filter((f) => f.startsWith("PATCH"))).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("a note whose reads are always refused is asked again later each round, and not forever", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    reads("forever"); // every read, forever, overtaken by a save acknowledged while it is out
    await hydrateNode("n2");
    expect(gets()).toBe(3);
    await vi.advanceTimersByTimeAsync(10 * 60_000); // rounds at 2, 4, 8 and 16 s later, then none
    expect(gets()).toBe(3 + 4 * 3);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(gets()).toBe(3 + 4 * 3);
  });

  it("a read below what this device knew when it left is the server going back: no ask again, the sync is asked for at once", async () => {
    startWatermarkFrom({ position: WATERMARK, server: null });
    vi.mocked(getLastEventId).mockResolvedValue(30); // the copy's cursor, below the restored head
    reads("40", "40"); // the first read is overtaken by nothing: it left knowing 50
    apiMock.mockImplementation(async (path: string, init?: RequestInit & { onHeaders?: (h: Headers) => void }) => {
      if (path === "/api/nodes/n2") { init?.onHeaders?.(new Headers({ [READ_HEAD_HEADER]: "40" })); return structuredClone(server); }
      if (path === "/api/sync") return { last_event_id: 40, head_event_id: "40", nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
      if (path.startsWith("/api/bootstrap")) return { ...store(), last_event_id: "40" };
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    await hydrateNode("n2");
    expect(gets()).toBe(1);
    await vi.waitFor(() => expect(apiMock.mock.calls.some(([path]) => path === "/api/sync")).toBe(true));
  });

  it("an ask again that does not come back (the read deadline) puts the note on the list; the next sync reads it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let first = true;
    apiMock.mockImplementation(async (path: string, init?: RequestInit & { onHeaders?: (h: Headers) => void; signal?: AbortSignal }) => {
      if (path !== "/api/nodes/n2") return {};
      if (!first) return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      first = false;
      startWatermarkFrom({ position: WATERMARK, server: null }); // acknowledged while it is out
      init?.onHeaders?.(new Headers({ [READ_HEAD_HEADER]: "40" }));
      return structuredClone(server);
    });
    const reading = hydrateNode("n2");
    await vi.advanceTimersByTimeAsync(30_000);
    await reading;
    expect(shown().markdown).toBe("");
    reads(WATERMARK); // the server answers again, read after the save
    expect(await dataSync.sync()).toEqual({ ok: true });
    await vi.waitFor(() => expect(shown().markdown).toBe("its text"));
  });

  it("the server's answer that the note is not there ends its rounds: a later refusal starts again at the first interval", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const syncs = () => apiMock.mock.calls.filter(([path]) => path === "/api/sync").length;
    reads("40", "50", "60", "70");
    await hydrateNode("n2"); // round 1: a sync 2 s later
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/nodes/n2") throw new ApiError(404, "{}");
      if (path === "/api/sync") return { last_event_id: 100, head_event_id: "100", nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    await vi.advanceTimersByTimeAsync(2_000); // that sync reads it: gone
    await vi.waitFor(() => expect(apiMock.mock.calls.some(([path]) => path === "/api/nodes/n2")).toBe(true));
    apiMock.mockClear();
    forgetWatermark();
    reads("40", "50", "60", "70");
    await hydrateNode("n2"); // refused again: round 1 again (not round 2, 4 s)
    const before = syncs();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(syncs()).toBe(before + 1);
  });

  it("#1888's held list (releaseHeldNotes → hydrateNode) goes through the judged read: refused, asked again, the newer text arrives", async () => {
    // The copy kept this device's queued text over a newer server row (held_text); the write has gone since. At the
    // start of a sync the note is read again — and that read is judged like any other.
    vi.mocked(heldNotesNowSent).mockResolvedValueOnce(["n2"]);
    reads("40", WATERMARK); // the first read is overtaken by an acknowledgement; the second is after it
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect(gets()).toBe(2);
    expect(shown().markdown).toBe("its text"); // the server's row, with the other writer's text
  });

});

describe("a single read kept under an edit still waiting for its answer (storeOps.serverCopyOver)", () => {
  it("is read again once that edit has its answer, while a sync pass is in flight (review of #1794, second half, point 3)", async () => {
    // The open note shows this device's text; its save is on its way (a field with an edit waiting: optimisticFields).
    setData((data) => ({ ...data, nodes: [{ ...server, markdown: "mine" }] }));
    const settle = optimisticFields<ContentNode>("node:n2", { ...server, markdown: "before" }, { markdown: "mine" });
    let serverText = "another device's text";
    let passAnswer!: () => void;
    apiMock.mockImplementation(async (path: string, init?: RequestInit & { onHeaders?: (h: Headers) => void }) => {
      if (path === "/api/nodes/n2") {
        init?.onHeaders?.(new Headers({ [READ_HEAD_HEADER]: "100" }));
        return { ...structuredClone(server), markdown: serverText };
      }
      if (path === "/api/sync") {
        // This pass is past its start (releaseHeldNotes ran) and waits for its answer the whole test.
        await new Promise<void>((resolve) => { passAnswer = resolve; });
        return { last_event_id: 100, head_event_id: "100", nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
      }
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    const pass = dataSync.sync();
    await vi.waitFor(() => expect(apiMock.mock.calls.some(([path]) => path === "/api/sync")).toBe(true));
    await hydrateNode("n2");
    expect(gets()).toBe(1);
    expect(shown().markdown).toBe("mine"); // kept: the read may be from before the save reached the server
    // The save is answered (the writer would put the server's row in; here the row stays) and the other device's text
    // moves on. The note is read again now, not at whatever sync comes after the one in flight.
    serverText = "another device's newer text";
    settle(true, { markdown: "mine" });
    await vi.waitFor(() => expect(gets()).toBe(2));
    await vi.waitFor(() => expect(shown().markdown).toBe("another device's newer text"));
    passAnswer();
    await pass;
  });
});
