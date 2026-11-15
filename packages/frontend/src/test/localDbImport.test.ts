import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import { prepareLocalDatabase } from "../lib/localDbSchema";

const disk = vi.hoisted(() => ({ bytes: null as ArrayBuffer | null, save: vi.fn() }));
vi.mock("../lib/indexedDbStorage", () => ({ idbLoad: async () => disk.bytes, idbSave: disk.save }));
vi.mock("sql.js", async (original) => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});

let receive: (event: { data: { id: number; op: string; args: unknown[]; storageScope: string | null } }) => void;
let sequence = 0;
const replies = new Map<number, (reply: { ok: boolean; result?: unknown; error?: string }) => void>();

async function snapshot(title: string, workspace = "w"): Promise<ArrayBuffer> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  prepareLocalDatabase(db);
  db.run("INSERT INTO workspace (id, name, slug) VALUES (?, 'Test', 'test')", [workspace]);
  db.run("INSERT INTO nodes (id, source_type, node_type, title, slug, markdown) VALUES ('n', 'local', 'note', ?, 'note', ?)", [title, title]);
  const bytes = db.export().buffer as ArrayBuffer;
  db.close();
  return bytes;
}

function rpc(op: string, ...args: unknown[]) {
  const id = ++sequence;
  return new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
    replies.set(id, resolve);
    receive({ data: { id, op, args, storageScope: null } });
  });
}

async function diskTitle() {
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(disk.bytes!));
  const title = db.exec("SELECT title FROM nodes")[0]?.values[0][0];
  db.close();
  return title;
}

beforeEach(async () => {
  vi.resetModules();
  disk.bytes = await snapshot("Original");
  disk.save.mockReset().mockImplementation(async (bytes: ArrayBuffer) => { disk.bytes = bytes; });
  const worker = { onmessage: null, postMessage: (reply: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    replies.get(reply.id)?.(reply); replies.delete(reply.id);
  } };
  vi.stubGlobal("self", worker);
  await import("../lib/localDbWorker");
  receive = worker.onmessage!;
  await rpc("initLocalDb");
});

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllTimers(); });

describe("local backup import commit", () => {
  it("acknowledges import only after the replacement snapshot is durable", async () => {
    let commit!: () => void;
    disk.save.mockImplementationOnce((bytes: ArrayBuffer) => new Promise<void>((resolve) => {
      commit = () => { disk.bytes = bytes; resolve(); };
    }));
    let completed = false;
    const imported = rpc("importDatabase", await snapshot("Restored")).then((reply) => { completed = true; return reply; });
    await vi.waitFor(() => expect(disk.save).toHaveBeenCalled());
    expect(completed).toBe(false);
    expect(await diskTitle()).toBe("Original");
    commit();
    expect((await imported).ok).toBe(true);
    expect(await diskTitle()).toBe("Restored");
  });

  it("keeps both the active database and disk when the replacement cannot be saved", async () => {
    disk.save.mockRejectedValueOnce(new DOMException("Full", "QuotaExceededError"));
    expect((await rpc("importDatabase", await snapshot("Restored"))).ok).toBe(false);
    expect((await rpc("searchNodes", "Original")).result).toEqual([{ id: "n", snippet: { text: "Original", ranges: [[0, 8]] } }]);
    expect(await diskTitle()).toBe("Original");
  });

  it("rejects an unrelated SQLite database and keeps the current notes", async () => {
    const SQL = await initSqlJs(); const unrelated = new SQL.Database();
    unrelated.run("CREATE TABLE something_else (value TEXT)");
    const bytes = unrelated.export().buffer as ArrayBuffer; unrelated.close();
    expect((await rpc("importDatabase", bytes)).ok).toBe(false);
    expect((await rpc("searchNodes", "Original")).result).toEqual([{ id: "n", snippet: { text: "Original", ranges: [[0, 8]] } }]);
  });

  it("rejects a different workspace before installing or persisting its queued changes", async () => {
    expect((await rpc("importDatabase", await snapshot("Other", "other-workspace"))).ok).toBe(false);
    expect(await diskTitle()).toBe("Original");
  });

  it("makes operations received during an import run against the committed database", async () => {
    let commit!: () => void;
    disk.save.mockImplementationOnce((bytes: ArrayBuffer) => new Promise<void>((resolve) => {
      commit = () => { disk.bytes = bytes; resolve(); };
    }));
    const imported = rpc("importDatabase", await snapshot("Restored"));
    await vi.waitFor(() => expect(disk.save).toHaveBeenCalled());
    let readDone = false;
    const reading = rpc("searchNodes", "Restored").then((reply) => { readDone = true; return reply; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readDone).toBe(false);
    commit(); await imported;
    expect((await reading).result).toEqual([{ id: "n", snippet: { text: "Restored", ranges: [[0, 8]] } }]);
  });

  it("keeps later edits when an old background snapshot was pending at replacement", async () => {
    await rpc("upsertAttribute", "n", "course", "Old"); // Arms a background save.
    await rpc("importDatabase", await snapshot("Restored"));
    await rpc("upsertAttribute", "n", "course", "New");
    await rpc("flushLocalDbSync");
    expect((await rpc("getNodeAttribute", "n", "course")).result).toBe("New");
    expect(await diskTitle()).toBe("Restored");
    const SQL = await initSqlJs(); const saved = new SQL.Database(new Uint8Array(disk.bytes!));
    expect(saved.exec("SELECT value FROM node_attributes WHERE key = 'course'")[0].values).toEqual([["New"]]);
    saved.close();
  });
});
