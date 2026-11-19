// The local database's write-ahead journal (lib/localDbJournal, mobile perf
// #5): durable changes are one small record instead of a whole-database save,
// and the snapshot follows as compaction. Real sql.js worker RPCs; IndexedDB
// is replaced at both save boundaries (the snapshot and the journal) so a
// crash, an aborted save and a lost cleanup can be reproduced exactly.
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import initSqlJs from "sql.js";
import type { JournalApplied, JournalEntry } from "../lib/localDbJournal";
import { latestBySession, replayJournalInto, unappliedEntries } from "../lib/localDbJournal";
import { prepareLocalDatabase } from "../lib/localDbSchema";

const disk = vi.hoisted(() => ({ bytes: null as ArrayBuffer | null, save: vi.fn() }));
const journal = vi.hoisted(() => ({
  available: true,
  rows: new Map<string, unknown>(),
  append: vi.fn(), read: vi.fn(), drop: vi.fn(), clear: vi.fn(),
}));
vi.mock("../lib/indexedDbStorage", () => ({ idbLoad: async () => disk.bytes, idbSave: disk.save }));
vi.mock("../lib/localDbJournal", async original => {
  const real = await original<typeof import("../lib/localDbJournal")>();
  return {
    ...real,
    journalAvailable: () => journal.available,
    journalAppend: (...args: unknown[]) => journal.append(...args),
    journalRead: (...args: unknown[]) => journal.read(...args),
    journalDrop: (...args: unknown[]) => journal.drop(...args),
    journalClear: (...args: unknown[]) => journal.clear(...args),
  };
});
vi.mock("sql.js", async original => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});

type Reply = { ok: boolean; result?: unknown; error?: string };
let receive: (event: { data: { id: number; op: string; args: unknown[]; storageScope: string | null } }) => void;
let sequence = 0;
const replies = new Map<number, (reply: Reply) => void>();
function rpc(op: string, ...args: unknown[]) {
  const id = ++sequence;
  return new Promise<Reply>(resolve => { replies.set(id, resolve); receive({ data: { id, op, args, storageScope: "acct" } }); });
}
async function ok(op: string, ...args: unknown[]) {
  const reply = await rpc(op, ...args);
  expect(reply.ok, reply.error).toBe(true);
  return reply.result;
}
/** A new worker on whatever is on "disk": a reload, or a restart after a crash. */
async function reopenWorker() {
  // The previous worker is gone: its pending timers die with it.
  vi.clearAllTimers();
  vi.resetModules();
  const worker = { onmessage: null, postMessage: (reply: Reply & { id: number }) => {
    replies.get(reply.id)?.(reply); replies.delete(reply.id);
  } };
  vi.stubGlobal("self", worker);
  await import("../lib/localDbWorker");
  receive = worker.onmessage!;
  await ok("initLocalDb");
}
/** Let the debounced snapshot (2 s mirror, 15 s compaction) run. */
async function settle() {
  await vi.advanceTimersByTimeAsync(20_000);
}
const entries = () => [...journal.rows.values()] as JournalEntry[];
const node = { id: "n", source_type: "manual", node_type: "content", title: "Note", slug: "note", markdown: "body", parent_id: null, hidden: false, order_key: "a0" };
const bootstrap = { workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes: [node], tasks: [], edges: [], suggestions: [], events: [] };
const bodies = async () => ((await ok("getPendingWrites")) as Array<{ body: string }>).map(w => w.body);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  disk.bytes = null;
  disk.save.mockReset().mockImplementation(async (bytes: ArrayBuffer) => { disk.bytes = bytes; });
  journal.available = true;
  journal.rows.clear();
  const key = (scope: string, e: { session: string; seq: number }) => `${scope}|${e.session}|${String(e.seq).padStart(9, "0")}`;
  journal.append.mockReset().mockImplementation(async (scope: string, e: JournalEntry) => { journal.rows.set(key(scope, e), structuredClone(e)); });
  journal.read.mockReset().mockImplementation(async (scope: string) =>
    [...journal.rows.entries()].filter(([k]) => k.startsWith(`${scope}|`)).sort(([a], [b]) => a < b ? -1 : 1).map(([, e]) => structuredClone(e)));
  journal.drop.mockReset().mockImplementation(async (scope: string, applied: JournalApplied) => {
    for (const [k, e] of [...journal.rows.entries()]) {
      const entry = e as JournalEntry;
      if (k.startsWith(`${scope}|`) && entry.seq <= (applied[entry.session] ?? 0)) journal.rows.delete(k);
    }
  });
  journal.clear.mockReset().mockImplementation(async (scope: string) => {
    for (const k of [...journal.rows.keys()]) if (k.startsWith(`${scope}|`)) journal.rows.delete(k);
  });
  await reopenWorker();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("queued writes", () => {
  it("are durable after one journal record, without a whole-database save", async () => {
    await ok("persistBootstrap", bootstrap);
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", '{"markdown":"a"}', "k1");
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", '{"markdown":"b"}', "k2");
    expect(journal.append).toHaveBeenCalledTimes(2);
    expect(disk.save).not.toHaveBeenCalled();
    // Killed before any snapshot: both come back.
    await reopenWorker();
    expect(await bodies()).toEqual(['{"markdown":"a"}', '{"markdown":"b"}']);
  });

  it("coalesce into one snapshot, which then empties the journal", async () => {
    for (let i = 0; i < 10; i++) await ok("addPendingWrite", "PATCH", "/api/nodes/n", `{"markdown":"${i}"}`, `k${i}`);
    await ok("persistBootstrap", bootstrap);
    await settle();
    expect(disk.save).toHaveBeenCalledTimes(1);
    expect(entries()).toEqual([]);
    await reopenWorker();
    expect(await bodies()).toHaveLength(10);
    // Loading found nothing to replay or clean: no extra save.
    await settle();
    expect(disk.save).toHaveBeenCalledTimes(1);
  });

  it("clearing, rejecting and dismissing are journaled too and survive a crash", async () => {
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", '{"markdown":"sent"}', "sent");
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", '{"markdown":"refused"}', "refused");
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", '{"markdown":"dropped"}', "dropped");
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", '{"markdown":"kept"}', "kept");
    const [sent, refused, dropped] = await ok("getPendingWrites") as Array<{ id: number }>;
    await ok("clearPendingWrite", sent.id);
    await ok("rejectPendingWrite", refused, "Denied");
    const rejectedDropped = await ok("rejectPendingWrite", dropped, "Denied");
    await ok("dismissRejectedWrite", rejectedDropped);
    expect(disk.save).not.toHaveBeenCalled();
    await reopenWorker();
    expect(await bodies()).toEqual(['{"markdown":"kept"}']);
    expect(await ok("getRejectedWrites")).toEqual([expect.objectContaining({ idem_key: "refused", rejection: "Denied" })]);
  });

  it("keep their ids across a crash, so later records act on the same row", async () => {
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "1", "k1");
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "2", "k2");
    await ok("clearPendingWrite", 1);
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "3", "k3");
    const before = await ok("getPendingWrites");
    await reopenWorker();
    expect(await ok("getPendingWrites")).toEqual(before);
    await ok("clearPendingWrite", 3);
    await reopenWorker();
    expect(await bodies()).toEqual(["2"]);
  });
});

describe("crash or abort in the middle of a save", () => {
  it("an aborted snapshot save keeps every journal record, and the save is retried", async () => {
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "queued", "k1");
    await ok("persistBootstrap", bootstrap);
    disk.save.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(disk.save).toHaveBeenCalledTimes(1);
    expect(entries()).toHaveLength(1);
    // The retry waits longer after each failure (4 s after the first).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(disk.save).toHaveBeenCalledTimes(1);
    // Crash now: the old (absent) snapshot plus the journal.
    const journalAtCrash = new Map(journal.rows);
    await settle();
    expect(disk.save).toHaveBeenCalledTimes(2);
    expect(entries()).toEqual([]);
    disk.bytes = null; journal.rows = journalAtCrash;
    await reopenWorker();
    expect(await bodies()).toEqual(["queued"]);
  });

  it("a crash after the snapshot commit but before the journal cleanup does not apply records twice", async () => {
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "first", "k1");
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "second", "k2");
    journal.drop.mockRejectedValueOnce(new Error("killed"));
    await settle();
    expect(disk.save).toHaveBeenCalledTimes(1);
    expect(entries()).toHaveLength(2);
    // Sent and cleared after the snapshot: replaying the stale "put" must not revive it.
    await ok("clearPendingWrite", 1);
    await reopenWorker();
    expect(await bodies()).toEqual(["second"]);
    await settle();
    expect(entries()).toEqual([]);
    await reopenWorker();
    expect(await bodies()).toEqual(["second"]);
  });

  it("a write whose record never committed reports failure and falls back to one whole save", async () => {
    journal.append.mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "fallback", "k1");
    expect(disk.save).toHaveBeenCalledTimes(1);
    await reopenWorker();
    expect(await bodies()).toEqual(["fallback"]);
  });

  it("when neither the record nor the snapshot can be written, the write is refused", async () => {
    journal.append.mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
    disk.save.mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
    const reply = await rpc("addPendingWrite", "PATCH", "/api/nodes/n", "lost", "k1");
    expect(reply.ok).toBe(false);
  });

  it("an unreadable journal fails initialization instead of looking empty", async () => {
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "queued", "k1");
    journal.read.mockRejectedValueOnce(new Error("IndexedDB unavailable"));
    vi.clearAllTimers();
    vi.resetModules();
    const worker = { onmessage: null, postMessage: (reply: Reply & { id: number }) => { replies.get(reply.id)?.(reply); replies.delete(reply.id); } };
    vi.stubGlobal("self", worker);
    await import("../lib/localDbWorker");
    receive = worker.onmessage!;
    expect((await rpc("initLocalDb")).ok).toBe(false);
    expect(await bodies()).toEqual(["queued"]);
  });
});

describe("existing devices", () => {
  /** A snapshot written by the previous build: queued writes inside it, no journal state. */
  async function previousBuildSnapshot() {
    const SQL = await initSqlJs();
    const old = new SQL.Database();
    old.run("CREATE TABLE local_account (scope TEXT NOT NULL)");
    old.run("INSERT INTO local_account VALUES ('acct')");
    prepareLocalDatabase(old);
    old.run("INSERT INTO pending_writes (method, path, body, idem_key) VALUES ('PATCH', '/api/nodes/n', 'from old build', 'old-key')");
    old.run("INSERT INTO workspace (id, name, slug) VALUES ('w', 'Test', 'test')");
    const bytes = old.export().buffer as ArrayBuffer;
    old.close();
    return bytes;
  }

  it("load an old snapshot on first run and keep its queue through a crash and a compaction", async () => {
    disk.bytes = await previousBuildSnapshot();
    await reopenWorker();
    expect(await bodies()).toEqual(["from old build"]);
    expect(disk.save).not.toHaveBeenCalled();
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "from new build", "new-key");
    // Crash before the first snapshot of the new build ("mid-migration").
    await reopenWorker();
    expect(await bodies()).toEqual(["from old build", "from new build"]);
    await settle();
    expect(entries()).toEqual([]);
    await reopenWorker();
    expect(await bodies()).toEqual(["from old build", "from new build"]);
  });

  it("without a journal (no IndexedDB), queued writes await one whole save, as before", async () => {
    journal.available = false;
    await reopenWorker();
    await ok("persistBootstrap", bootstrap);
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "no journal", "k1");
    // One export, not two, even with mirror changes pending.
    expect(disk.save).toHaveBeenCalledTimes(1);
    expect(journal.append).not.toHaveBeenCalled();
    await reopenWorker();
    expect(await bodies()).toEqual(["no journal"]);
  });
});

describe("other durable changes", () => {
  it("a note delete is journaled and cannot be resurrected by the older snapshot", async () => {
    await ok("persistBootstrap", bootstrap);
    await ok("flushLocalDbSync");
    expect(disk.save).toHaveBeenCalledTimes(1);
    await ok("removeNode", "n");
    expect(disk.save).toHaveBeenCalledTimes(1);
    await reopenWorker();
    expect(await ok("getAllNodeIds")).toEqual([]);
  });

  it("the unload flush saves only when mirror changes are pending", async () => {
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "queued", "k1");
    await ok("flushLocalDbSync");
    expect(disk.save).not.toHaveBeenCalled();
    await ok("persistBootstrap", bootstrap);
    await ok("flushLocalDbSync");
    expect(disk.save).toHaveBeenCalledTimes(1);
    expect(entries()).toEqual([]);
  });

  it("wiping the mirror (access revoked) also drops the journal", async () => {
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "revoked", "k1");
    await ok("wipeWorkspaceMirror");
    expect(entries()).toEqual([]);
    await reopenWorker();
    expect(await bodies()).toEqual([]);
  });

  it("an imported backup replaces the queue: older records do not replay onto it", async () => {
    await ok("persistBootstrap", bootstrap);
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "before import", "k1");
    const backup = await ok("exportDatabase") as ArrayBuffer;
    await ok("clearPendingWrite", 1);
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "replaced by the backup", "k2");
    await ok("importDatabase", backup);
    await reopenWorker();
    expect(await bodies()).toEqual(["before import"]);
  });

  it("records another tab journaled are replayed and merged by idempotency key", async () => {
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", "this tab", "mine");
    // Another tab queued a request under the same row id, after this one (rows are ordered by when they were made).
    const [mine] = entries();
    const row = (mine.op as { row: { id: number; made_at: number } }).row;
    journal.rows.set("db:account-v1:acct|other|000000001", { session: "other", seq: 1, op: { t: "pw.put", row: {
      id: row.id, method: "PATCH", path: "/api/nodes/n", body: "other tab", idem_key: "theirs",
      attempts: 0, rejection: null, created_at: "2026-10-19 00:00:00", targets: null, made_at: row.made_at + 1 } } });
    await reopenWorker();
    expect(await bodies()).toEqual(["this tab", "other tab"]);
    await settle();
    expect(entries()).toEqual([]);
    await reopenWorker();
    expect(await bodies()).toEqual(["this tab", "other tab"]);
  });
});

describe("replay", () => {
  it("skips what a snapshot already contains, per session", () => {
    const e = (session: string, seq: number) => ({ session, seq, op: { t: "pw.del" as const, id: 1, idem_key: "k" } });
    const all = [e("a", 1), e("a", 2), e("b", 1)];
    expect(unappliedEntries(all, { a: 1 })).toEqual([e("b", 1), e("a", 2)]);
    expect(latestBySession(all)).toEqual({ a: 2, b: 1 });
  });

  it("reports and skips a record that cannot be applied, keeping the rest", async () => {
    const SQL = await initSqlJs();
    const d = new SQL.Database();
    prepareLocalDatabase(d);
    const row = { id: 7, method: "PATCH", path: "/p", body: "kept", idem_key: "k", attempts: 0, rejection: null, created_at: "2026-10-19 00:00:00", targets: null };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = replayJournalInto(d, [
      { session: "s", seq: 1, op: { t: "pw.put", row: { ...row, method: null as unknown as string, id: 3, idem_key: "bad" } } },
      { session: "s", seq: 2, op: { t: "pw.put", row } },
    ]);
    spy.mockRestore();
    expect(failed).toBe(1);
    expect(d.exec("SELECT id, body FROM pending_writes")[0].values).toEqual([[7, "kept"]]);
    d.close();
  });
});

// The fault e2e closeMidSave.spec.ts 5b, second half. A page killed while a note save is on its way, after the
// save's text reached this mirror and the mirror's 2 s save landed. This used to leave the text in the copy with
// no queue row (the mirror was written first, the row only if the save ended "queued"): it showed as saved after
// a reopen, nothing sent it, and the next whole refresh or a server copy of the note put the server's text back.
// Fixed: every save records its queue row before the mirror changes (lib/data/writeQueue.ts recordWrite), so a
// copy holding the text always holds the row, and pendingNoteProjection keeps the text until the row is sent.
describe("a save the page died during, after its text reached the mirror", () => {
  const stored = async () => ((await ok("getStoredBody", "n")) as { markdown?: string } | string | null);
  const bodyOf = (value: Awaited<ReturnType<typeof stored>>) => (typeof value === "string" ? value : value?.markdown ?? null);
  it("is still on its way to the server after a reopen and the daily whole refresh", async () => {
    await ok("persistBootstrap", bootstrap); // the server's text: "body"
    await settle();
    await ok("addPendingWrite", "PATCH", "/api/nodes/n", JSON.stringify({ markdown: "body typed" }), "the-save"); // recordWrite: the row first
    await ok("upsertNode", { ...node, markdown: "body typed" }); // then the save's mirror step
    await settle(); // its 2 s mirror save lands; the page is killed before the save is answered
    await reopenWorker();
    const afterReopen = bodyOf(await stored());
    const queued = (await bodies()).length;
    await ok("persistBootstrap", bootstrap); // the daily whole refresh (syncEngine refreshOnReopen)
    const afterRefresh = bodyOf(await stored());
    await ok("upsertNode", { ...node, markdown: "body typed" });
    await ok("persistRemoteNode", node); // opening it in a large workspace (hydrateNode) reads the server's copy
    const afterServerCopy = bodyOf(await stored());
    expect({ afterReopen, queued, afterRefresh, afterServerCopy })
      .toEqual({ afterReopen: "body typed", queued: 1, afterRefresh: "body typed", afterServerCopy: "body typed" });
  });
});
