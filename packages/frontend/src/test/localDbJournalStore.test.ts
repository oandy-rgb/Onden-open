// The journal's own IndexedDB store and its replay, run against a real IndexedDB
// (fake-indexeddb) instead of the mock localDbJournal.test.ts puts in its place:
// that file proves the worker's crash handling but never reaches journalAppend /
// journalRead / journalDrop / journalClear, so the key layout, the per-snapshot
// scoping and the delete range were unprotected (docs/archive/research/mutation-2026-10-24.md).
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import initSqlJs from "sql.js";
import type { Database } from "sql.js";
import type { JournalEntry, JournalRow } from "../lib/localDbJournal";
import { prepareLocalDatabase } from "../lib/localDbSchema";

type Journal = typeof import("../lib/localDbJournal");
let j: Journal;

// A fresh database and a fresh module each time: the connection is cached per module.
beforeEach(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.resetModules();
  j = await import("../lib/localDbJournal");
});
afterEach(() => { vi.unstubAllGlobals(); });

const del = (session: string, seq: number, key = "k"): JournalEntry => ({ session, seq, op: { t: "pw.del", id: seq, idem_key: key } });

describe("journalScopeKey / journalAvailable", () => {
  it("names the signed-out snapshot 'db' and an account's by the account", () => {
    expect(j.journalScopeKey(null)).toBe("db");
    expect(j.journalScopeKey("u1")).toBe("db:account-v1:u1");
    expect(j.journalScopeKey("")).toBe("db:account-v1:");
  });

  it("is available only where both IndexedDB and key ranges exist", () => {
    expect(j.journalAvailable()).toBe(true);
    vi.stubGlobal("indexedDB", undefined);
    expect(j.journalAvailable()).toBe(false);
    vi.unstubAllGlobals();
    vi.stubGlobal("IDBKeyRange", undefined);
    expect(j.journalAvailable()).toBe(false);
  });
});

describe("the store", () => {
  it("returns nothing for a snapshot that has no records", async () => {
    expect(await j.journalRead("db")).toEqual([]);
  });

  it("returns appended records ordered by session, then seq", async () => {
    await j.journalAppend("db", del("b", 1));
    await j.journalAppend("db", del("a", 2));
    await j.journalAppend("db", del("a", 10));
    await j.journalAppend("db", del("a", 1));
    expect((await j.journalRead("db")).map((e) => [e.session, e.seq])).toEqual([["a", 1], ["a", 2], ["a", 10], ["b", 1]]);
  });

  it("keeps the whole record, and a record appended twice stays one", async () => {
    const entry: JournalEntry = { session: "s", seq: 4, op: { t: "sql", stmts: [["DELETE FROM x WHERE id=?", ["n1"]]] } };
    await j.journalAppend("db", entry);
    await j.journalAppend("db", entry);
    expect(await j.journalRead("db")).toEqual([entry]);
  });

  it("keeps one snapshot's records away from another's, including a key that merely starts the same", async () => {
    await j.journalAppend("db", del("s", 1));
    await j.journalAppend("db:account-v1:u1", del("s", 2));
    await j.journalAppend("db:account-v1:u10", del("s", 3));
    await j.journalAppend("db:account-v1:u1:x", del("s", 4));
    expect((await j.journalRead("db")).map((e) => e.seq)).toEqual([1]);
    expect((await j.journalRead("db:account-v1:u1")).map((e) => e.seq)).toEqual([2]);
    expect((await j.journalRead("db:account-v1:u10")).map((e) => e.seq)).toEqual([3]);
  });

  it("drops, per session, the records a saved snapshot contains (seq <= applied) and nothing else", async () => {
    for (const [s, n] of [["a", 1], ["a", 2], ["a", 3], ["b", 1], ["b", 2], ["c", 1]] as const) await j.journalAppend("db", del(s, n));
    await j.journalAppend("other", del("a", 1));
    await j.journalDrop("db", { a: 2, b: 0 });
    expect((await j.journalRead("db")).map((e) => `${e.session}${e.seq}`)).toEqual(["a3", "b1", "b2", "c1"]);
    expect((await j.journalRead("other")).map((e) => `${e.session}${e.seq}`)).toEqual(["a1"]);
    await j.journalDrop("db", { c: 1, b: 2 });
    expect((await j.journalRead("db")).map((e) => `${e.session}${e.seq}`)).toEqual(["a3"]);
  });

  it("drops nothing for an empty applied map, and a record at seq 0 only when the session says 0", async () => {
    await j.journalAppend("db", del("a", 0));
    await j.journalDrop("db", {});
    expect(await j.journalRead("db")).toHaveLength(1);
    await j.journalDrop("db", { a: 0 });
    expect(await j.journalRead("db")).toEqual([]);
  });

  it("clears one snapshot's records, not the others'", async () => {
    await j.journalAppend("db", del("a", 1));
    await j.journalAppend("db", del("b", 7));
    await j.journalAppend("db:account-v1:u1", del("a", 1));
    await j.journalClear("db");
    expect(await j.journalRead("db")).toEqual([]);
    expect(await j.journalRead("db:account-v1:u1")).toHaveLength(1);
  });

  it("rejects, rather than looking empty, when a record cannot be stored", async () => {
    await expect(j.journalAppend("db", { session: "s", seq: Number.NaN, op: { t: "sql", stmts: [] } })).rejects.toBeTruthy();
    expect(await j.journalRead("db")).toEqual([]);
  });

  it("reaches records written before, from a second module instance (a reload)", async () => {
    await j.journalAppend("db", del("a", 1));
    vi.resetModules();
    const again = await import("../lib/localDbJournal");
    expect((await again.journalRead("db")).map((e) => e.seq)).toEqual([1]);
  });

  it("adds its store to a database of that name that was created without one", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("onden-journal", 1);
      req.onupgradeneeded = () => { req.result.createObjectStore("something-else"); };
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });
    await j.journalAppend("db", del("a", 1));
    expect(await j.journalRead("db")).toHaveLength(1);
  });

  it("lives in the database 'onden-journal', store 'entries', at version 1: an older build or another tab opens it unchanged", async () => {
    await j.journalAppend("db", del("a", 1));
    const names = (await indexedDB.databases()).map((d) => `${d.name}@${d.version}`);
    expect(names).toEqual(["onden-journal@1"]);
    const stores = await new Promise<string[]>((resolve, reject) => {
      const req = indexedDB.open("onden-journal");
      req.onsuccess = () => { const out = [...req.result.objectStoreNames]; req.result.close(); resolve(out); };
      req.onerror = () => reject(req.error);
    });
    expect(stores).toEqual(["entries"]);
  });

  it("opens one connection and keeps using it", async () => {
    const factory = new IDBFactory();
    const open = vi.spyOn(factory, "open");
    vi.stubGlobal("indexedDB", factory);
    vi.resetModules();
    const fresh = await import("../lib/localDbJournal");
    await fresh.journalAppend("db", del("a", 1));
    await fresh.journalAppend("db", del("a", 2));
    await fresh.journalRead("db");
    await fresh.journalDrop("db", { a: 1 });
    await fresh.journalClear("db");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("reopens after the browser closes the connection or another tab upgrades the database", async () => {
    await j.journalAppend("db", del("a", 1));
    // Another tab (an upgraded build) asks to change the version: the journal's connection must let go.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("onden-journal", 2);
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("the journal kept its connection open"));
    });
    await j.journalAppend("db", del("a", 2));
    expect((await j.journalRead("db")).map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe("the sequence helpers", () => {
  it("latestBySession keeps the highest seq per session", () => {
    expect(j.latestBySession([del("a", 3), del("a", 1), del("b", 2)])).toEqual({ a: 3, b: 2 });
    expect(j.latestBySession([])).toEqual({});
  });

  it("mergeApplied takes the higher per session and keeps sessions only one side has", () => {
    const a = { x: 5, onlyA: 2 };
    const b = { x: 3, y: 9 };
    expect(j.mergeApplied(a, b)).toEqual({ x: 5, onlyA: 2, y: 9 });
    expect(j.mergeApplied({ x: 1 }, { x: 4 })).toEqual({ x: 4 });
    expect(a).toEqual({ x: 5, onlyA: 2 }); // inputs are not changed
    expect(b).toEqual({ x: 3, y: 9 });
  });

  it("unappliedEntries drops records at or below the applied seq and orders the rest by seq, then session", () => {
    const all = [del("b", 2), del("a", 2), del("a", 1), del("c", 3), del("b", 1), del("new", 1)];
    expect(j.unappliedEntries(all, { a: 1, b: 2 }).map((e) => `${e.session}${e.seq}`)).toEqual(["new1", "a2", "c3"]);
  });

  it("unappliedEntries breaks a seq tie by session name, ascending, whatever the input order", () => {
    const forward = j.unappliedEntries([del("a", 1), del("b", 1), del("c", 1)], {});
    const backward = j.unappliedEntries([del("c", 1), del("b", 1), del("a", 1)], {});
    expect(forward.map((e) => e.session)).toEqual(["a", "b", "c"]);
    expect(backward.map((e) => e.session)).toEqual(["a", "b", "c"]);
  });

  it("unappliedEntries orders many sessions that share a seq by session name, whatever order they arrived in", () => {
    const names = ["m", "c", "x", "a", "q", "f"];
    const orders = [names, [...names].reverse(), ["c", "a", "x", "f", "m", "q"], ["q", "x", "a", "m", "f", "c"]];
    for (const order of orders) {
      const sorted = j.unappliedEntries(order.flatMap((s) => [del(s, 2), del(s, 1)]), {});
      expect(sorted.map((e) => `${e.session}${e.seq}`)).toEqual([...names].sort().map((s) => `${s}1`).concat([...names].sort().map((s) => `${s}2`)));
    }
  });

  it("lastSeq is past every record and every applied entry", () => {
    expect(j.lastSeq([], {})).toBe(0);
    expect(j.lastSeq([del("a", 4), del("b", 9)], { a: 2 })).toBe(9);
    expect(j.lastSeq([del("a", 1)], { a: 2, b: 7, c: 3 })).toBe(7);
    expect(j.lastSeq([], { a: 2, b: 7, c: 3 })).toBe(7);
  });
});

describe("replay into the local mirror", () => {
  let d: Database;
  beforeEach(async () => {
    const SQL = await initSqlJs();
    d = new SQL.Database();
    prepareLocalDatabase(d);
  });
  afterEach(() => { d.close(); });

  const row = (over: Partial<JournalRow>): JournalRow => ({
    id: 1, method: "PATCH", path: "/p", body: "b", idem_key: "k1", attempts: 0, rejection: null, created_at: "2026-10-19 00:00:00", targets: null, ...over,
  });
  const put = (r: JournalRow): JournalEntry => ({ session: "s", seq: 1, op: { t: "pw.put", row: r } });
  const rows = () => (d.exec("SELECT id, body, idem_key, attempts, rejection FROM pending_writes ORDER BY id")[0]?.values ?? []);
  const seed = (id: number, body: string, key: string | null) =>
    d.run("INSERT INTO pending_writes (id, method, path, body, idem_key) VALUES (?, 'PATCH', '/p', ?, ?)", [id, body, key]);

  it("inserts a record under its own id when nothing matches", () => {
    expect(j.replayJournalInto(d, [put(row({ id: 5, body: "new" }))])).toBe(0);
    expect(rows()).toEqual([[5, "new", "k1", 0, null]]);
  });

  it("updates the row with the same id and key in place, carrying attempts and rejection", () => {
    seed(5, "old", "k1");
    j.replayJournalInto(d, [put(row({ id: 5, body: "new", attempts: 3, rejection: "validation" }))]);
    expect(rows()).toEqual([[5, "new", "k1", 3, "validation"]]);
  });

  it("treats a null key at the same id as the same row", () => {
    seed(5, "old", null);
    j.replayJournalInto(d, [put(row({ id: 5, body: "new", idem_key: null }))]);
    expect(rows()).toEqual([[5, "new", null, 0, null]]);
  });

  it("finds the row by its key when the id differs, and does not touch the row at that id", () => {
    seed(2, "same key, other id", "k1");
    seed(5, "someone else", "k9");
    j.replayJournalInto(d, [put(row({ id: 5, body: "new", idem_key: "k1" }))]);
    expect(rows()).toEqual([[2, "new", "k1", 0, null], [5, "someone else", "k9", 0, null]]);
  });

  it("picks the lowest id when several rows carry the key", () => {
    seed(4, "later", "k1");
    seed(2, "earlier", "k1");
    j.replayJournalInto(d, [put(row({ id: 9, body: "new", idem_key: "k1" }))]);
    expect(rows()).toEqual([[2, "new", "k1", 0, null], [4, "later", "k1", 0, null]]);
  });

  it("keeps another tab's different request that holds the id: the record gets a new id", () => {
    seed(5, "other tab", "k9");
    j.replayJournalInto(d, [put(row({ id: 5, body: "mine", idem_key: "k1" }))]);
    const all = rows();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r[2] === "k9")).toEqual([5, "other tab", "k9", 0, null]);
    expect(all.find((r) => r[2] === "k1")?.[1]).toBe("mine");
  });

  it("a record without a key never merges into a keyed row at another id", () => {
    seed(2, "keyed", "k1");
    j.replayJournalInto(d, [put(row({ id: 7, body: "unkeyed", idem_key: null }))]);
    expect(rows()).toEqual([[2, "keyed", "k1", 0, null], [7, "unkeyed", null, 0, null]]);
  });

  it("a removal with a key removes the row by key, whatever its id", () => {
    seed(2, "a", "k1");
    seed(3, "b", "k2");
    j.replayJournalInto(d, [{ session: "s", seq: 1, op: { t: "pw.del", id: 99, idem_key: "k1" } }]);
    expect(rows()).toEqual([[3, "b", "k2", 0, null]]);
  });

  it("a removal without a key removes only an unkeyed row at that id", () => {
    seed(2, "unkeyed", null);
    seed(3, "keyed", "k2");
    j.replayJournalInto(d, [{ session: "s", seq: 1, op: { t: "pw.del", id: 3, idem_key: null } }]);
    expect(rows()).toEqual([[2, "unkeyed", null, 0, null], [3, "keyed", "k2", 0, null]]);
    j.replayJournalInto(d, [{ session: "s", seq: 2, op: { t: "pw.del", id: 2, idem_key: null } }]);
    expect(rows()).toEqual([[3, "keyed", "k2", 0, null]]);
  });

  it("replays recorded statements in order with their parameters, and survives one that fails", () => {
    d.run("CREATE TABLE t (n INTEGER)");
    const failed = j.replayJournalInto(d, [{ session: "s", seq: 1, op: { t: "sql", stmts: [
      ["INSERT INTO t VALUES (?)", [1]],
      ["INSERT INTO missing_table VALUES (1)", []],
      ["INSERT INTO t VALUES (?)", [2]],
    ] } }]);
    expect(failed).toBe(0);
    expect(d.exec("SELECT n FROM t ORDER BY rowid")[0].values).toEqual([[1], [2]]);
  });

  it("applies records in the order given, so a later one wins", () => {
    j.replayJournalInto(d, [put(row({ id: 1, body: "first" })), put(row({ id: 1, body: "second" }))]);
    expect(rows()).toEqual([[1, "second", "k1", 0, null]]);
  });

  it("counts every record that fails, names it in the log, and still commits the others", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = (id: number) => put(row({ id, idem_key: `bad${id}`, method: null as unknown as string }));
    const failed = j.replayJournalInto(d, [bad(1), put(row({ id: 2, idem_key: "good" })), bad(3)]);
    expect(failed).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![1]).toBe("pw.put");
    spy.mockRestore();
    expect(rows()).toEqual([[2, "b", "good", 0, null]]);
  });

  it("makes the whole replay atomic: if the commit fails the mirror is left as it was", () => {
    seed(1, "before", "k1");
    const run = d.run.bind(d);
    const spy = vi.spyOn(d, "run").mockImplementation(((sql: string, params?: unknown) => {
      if (sql === "COMMIT") throw new Error("disk full");
      return run(sql, params as never);
    }) as never);
    expect(() => j.replayJournalInto(d, [put(row({ id: 1, body: "after" }))])).toThrow("disk full");
    spy.mockRestore();
    expect(rows()).toEqual([[1, "before", "k1", 0, null]]);
  });
});
