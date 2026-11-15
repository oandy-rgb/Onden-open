// Real sql.js + the actual IndexedDB key adapter. The fake browser transaction
// boundary lets us preserve multiple disk keys and inject read/commit failures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
vi.mock("sql.js", async original => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});
const disk = new Map<string, ArrayBuffer>();
let failRead = false;
let failSave = false;
const scopeA = JSON.stringify(["https://onden.example", "a"]);
const scopeB = JSON.stringify(["https://onden.example", "b"]);
type Reply = { id: number; ok: boolean; result?: unknown; error?: string; code?: string };
type Request = { id: number; op: string; args: unknown[]; storageScope: string | null };
let receive: (event: { data: Request }) => void;
const replies = new Map<number, (reply: Reply) => void>();
let sequence = 0;
let owner: string | null = null;
function rpc(op: string, ...args: unknown[]) {
  const id = ++sequence;
  return new Promise<Reply>(resolve => { replies.set(id, resolve); receive({ data: { id, op, args, storageScope: owner } }); });
}
async function ok(op: string, ...args: unknown[]) {
  const reply = await rpc(op, ...args);
  expect(reply.ok, reply.error).toBe(true);
  return reply.result;
}
async function reopen(scope: string | null) {
  vi.resetModules(); owner = scope;
  const worker = { onmessage: null, postMessage: (reply: Reply) => { replies.get(reply.id)?.(reply); replies.delete(reply.id); } };
  vi.stubGlobal("self", worker);
  await import("../lib/localDbWorker"); receive = worker.onmessage!;
}
/** Byte-for-byte equality of two ~120 KB snapshots. toEqual on the arrays
 *  walks them element by element through the deep-equality machinery: about
 *  a second per test, which crossed the 5 s timeout on a busy machine. */
function expectSameBytes(actual: ArrayBuffer | undefined, expected: ArrayBuffer | undefined) {
  expect(actual, "snapshot on disk").toBeDefined(); expect(expected, "reference snapshot").toBeDefined();
  const a = new Uint8Array(actual!), b = new Uint8Array(expected!);
  const at = a.length !== b.length ? Math.min(a.length, b.length) : a.findIndex((byte, i) => byte !== b[i]);
  expect(at, `snapshots differ at byte ${at} (${a.length} vs ${b.length} bytes)`).toBe(-1);
}
function installDisk() {
  const db = { close: vi.fn(), transaction: () => {
    const tx = { error: new Error("storage unavailable"), oncomplete: null as (() => void) | null,
      onabort: null as (() => void) | null, onerror: null as (() => void) | null,
      objectStore: () => ({
        get: (key: string) => {
          const req = { result: disk.get(key), error: tx.error, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
          queueMicrotask(() => { if (failRead) req.onerror?.(); else req.onsuccess?.(); }); return req;
        },
        put: (bytes: ArrayBuffer, key: string) => {
          queueMicrotask(() => { if (failSave) tx.onabort?.(); else { disk.set(key, bytes); tx.oncomplete?.(); } });
        },
      }),
    }; return tx;
  } };
  vi.stubGlobal("indexedDB", { open: () => {
    const req = { result: db, onsuccess: null as (() => void) | null };
    queueMicrotask(() => req.onsuccess?.()); return req;
  } });
}
const bootstrap = { workspace: { id: "w", name: "Shared workspace", slug: "w" }, nodes: [], tasks: [], edges: [], suggestions: [], events: [] };
const input = '{"markdown":"只屬於 A 的未同步文字"}';

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); disk.clear(); failRead = false; failSave = false; installDisk(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("account-owned local snapshots", () => {
  it("A→B→A keeps pending, rejected, mirror and cursors isolated across reopened workers", async () => {
    await reopen(scopeA); await ok("persistBootstrap", bootstrap);
    await ok("setLastEventId", 73); await ok("upsertAttribute", "n", "ink", "A private ink");
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", input, "same-key");
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", input, "refused-key");
    const rows = await ok("getPendingWrites") as unknown[];
    await ok("rejectPendingWrite", rows[1], "Denied");
    const aBytes = disk.get(`db:account-v1:${scopeA}`);
    await reopen(scopeB);
    expect(await ok("getPendingWrites")).toEqual([]);
    expect(await ok("getRejectedWrites")).toEqual([]);
    expect(await ok("loadBootstrap")).toBeNull();
    expect(await ok("getNodeAttribute", "n", "ink")).toBeNull();
    expect(await ok("getLastEventId")).toBe(0);
    await ok("persistBootstrap", bootstrap); await ok("addPendingWrite", "POST", "/api/nodes", '{"title":"B"}', "b-key");
    expectSameBytes(disk.get(`db:account-v1:${scopeA}`), aBytes);
    await reopen(scopeA);
    expect(await ok("getPendingWrites")).toEqual([expect.objectContaining({ body: input, idem_key: "same-key" })]);
    expect(await ok("getRejectedWrites")).toEqual([expect.objectContaining({ body: input, idem_key: "refused-key" })]);
    expect(await ok("getLastEventId")).toBe(73);
    expect(await ok("getNodeAttribute", "n", "ink")).toBe("A private ink");
  });

  it("retains unowned legacy bytes but never adopts their mirror or queue into a web account", async () => {
    await reopen(null); await ok("persistBootstrap", bootstrap); await ok("addPendingWrite", "PATCH", "/api/nodes/n", input, "legacy-key");
    const legacy = disk.get("db");
    await reopen(scopeA); expect(await ok("getPendingWrites")).toEqual([]); expect(await ok("loadBootstrap")).toBeNull();
    await ok("persistBootstrap", bootstrap); await ok("flushLocalDbSync");
    expectSameBytes(disk.get("db"), legacy);
    const refused = await rpc("importDatabase", legacy);
    expect(refused.error).toContain("account and server");
    // The UI decides by this code, not the English text.
    expect(refused.code).toBe("backup_foreign_account");
    expectSameBytes(disk.get("db"), legacy);
  });

  it("rejects another account or server's backup in the same workspace, accepts its own and preserves the original key", async () => {
    await reopen(scopeA); await ok("persistBootstrap", bootstrap); await ok("addPendingWrite", "PATCH", "/api/nodes/n", input, "original-key");
    const exported = await ok("exportDatabase");
    for (const scope of [scopeB, JSON.stringify(["https://other.example", "a"])]) {
      await reopen(scope); await ok("persistBootstrap", bootstrap); await ok("flushLocalDbSync");
      const bytes = disk.get(`db:account-v1:${scope}`);
      expect((await rpc("importDatabase", exported)).error).toContain("account and server");
      expect(await ok("getPendingWrites")).toEqual([]); expectSameBytes(disk.get(`db:account-v1:${scope}`), bytes);
    }
    await reopen(scopeA); await ok("clearPendingWrite", 1); await ok("importDatabase", exported);
    expect(await ok("getPendingWrites")).toEqual([expect.objectContaining({ body: input, idem_key: "original-key" })]);
  });

  it("refuses storage-owner changes on a live worker before reading or saving", async () => {
    await reopen(scopeA); await ok("initLocalDb");
    owner = scopeB;
    expect((await rpc("addPendingWrite", "PATCH", "/api/nodes/n", input, "key")).error).toContain("account changed");
    expect(disk.size).toBe(0);
    owner = scopeA; expect(await ok("getPendingWrites")).toEqual([]);
  });

  it("failed reads and failed imports cannot replace an acknowledged snapshot", async () => {
    await reopen(scopeA); await ok("persistBootstrap", bootstrap); await ok("addPendingWrite", "PATCH", "/api/nodes/n", input, "key");
    const bytes = disk.get(`db:account-v1:${scopeA}`)!;
    await reopen(scopeA); failRead = true;
    expect((await rpc("addPendingWrite", "POST", "/api/nodes", "{}", "new")).ok).toBe(false);
    expectSameBytes(disk.get(`db:account-v1:${scopeA}`), bytes);
    failRead = false; await ok("initLocalDb"); failSave = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await rpc("importDatabase", bytes)).ok).toBe(false);
    expectSameBytes(disk.get(`db:account-v1:${scopeA}`), bytes);
    expect(await ok("getPendingWrites")).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("rejects a foreign snapshot even if accidentally stored under the current account key", async () => {
    await reopen(scopeA); await ok("persistBootstrap", bootstrap); await ok("flushLocalDbSync");
    disk.set(`db:account-v1:${scopeB}`, disk.get(`db:account-v1:${scopeA}`)!);
    await reopen(scopeB); expect((await rpc("loadBootstrap")).error).toContain("account and server");
    const SQL = await initSqlJs(); const db = new SQL.Database(new Uint8Array(disk.get(`db:account-v1:${scopeB}`)!));
    expect(db.exec("SELECT scope FROM local_account")[0].values).toEqual([[scopeA]]); db.close();
  });
});
