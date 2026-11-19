// Where #1888 (every save is a queue row first: writeQueue.recordWrite, its Web Lock in sendingHere.ts) meets the answer
// positions of #1794 (lib/data/writePositions.ts), checked by running both, not by reading them (#1794 review, note-ed
// point 3):
//   1. a sent write's row is cleared from the queue only after its position was handed to the local copy — the online
//      save and the queued replay alike — so at every moment either the row is still queued or the copy knows the
//      position (an answer read before the write is refused either way);
//   3. a write held back by the liveness hold keeps its row (and its lock) while it waits. A queue drain started then
//      waits for it (one write lane), but nothing the hold's release depends on waits for a drain: the hold exists only
//      inside a pass's request loop, which starts after the pass's own drain (syncEngine.sync: flushPendingWrites, then
//      syncLoopStarted) and never drains again; the pass's end (syncPassEnded, in its finally) lets the write go, and
//      the drain then finishes. No cycle.
// Point 2 (releaseHeldNotes → hydrateNode through the judged read) is in readAgain.test.tsx; point 4 (one model of the
// copy for saveTiming and the real-worker tests) is helpers/saveWorld.ts localDb.applySync.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_POSITION_HEADER } from "@onden/markdown/contract";

const store = vi.hoisted(() => ({
  rows: [] as Array<{ id: number; method: string; path: string; body: string | null; idem_key: string | null; attempts: number }>,
  nextId: 1,
  order: [] as string[],
}));
vi.mock("../lib/localDb", () => ({
  addPendingWrite: vi.fn(async (method: string, path: string, body: string | null, idemKey: string | null) => {
    store.rows.push({ id: store.nextId++, method, path, body, idem_key: idemKey, attempts: 0 });
    store.order.push("queued");
  }),
  getPendingWrites: vi.fn(async () => store.rows.map((row) => ({ ...row }))),
  clearPendingWrite: vi.fn(async (id: number) => { store.rows = store.rows.filter((row) => row.id !== id); store.order.push("cleared"); }),
  bumpPendingWriteAttempt: vi.fn(async (id: number) => { const row = store.rows.find((r) => r.id === id); if (row) row.attempts++; return row?.attempts ?? 0; }),
  catchUpWithOtherTabs: vi.fn(async () => {}),
  getOldestPendingWriteAt: vi.fn(async () => null),
  storeRejectedWrite: vi.fn(),
  rejectPendingWrite: vi.fn(),
  raiseWatermark: vi.fn(async (position: string) => { store.order.push(`position ${position}`); }),
  rewindCursor: vi.fn(async () => {}),
}));

import { apiFetch } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { flushPendingWrites, stopWriteRetry, submitWrite } from "../lib/data/writeQueue";
import { forgetWatermark, startWatermarkFrom, syncLoopStarted, syncPassEnded, takeAnswer } from "../lib/data/writePositions";
import { serverTruth } from "../lib/data/serverTruthLoad";
import { STALE_ANSWERS_BEFORE_WRITES_WAIT } from "../lib/answerPositions";

await serverTruth(); // the read-back module, loaded before any test (as writeQueueRetry)

/** The server: each write is answered with its event position after `delay` (the response's headers carry it). */
let position = 100;
let failNext = 0;
const sent: string[] = [];
function serve() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    sent.push(`${init?.method ?? "GET"} ${url}`);
    if (failNext > 0) { failNext--; return new Response("{}", { status: 503 }); }
    return new Response(JSON.stringify({ id: "a" }), { status: 200, headers: { "content-type": "application/json", [EVENT_POSITION_HEADER]: String(++position) } });
  }));
}

beforeEach(() => {
  bindAccountStorage("u", "");
  forgetWatermark();
  syncPassEnded();
  store.rows = []; store.nextId = 1; store.order = [];
  position = 100; failNext = 0; sent.length = 0;
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  serve();
});
afterEach(() => { stopWriteRetry(); vi.unstubAllGlobals(); vi.restoreAllMocks(); syncPassEnded(); });

describe("1. the queue row goes only after the copy was told the position", () => {
  it("an online save: queued first, its position handed to the copy, then the row cleared", async () => {
    const result = await submitWrite({ method: "PATCH", path: "/api/nodes/a", body: JSON.stringify({ markdown: "x" }) });
    expect(result.status).toBe("synced");
    expect(store.order).toEqual(["queued", "position 101", "cleared"]);
  });

  it("a queued replay: the same order when the queue sends it later", async () => {
    failNext = 1;
    expect((await submitWrite({ method: "PATCH", path: "/api/nodes/a", body: JSON.stringify({ markdown: "x" }) })).status).toBe("queued");
    store.order = [];
    await flushPendingWrites();
    expect(store.order).toEqual(["position 101", "cleared"]);
  });
});

describe("3. a write held for liveness and #1888's queue row and lock: nothing waits on each other", () => {
  it("held: its row stays queued; a drain started meanwhile finishes once the pass ends, and the pass's end waits for nothing", async () => {
    // A sync pass whose answers were refused a few times in a row: the next write waits (writePositions.ts liveness).
    startWatermarkFrom({ position: "50", server: "s1" });
    syncLoopStarted();
    for (let i = 0; i < STALE_ANSWERS_BEFORE_WRITES_WAIT; i++) {
      await takeAnswer({ head: "40", serverId: "s1", toCopy: async () => ({ value: null }), toStore: () => {} });
    }
    const write = submitWrite({ method: "PATCH", path: "/api/nodes/a", body: JSON.stringify({ markdown: "held" }) });
    await vi.waitFor(() => expect(store.rows).toHaveLength(1)); // recorded (its lock taken) before it waits
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]); // held
    // A drain asked for now (an online event, another trigger) waits behind the held write in the lane.
    let drained = false;
    const drain = flushPendingWrites().then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([drained, sent]).toEqual([false, []]);
    syncPassEnded(); // the pass ends (caught up, failed or offline): synchronous, it waits for nothing; held writes go
    expect((await write).status).toBe("synced");
    await drain;
    expect(drained).toBe(true);
    expect(sent).toEqual(["PATCH /api/nodes/a"]);
    expect(store.rows).toEqual([]);
  });

  it("a write already on its way when the hold starts is not held, and its row is cleared after its position", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      sent.push(`${init?.method ?? "GET"} ${url}`);
      return new Promise<Response>((resolve) => { answer = resolve; });
    }));
    const write = submitWrite({ method: "PATCH", path: "/api/nodes/a", body: JSON.stringify({ markdown: "on its way" }) });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    startWatermarkFrom({ position: "50", server: "s1" });
    syncLoopStarted();
    for (let i = 0; i < STALE_ANSWERS_BEFORE_WRITES_WAIT; i++) {
      await takeAnswer({ head: "40", serverId: "s1", toCopy: async () => ({ value: null }), toStore: () => {} });
    }
    answer(new Response("{}", { status: 200, headers: { [EVENT_POSITION_HEADER]: "77" } }));
    expect((await write).status).toBe("synced");
    expect(store.order).toEqual(["queued", "position 77", "cleared"]);
    // A write sent through the gate now waits, and goes once the pass ends.
    serve();
    const next = apiFetch("/api/nodes/b", { method: "PATCH", body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual(["PATCH /api/nodes/a"]);
    syncPassEnded();
    await next;
    expect(sent).toEqual(["PATCH /api/nodes/a", "PATCH /api/nodes/b"]);
  });
});
