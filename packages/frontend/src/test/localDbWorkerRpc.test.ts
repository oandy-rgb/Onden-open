// Account isolation has its own suite (accountStorage.test.ts); these bind one account.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Verifies the main-thread RPC bridge in localDb.ts: that public calls post a
// well-formed {id, op, args} message to the worker, and that the returned
// promise resolves / rejects from the matching worker response. This is the
// load-bearing new code from the sql.js→worker split (the actual SQL runs in
// the worker, which can't load wasm under jsdom — so we stub Worker and assert
// the contract that keeps every existing caller's async API unchanged).

type Listener = ((ev: MessageEvent) => void) | null;

// A fake Worker that captures posted requests and lets the test reply.
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: Listener = null;
  onerror: ((ev: { message?: string }) => void) | null = null;
  posted: Array<{ id: number; op: string; args: unknown[] }> = [];
  constructor(public url: unknown, public opts: unknown) {
    FakeWorker.instances.push(this);
  }
  postMessage(req: { id: number; op: string; args: unknown[] }) {
    this.posted.push(req);
  }
  // Test helper: deliver a worker→main response.
  reply(res: unknown) {
    this.onmessage?.({ data: res } as MessageEvent);
  }
  terminate() {}
}

describe("localDb worker RPC bridge", () => {
  beforeEach(async () => {
    FakeWorker.instances = [];
    vi.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.stubGlobal("Worker", FakeWorker as any);
    const { bindAccountStorage } = await import("../lib/accountStorage");
    bindAccountStorage("u", "");
    // import.meta.url is a file: URL under vitest, which new URL() accepts.
  });

  it("posts {op,args} and resolves the result from the worker", async () => {
    const { searchNodes } = await import("../lib/localDb");
    const p = searchNodes("hello");
    // The worker is spawned lazily on the first call.
    const w = FakeWorker.instances[0];
    expect(w).toBeTruthy();
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0].op).toBe("searchNodes");
    expect(w.posted[0].args).toEqual(["hello"]);
    const reqId = w.posted[0].id;

    w.reply({ id: reqId, ok: true, result: [{ id: "n1", snippet: null }] });
    await expect(p).resolves.toEqual([{ id: "n1", snippet: null }]);
  });

  it("reuses a single worker across calls and routes responses by id", async () => {
    const { getLastEventId, searchNodes } = await import("../lib/localDb");
    const a = getLastEventId();
    const b = searchNodes("x");
    const w = FakeWorker.instances[0];
    expect(FakeWorker.instances).toHaveLength(1); // one worker, two calls
    expect(w.posted).toHaveLength(2);
    const [r1, r2] = w.posted;

    // Reply out of order — each promise must still match its own id.
    w.reply({ id: r2.id, ok: true, result: [] });
    w.reply({ id: r1.id, ok: true, result: 42 });
    await expect(a).resolves.toBe(42);
    await expect(b).resolves.toEqual([]);
  });

  it("rejects when the worker reports an error", async () => {
    const { initLocalDb } = await import("../lib/localDb");
    const p = initLocalDb();
    const w = FakeWorker.instances[0];
    w.reply({ id: w.posted[0].id, ok: false, error: "boom" });
    await expect(p).rejects.toThrow("boom");
  });

  it("canvas mirror ops post the right {op,args} and resolve", async () => {
    const { upsertCanvas, removeCanvas, loadCanvases, loadCanvas } = await import("../lib/localDb");

    const canvas = { id: "c1", title: "Board", data: { nodes: [{ nodeId: "n1", x: 1, y: 2 }] }, created_at: "t0", updated_at: "t1" };
    const up = upsertCanvas(canvas);
    let w = FakeWorker.instances[0];
    expect(w.posted[0].op).toBe("upsertCanvas");
    expect(w.posted[0].args).toEqual([canvas]);
    w.reply({ id: w.posted[0].id, ok: true, result: undefined });
    await expect(up).resolves.toBeUndefined();

    const rm = removeCanvas("c1");
    w = FakeWorker.instances[0];
    expect(w.posted[1].op).toBe("removeCanvas");
    expect(w.posted[1].args).toEqual(["c1"]);
    w.reply({ id: w.posted[1].id, ok: true, result: undefined });
    await expect(rm).resolves.toBeUndefined();

    const list = loadCanvases();
    expect(w.posted[2].op).toBe("loadCanvases");
    expect(w.posted[2].args).toEqual([]);
    w.reply({ id: w.posted[2].id, ok: true, result: [{ id: "c1", title: "Board", created_at: "t0", updated_at: "t1" }] });
    await expect(list).resolves.toEqual([{ id: "c1", title: "Board", created_at: "t0", updated_at: "t1" }]);

    const one = loadCanvas("c1");
    expect(w.posted[3].op).toBe("loadCanvas");
    expect(w.posted[3].args).toEqual(["c1"]);
    w.reply({ id: w.posted[3].id, ok: true, result: canvas });
    await expect(one).resolves.toEqual(canvas);
  });

  it("wraps exportDatabase bytes into a File on the main thread", async () => {
    const { exportDatabase } = await import("../lib/localDb");
    const p = exportDatabase();
    const w = FakeWorker.instances[0];
    expect(w.posted[0].op).toBe("exportDatabase");
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    w.reply({ id: w.posted[0].id, ok: true, result: bytes });
    const file = await p;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("onden.sqlite3");
    expect(file.type).toBe("application/x-sqlite3");
    expect(file.size).toBe(3);
  });

  // ── Close-path durability: the data-loss fix ──────────────────────────────
  // The persist scheduler debounces the snapshot by 2s inside the worker, whose
  // own pagehide/beforeunload flush is dead weight (no window there). So the
  // close path MUST relay a real flush RPC to the worker; without it, edits made
  // inside the debounce window are lost when the tab closes. These tests prove
  // that channel exists and actually fires on the unload signals.

  it("flushLocalDbSync posts the flush op to the worker", async () => {
    const { flushLocalDbSync } = await import("../lib/localDb");
    const p = flushLocalDbSync();
    const w = FakeWorker.instances[0];
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0].op).toBe("flushLocalDbSync");
    expect(w.posted[0].args).toEqual([]);
    w.reply({ id: w.posted[0].id, ok: true, result: undefined });
    await expect(p).resolves.toBeUndefined();
  });

  it("installUnloadFlush relays pagehide → a flushLocalDbSync RPC", async () => {
    const { installUnloadFlush } = await import("../lib/localDb");
    const dispose = installUnloadFlush();
    expect(FakeWorker.instances).toHaveLength(0); // no flush until the page hides

    window.dispatchEvent(new Event("pagehide"));
    // The unload flush spawns the worker lazily and posts a flush.
    const w = FakeWorker.instances[0];
    expect(w).toBeTruthy();
    expect(w.posted.some((m) => m.op === "flushLocalDbSync")).toBe(true);
    dispose();
  });

  it("installUnloadFlush relays visibilitychange→hidden, ignores →visible", async () => {
    const { installUnloadFlush } = await import("../lib/localDb");
    const dispose = installUnloadFlush();

    // visible: must NOT flush (we only persist when the user is leaving).
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeWorker.instances).toHaveLength(0);

    // hidden: flushes.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    const w = FakeWorker.instances[0];
    expect(w).toBeTruthy();
    expect(w.posted.some((m) => m.op === "flushLocalDbSync")).toBe(true);
    dispose();
  });

  it("installUnloadFlush disposer removes the listeners (no flush after dispose)", async () => {
    const { installUnloadFlush } = await import("../lib/localDb");
    const dispose = installUnloadFlush();
    dispose();
    window.dispatchEvent(new Event("pagehide"));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeWorker.instances).toHaveLength(0); // disposed → nothing posted
  });
});
