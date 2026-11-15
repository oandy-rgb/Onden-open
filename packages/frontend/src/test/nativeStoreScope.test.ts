// D92: the local database and its write queue are scoped per server + account
// on the native app too, so switching Backend URL never replays server A's
// queued writes to server B; the old unscoped native store is adopted only by
// the account on the server it was made against (lib/accountStorage).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import { prepareLocalDatabase } from "../lib/localDbSchema";

// One fake IndexedDB keyed like indexedDbStorage's snapshotKey.
const disk = vi.hoisted(() => new Map<string, ArrayBuffer>());
vi.mock("../lib/indexedDbStorage", () => {
  const key = (scope: string | null) => (scope === null ? "db" : `db:account-v1:${scope}`);
  return {
    idbLoad: async (scope: string | null = null) => disk.get(key(scope)) ?? null,
    idbSave: async (bytes: ArrayBuffer, scope: string | null = null) => { disk.set(key(scope), bytes); },
    idbAdoptLegacy: async (bytes: ArrayBuffer, scope: string) => { disk.set(key(scope), bytes); disk.delete("db"); },
  };
});
vi.mock("sql.js", async (original) => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});

const A = JSON.stringify(["https://a.example", "u"]);
const B = JSON.stringify(["https://b.example", "u"]);
type Reply = { id: number; ok: boolean; result?: unknown; error?: string };

/** A fresh worker (a new page lifetime) pinned to one scope. */
async function page(storageScope: string, adoptLegacy = false) {
  vi.resetModules();
  const replies = new Map<number, (reply: Reply) => void>();
  const worker: { onmessage: ((ev: { data: unknown }) => void) | null; postMessage: (r: Reply) => void } = {
    onmessage: null,
    postMessage: (reply) => { replies.get(reply.id)?.(reply); replies.delete(reply.id); },
  };
  vi.stubGlobal("self", worker);
  await import("../lib/localDbWorker");
  let sequence = 0;
  return (op: string, ...args: unknown[]) => new Promise<Reply>((resolve) => {
    const id = ++sequence;
    replies.set(id, resolve);
    worker.onmessage!({ data: { id, op, args, storageScope, adoptLegacy } });
  });
}

async function legacySnapshot(): Promise<ArrayBuffer> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  prepareLocalDatabase(db);
  db.run("INSERT INTO pending_writes (method, path, body) VALUES ('PATCH', '/api/nodes/n', '{\"markdown\":\"offline edit\"}')");
  const bytes = db.export().buffer as ArrayBuffer;
  db.close();
  return bytes;
}

beforeEach(() => { disk.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("native local store scope", () => {
  it("a Backend URL change opens the other server's own queue, not A's", async () => {
    let rpc = await page(A);
    expect((await rpc("addPendingWrite", "PATCH", "/api/nodes/n", "{}", "k-a")).ok).toBe(true);
    await rpc("flushLocalDbSync");
    expect((await rpc("getPendingWrites")).result).toHaveLength(1);

    rpc = await page(B);
    expect((await rpc("getPendingWrites")).result).toEqual([]);

    rpc = await page(A);
    expect((await rpc("getPendingWrites")).result).toEqual([expect.objectContaining({ idem_key: "k-a" })]);
  });

  it("the account on the old store's server adopts it once, under its own key", async () => {
    disk.set("db", await legacySnapshot());
    const rpc = await page(A, true);
    expect((await rpc("getPendingWrites")).result).toEqual([expect.objectContaining({ path: "/api/nodes/n" })]);
    expect(disk.has("db")).toBe(false);
    expect(disk.has(`db:account-v1:${A}`)).toBe(true);
  });

  it("any other server leaves the old store quarantined and unopened", async () => {
    const legacy = await legacySnapshot();
    disk.set("db", legacy);
    const rpc = await page(B, false);
    expect((await rpc("getPendingWrites")).result).toEqual([]);
    expect(disk.get("db")).toBe(legacy);
  });
});
