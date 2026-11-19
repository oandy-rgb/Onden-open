// Several tabs (and the installed app) of one origin each run their own local
// database worker over the SAME IndexedDB keys. These tests run two or three
// real workers (real sql.js, the real snapshot adapter over a small fake
// IndexedDB with transactions) against one shared disk and one shared journal.
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { JournalApplied, JournalEntry } from "../lib/localDbJournal";

const journal = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));
vi.mock("../lib/localDbJournal", async original => {
  const real = await original<typeof import("../lib/localDbJournal")>();
  const key = (scope: string, e: { session: string; seq: number }) => `${scope}|${e.session}|${String(e.seq).padStart(9, "0")}`;
  return {
    ...real,
    journalAvailable: () => true,
    journalAppend: async (scope: string, e: JournalEntry) => { journal.rows.set(key(scope, e), structuredClone(e)); },
    journalRead: async (scope: string) =>
      [...journal.rows.entries()].filter(([k]) => k.startsWith(`${scope}|`)).sort(([a], [b]) => a < b ? -1 : 1).map(([, e]) => structuredClone(e)),
    journalDrop: async (scope: string, applied: JournalApplied) => {
      for (const [k, e] of [...journal.rows.entries()]) {
        const entry = e as JournalEntry;
        if (k.startsWith(`${scope}|`) && entry.seq <= (applied[entry.session] ?? 0)) journal.rows.delete(k);
      }
    },
    journalClear: async (scope: string) => { for (const k of [...journal.rows.keys()]) if (k.startsWith(`${scope}|`)) journal.rows.delete(k); },
  };
});
vi.mock("sql.js", async original => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});

// A fake IndexedDB for the snapshot database: one store, requests that answer
// in a later microtask, a transaction that completes when its requests are
// done. Writes apply at call time, so a get-then-put inside one callback is
// atomic like a real readwrite transaction.
const idb = { data: new Map<string, unknown>(), holdWrites: null as null | Promise<void>, failWrites: false };
function installFakeIndexedDb() {
  idb.data = new Map(); idb.holdWrites = null; idb.failWrites = false;
  const db = {
    close() {},
    createObjectStore() {},
    transaction() {
      let pending = 0, settled = false;
      const tx = {
        error: null as unknown, oncomplete: null as null | (() => void), onabort: null as null | (() => void), onerror: null as null | (() => void),
        abort() { settled = true; queueMicrotask(() => tx.onabort?.()); },
        objectStore: () => ({
          get(key: string) {
            const req = { result: undefined as unknown, onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
            pending++;
            queueMicrotask(() => { req.result = idb.data.get(key); req.onsuccess?.(); finish(); });
            return req;
          },
          put(value: unknown, key: string) {
            pending++;
            const apply = () => {
              if (settled) return;
              if (idb.failWrites) { settled = true; tx.error = new DOMException("quota", "QuotaExceededError"); tx.onabort?.(); return; }
              idb.data.set(key, value); finish();
            };
            if (idb.holdWrites) void idb.holdWrites.then(apply); else queueMicrotask(apply);
          },
        }),
      };
      function finish() {
        if (--pending > 0 || settled) return;
        queueMicrotask(() => { if (pending === 0 && !settled) { settled = true; tx.oncomplete?.(); } });
      }
      return tx;
    },
  };
  vi.stubGlobal("indexedDB", { open: () => {
    const req = { result: db, onsuccess: null as null | (() => void), onupgradeneeded: null as null | (() => void), onerror: null as null | (() => void) };
    queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
    return req;
  } });
}

type Reply = { id: number; ok: boolean; result?: unknown; error?: string };
type Tab = { send: (op: string, ...args: unknown[]) => Promise<unknown>; attempt: (op: string, ...args: unknown[]) => Promise<Reply & { code?: string }> };
let sequence = 0;
const replies = new Map<number, (reply: Reply) => void>();
let events: Array<{ event: string; ok: boolean }> = [];

/** A new worker on whatever is on disk: another tab, or a restart. */
async function openTab({ expectOpen = true } = {}): Promise<Tab> {
  vi.resetModules();
  const worker = { onmessage: null as null | ((event: { data: unknown }) => void), postMessage: (message: Reply & { event?: string; ok: boolean }) => {
    if (message.event) { events.push(message as { event: string; ok: boolean }); return; }
    replies.get(message.id)?.(message); replies.delete(message.id);
  } };
  vi.stubGlobal("self", worker);
  await import("../lib/localDbWorker");
  const receive = worker.onmessage!;
  const attempt: Tab["attempt"] = async (op, ...args) => {
    const id = ++sequence;
    return new Promise<Reply & { code?: string }>(resolve => { replies.set(id, resolve); receive({ data: { id, op, args, storageScope: "acct" } }); });
  };
  const tab: Tab = {
    attempt,
    send: async (op, ...args) => {
      const reply = await attempt(op, ...args);
      expect(reply.ok, reply.error).toBe(true);
      return reply.result;
    },
  };
  if (expectOpen) await tab.send("initLocalDb");
  return tab;
}
const queued = async (tab: Tab) => ((await tab.send("getPendingWrites")) as Array<{ idem_key: string }>).map(w => w.idem_key);
const settle = () => vi.advanceTimersByTimeAsync(20_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  journal.rows.clear(); events = [];
  installFakeIndexedDb();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("one snapshot key shared by several tabs", () => {
  it("a stale tab's snapshot does not erase the queue another tab compacted into it", async () => {
    const a = await openTab();
    const b = await openTab(); // loaded the same (empty) snapshot as a
    await a.send("addPendingWrite", "POST", "/api/nodes", "{}", "key-1");
    await a.send("setLastEventId", 5);
    await a.send("flushLocalDbSync"); // compaction: snapshot holds key-1, its journal record is gone
    expect([...journal.rows.values()]).toEqual([]);
    await b.send("setLastEventId", 6);
    await b.send("flushLocalDbSync"); // used to overwrite the snapshot without key-1
    expect(await queued(await openTab())).toEqual(["key-1"]);
  });

  it("the stale tab continues from the stored snapshot and keeps its own queued write", async () => {
    const a = await openTab();
    const b = await openTab();
    await a.send("addPendingWrite", "POST", "/api/nodes", "{}", "key-a");
    await a.send("setLastEventId", 5);
    await a.send("flushLocalDbSync");
    await b.send("addPendingWrite", "POST", "/api/nodes", "{}", "key-b"); // journaled only
    await b.send("setLastEventId", 6);
    await b.send("flushLocalDbSync");
    const cold = await openTab();
    expect((await queued(cold)).sort()).toEqual(["key-a", "key-b"]);
    expect(await cold.send("getLastEventId")).toBeGreaterThanOrEqual(5);
  });

  // An order the fault e2e cannot hold in a real browser (A's record is compacted within seconds): A's offline edit is
  // only journaled when B, opened before it, stores its own snapshot. This is not a #616 regression test: it passed
  // before #616 too (a snapshot drops only the journal records it contains). It pins that the order stays safe.
  it("order: a write another tab only journaled survives this tab's snapshot save and that tab closing (safe before #616 too)", async () => {
    const a = await openTab();
    const b = await openTab();
    await a.send("addPendingWrite", "PATCH", "/api/nodes/n", '{"markdown":"offline in a"}', "a-offline");
    await b.send("setLastEventId", 6); // B's live update: its mirror changed, a save is scheduled
    await settle(); // B's snapshot lands (and A's 15 s compaction, which this order makes stale too)
    expect(await queued(await openTab())).toEqual(["a-offline"]);
  });

  it("a replaced database (wipe) is stored even over a newer snapshot", async () => {
    const a = await openTab();
    const b = await openTab();
    await a.send("addPendingWrite", "POST", "/api/nodes", "{}", "key-1");
    await a.send("flushLocalDbSync");
    await b.send("wipeWorkspaceMirror");
    expect(await queued(await openTab())).toEqual([]);
  });

  // An answer asked from this tab's cursor can land after it took in an older stored copy: it would move the cursor
  // past the changes the stored copy lacks, and no later sync would bring them (found by multiTab.property).
  it("after taking in an older stored copy, the next request starts from that copy's cursor, even when an earlier answer lands first", async () => {
    const a = await openTab();
    const b = await openTab();
    await a.send("setLastEventId", 11); // A applied the changes up to 11, in its memory only
    await b.send("setLastEventId", 10);
    await b.send("flushLocalDbSync"); // B stores its copy: the newest stored one, its cursor at 10
    await a.send("catchUpWithOtherTabs"); // A takes it in
    await a.send("setLastEventId", 12); // the answer A asked from 11 lands
    expect(await a.send("getLastEventId")).toBe(10);
    expect(await a.send("getLastEventId")).toBe(10); // and stays there until a sync moves it
  });

  // Several places read the cursor (the boot's "has it synced before", a bootstrap's before-and-after, the membership
  // check); only the read that starts a sync request starts from the floor and spends it. A read before it must not
  // spend it, or the answer that lands next moves the cursor past the changes again.
  it("the floor holds for the next sync request however many other reads come first", async () => {
    const a = await openTab();
    const b = await openTab();
    await a.send("setLastEventId", 11);
    await b.send("setLastEventId", 10);
    await b.send("flushLocalDbSync");
    await a.send("catchUpWithOtherTabs");
    expect(await a.send("getLastEventId")).toBe(10); // the boot's check, say: it sees the floor and leaves it
    await a.send("setLastEventId", 12); // the answer A asked from 11 lands
    expect(await a.send("getLastEventId", { startingSync: true })).toBe(10);
    await a.send("setLastEventId", 13); // that sync's own answer
    expect(await a.send("getLastEventId", { startingSync: true })).toBe(13); // spent: the next one starts from there
  });

  it("catchUpWithOtherTabs brings in a write another tab only journaled", async () => {
    const a = await openTab();
    const b = await openTab();
    await a.send("addPendingWrite", "PATCH", "/api/nodes/n", "{}", "older-in-a");
    expect(await queued(b)).toEqual([]);
    await b.send("catchUpWithOtherTabs");
    expect(await queued(b)).toEqual(["older-in-a"]);
  });

  it("catchUpWithOtherTabs also finds it after the other tab compacted it into a snapshot", async () => {
    const a = await openTab();
    const b = await openTab();
    await a.send("addPendingWrite", "PATCH", "/api/nodes/n", "{}", "older-in-a");
    await a.send("setLastEventId", 3);
    await a.send("flushLocalDbSync");
    await b.send("catchUpWithOtherTabs");
    expect(await queued(b)).toEqual(["older-in-a"]);
  });
});

describe("saving the snapshot", () => {
  it("does not hold up other requests while the storage write is slow", async () => {
    const a = await openTab();
    let release!: () => void;
    idb.holdWrites = new Promise<void>(resolve => { release = resolve; });
    await a.send("setLastEventId", 1);
    await vi.advanceTimersByTimeAsync(3_000); // the debounced save starts and waits on storage
    await a.send("addPendingWrite", "POST", "/api/nodes", "{}", "while-saving"); // would queue behind the save
    release();
    await settle();
    expect(await queued(await openTab())).toEqual(["while-saving"]);
  });

  it("failing tells the page once, waits longer each time, and recovers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await openTab();
    await a.send("setLastEventId", 1);
    idb.failWrites = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events).toEqual([{ event: "snapshot-save", ok: false }]);
    const saved = () => idb.data.size;
    expect(saved()).toBe(0);
    await vi.advanceTimersByTimeAsync(4_000); // second attempt after 4 s, next wait 8 s
    await vi.advanceTimersByTimeAsync(7_000);
    expect(events).toEqual([{ event: "snapshot-save", ok: false }]);
    idb.failWrites = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(events).toEqual([{ event: "snapshot-save", ok: false }, { event: "snapshot-save", ok: true }]);
    expect(saved()).toBeGreaterThan(0);
  });
  it("pressing Retry while storage is still full does not lengthen the automatic wait", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await openTab();
    idb.failWrites = true;
    await a.send("setLastEventId", 1);
    await vi.advanceTimersByTimeAsync(3_000); // first failure: the next automatic try is 4 s away
    await expect(a.send("retrySnapshotSave")).rejects.toBeDefined();
    await expect(a.send("retrySnapshotSave")).rejects.toBeDefined();
    idb.failWrites = false;
    await vi.advanceTimersByTimeAsync(4_000); // would still be waiting (16 s) if each press counted
    expect(events).toEqual([{ event: "snapshot-save", ok: false }, { event: "snapshot-save", ok: true }]);
  });
  it("a queued write survives a full storage, and Retry saves at once when space is back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await openTab();
    idb.failWrites = true;
    await a.send("setLastEventId", 1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events).toEqual([{ event: "snapshot-save", ok: false }]);
    // The write is still queued in memory, so it goes out once the page is online.
    await a.send("addPendingWrite", "PATCH", "/api/nodes/n", "{}", "typed-while-full").catch(() => {});
    expect(await queued(a)).toEqual(["typed-while-full"]);
    await expect(a.send("retrySnapshotSave")).rejects.toBeDefined(); // still full: no second notice
    expect(events).toEqual([{ event: "snapshot-save", ok: false }]);
    idb.failWrites = false;
    await a.send("retrySnapshotSave"); // no waiting for the backoff timer
    expect(events).toEqual([{ event: "snapshot-save", ok: false }, { event: "snapshot-save", ok: true }]);
    expect(await queued(await openTab())).toEqual(["typed-while-full"]);
  });
});

// A copy written by a build that speaks a newer protocol must come out of an older build's tab exactly as it went in
// (lib/localDbSchema.ts: local_copy_too_new). The risk is the tab that failed to open it, or one that already had it
// open, writing its own (empty or older) database back over it, with the queued changes inside.
describe("a copy written by a newer protocol", () => {
  const stored = () => JSON.stringify([...idb.data.entries()].map(([key, value]) => [key, value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? Buffer.from(value instanceof ArrayBuffer ? value : (value as Uint8Array).buffer).toString("hex") : value]));

  /** What a newer build leaves on disk: a queued change not sent yet, inside a stored snapshot. */
  async function newerBuildStoresACopy() {
    vi.doMock("@onden/markdown/contract", async (original) => {
      const real = await original<typeof import("@onden/markdown/contract")>();
      return { ...real, CLIENT_PROTOCOL: real.CLIENT_PROTOCOL + 1 };
    });
    try {
      const newer = await openTab();
      await newer.send("addPendingWrite", "PATCH", "/api/nodes/n", '{"markdown":"typed, not sent"}', "unsent-key");
      await newer.send("setLastEventId", 9);
      await newer.send("flushLocalDbSync");
    } finally { vi.doUnmock("@onden/markdown/contract"); }
    expect(idb.data.size).toBeGreaterThan(0);
  }
  const everyOp: Array<[string, ...unknown[]]> = [
    ["addPendingWrite", "POST", "/api/nodes", "{}", "typed-after"], ["setLastEventId", 99], ["bumpPendingWriteAttempt", 1],
    ["retrySnapshotSave"], ["flushLocalDbSync"], ["catchUpWithOtherTabs"], ["wipeWorkspaceMirror"],
  ];

  it("is not opened by an older build, which then writes nothing over it however it is used", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await newerBuildStoresACopy();
    const before = stored();
    const older = await openTab({ expectOpen: false });
    const refused = await older.attempt("initLocalDb");
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("local_copy_too_new");
    for (const [op, ...args] of everyOp) expect((await older.attempt(op, ...args)).ok, op).toBe(false);
    await settle();
    expect(stored()).toBe(before);
  });

  it("is left alone by a tab that already had its own copy open when the newer build stored it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const older = await openTab(); // opened while the disk held an older copy
    await older.send("setLastEventId", 1);
    await older.send("flushLocalDbSync");
    await newerBuildStoresACopy(); // another tab, newer build, stores over it
    await settle(); // its own pending saves land: what is stored now is what the older tab must leave alone
    const before = stored();
    for (const [op, ...args] of everyOp) { await older.attempt(op, ...args); await settle(); expect(stored(), op).toBe(before); }
  });

  it("is still there, with its queued change, for the newer build to open afterwards", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await newerBuildStoresACopy();
    const older = await openTab({ expectOpen: false });
    for (const [op, ...args] of [["initLocalDb"], ...everyOp] as Array<[string, ...unknown[]]>) await older.attempt(op, ...args);
    await settle();
    vi.doMock("@onden/markdown/contract", async (original) => {
      const real = await original<typeof import("@onden/markdown/contract")>();
      return { ...real, CLIENT_PROTOCOL: real.CLIENT_PROTOCOL + 1 };
    });
    try { expect(await queued(await openTab())).toEqual(["unsent-key"]); }
    finally { vi.doUnmock("@onden/markdown/contract"); }
  });
});
