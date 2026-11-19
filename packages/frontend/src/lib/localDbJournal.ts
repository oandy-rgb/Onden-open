// Write-ahead journal for the local SQLite mirror (mobile perf #5).
//
// sql.js keeps the database in memory and can only persist it as one whole
// file (`db.export()`), 35–100 MB at 20k notes. Queued offline writes used to
// wait for that whole export before they counted as saved. Now a durability-
// critical change (a queued write, its rejection or removal, a note or canvas
// delete) is appended here as one small IndexedDB record, and the whole
// snapshot is saved later, coalesced, as a compaction step.
//
// Records live in their own IndexedDB database so the snapshot store
// ("onden-storage", version 1) keeps its schema: an older build, a rolled-back
// deploy or another tab still on the old build opens it unchanged.
//
// Key: [snapshot key, session, seq]. A session is one worker instance; seq
// counts up within it, starting past every seq the session found at load. The snapshot stores, per session, the last seq it
// contains (sync_state 'journal_applied'), so after a crash anywhere — before
// the record, between the snapshot commit and the record cleanup — loading
// replays exactly the records the snapshot lacks.

import type { BindParams, QueryExecResult } from "sql.js";

export type JournalRow = {
  id: number;
  method: string;
  path: string;
  body: string | null;
  idem_key: string | null;
  attempts: number;
  rejection: string | null;
  created_at: string;
  targets: string | null;
  /** When the row was made (localDbWorker.queuedAt); absent in records of older builds. */
  made_at?: number | null;
};

export type JournalOp =
  /** A pending_writes row as it now stands (queued, rejected). */
  | { t: "pw.put"; row: JournalRow }
  /** A pending_writes row removed (sent, dismissed). */
  | { t: "pw.del"; id: number; idem_key: string | null }
  /** Statements that ran on the mirror, replayed in order (a node or canvas delete). */
  | { t: "sql"; stmts: Array<[string, unknown[]]> };

export type JournalEntry = { session: string; seq: number; op: JournalOp };

/** Per session, the highest seq a snapshot (or a replay) already contains. */
export type JournalApplied = Record<string, number>;

/** The journal's key for an account's snapshot: the snapshot's own key. */
export function journalScopeKey(scope: string | null): string {
  return scope === null ? "db" : `db:account-v1:${scope}`;
}

const IDB_NAME = "onden-journal";
const STORE = "entries";

/** False where IndexedDB (with key ranges) does not exist, as in some test
 *  runtimes: the worker then saves the whole snapshot for every durable
 *  change, as before. */
export function journalAvailable(): boolean {
  return typeof indexedDB !== "undefined" && typeof IDBKeyRange !== "undefined";
}

function openJournalAt(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, version);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new DOMException("Local journal open blocked", "AbortError"));
  });
}

/** Opens at the current version; a database that exists without the store
 *  (created by something else) is upgraded once to add it. */
async function openJournal(): Promise<IDBDatabase> {
  const db = await openJournalAt();
  if (db.objectStoreNames.contains(STORE)) return db;
  const next = db.version + 1;
  db.close();
  return openJournalAt(next);
}

// One connection per worker, reopened after an error or a version change.
let connection: Promise<IDBDatabase> | null = null;
function journalDb(): Promise<IDBDatabase> {
  if (!connection) {
    connection = openJournal().then((db) => {
      db.onversionchange = () => { db.close(); connection = null; };
      db.onclose = () => { connection = null; };
      return db;
    });
    connection.catch(() => { connection = null; });
  }
  return connection;
}

function scopeRange(scopeKey: string): IDBKeyRange {
  // An array sorts after every string and number, so [key, []] bounds all
  // [key, session, seq] keys.
  return IDBKeyRange.bound([scopeKey], [scopeKey, []]);
}

async function inTransaction<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => T | (() => T), durability?: "strict"): Promise<T> {
  const db = await journalDb();
  return new Promise<T>((resolve, reject) => {
    // Default durability (Chromium: relaxed): committed data survives the tab or the browser being killed, but the
    // operating system may still hold it in memory. `strict` waits until it is on the disk, so it survives the power
    // going too: a record that is the only copy of a person's input asks for it (Safari ignores the option).
    const tx = durability ? db.transaction(STORE, mode, { durability }) : db.transaction(STORE, mode);
    let result: T | (() => T);
    tx.oncomplete = () => resolve(typeof result === "function" ? (result as () => T)() : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException("Local journal transaction aborted", "AbortError"));
    result = body(tx.objectStore(STORE));
  });
}

/** Resolves once the record is committed: only then is the change durable. `strict`: on the disk, not only handed to
 *  the operating system (measured in Chromium, 2026-11-18: 0.7 ms median, 4 ms p95 for a 2 KB record, against 0.2 ms). */
export function journalAppend(scopeKey: string, entry: JournalEntry, durability?: "strict"): Promise<void> {
  return inTransaction("readwrite", (store) => { store.put(entry, [scopeKey, entry.session, entry.seq]); }, durability);
}

/** Every record of this snapshot key, in key order (by session, then seq).
 *  A read failure rejects, as the snapshot read does: treating the journal as
 *  empty could drop acknowledged input. */
export function journalRead(scopeKey: string): Promise<JournalEntry[]> {
  return inTransaction("readonly", (store) => {
    const req = store.getAll(scopeRange(scopeKey));
    return () => (req.result as JournalEntry[]) ?? [];
  });
}

/** Delete records a saved snapshot contains (seq <= applied[session]). */
export function journalDrop(scopeKey: string, applied: JournalApplied): Promise<void> {
  return inTransaction("readwrite", (store) => {
    for (const [session, seq] of Object.entries(applied)) {
      store.delete(IDBKeyRange.bound([scopeKey, session, -Infinity], [scopeKey, session, seq]));
    }
  });
}

/** Delete every record of this snapshot key (the mirror was wiped). */
export function journalClear(scopeKey: string): Promise<void> {
  return inTransaction("readwrite", (store) => { store.delete(scopeRange(scopeKey)); });
}

/** The highest seq per session in these records. */
export function latestBySession(entries: JournalEntry[]): JournalApplied {
  const out: JournalApplied = {};
  for (const e of entries) out[e.session] = Math.max(out[e.session] ?? 0, e.seq);
  return out;
}

/** Per session, the higher of the two. */
export function mergeApplied(a: JournalApplied, b: JournalApplied): JournalApplied {
  const out: JournalApplied = { ...a };
  for (const [session, seq] of Object.entries(b)) out[session] = Math.max(out[session] ?? 0, seq);
  return out;
}

/** Records a snapshot with `applied` does not contain yet, in replay order:
 *  by seq, which a new session continues past every seq it found (see the
 *  worker's replayJournal), so a restart's records follow the crashed ones. */
export function unappliedEntries(entries: JournalEntry[], applied: JournalApplied): JournalEntry[] {
  return entries
    .filter((e) => e.seq > (applied[e.session] ?? 0))
    .sort((a, b) => a.seq - b.seq || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
}

/** The seq a new session starts after: past every record and snapshot entry. */
export function lastSeq(entries: JournalEntry[], applied: JournalApplied): number {
  let max = 0;
  for (const seq of Object.values(applied)) max = Math.max(max, seq);
  for (const e of entries) max = Math.max(max, e.seq);
  return max;
}

/** The write surface replay needs: sql.js's Database, structurally. */
export interface JournalDb {
  run(sql: string, params?: BindParams): unknown;
  exec(sql: string, params?: BindParams): QueryExecResult[];
}

function one(d: JournalDb, sql: string, params: BindParams): unknown[] | undefined {
  return d.exec(sql, params)[0]?.values[0];
}

/** Bring a pending_writes row to the recorded state. A row is matched by its
 *  id and idempotency key, then by the key alone: another tab may have queued
 *  a different request under the same id, and that one must survive too. */
function replayPut(d: JournalDb, row: JournalRow): void {
  // The time it was made goes with the row: in this copy it is ordered among the rows by when they were made, not by
  // the number it gets here (a record of an older build has none).
  const made = row.made_at === undefined ? [] : [row.made_at];
  const cols = [row.method, row.path, row.body, row.idem_key, row.attempts, row.rejection, row.created_at, row.targets, ...made];
  const madeCol = made.length ? ", made_at" : "";
  const update = (id: unknown) => d.run(
    `UPDATE pending_writes SET method=?, path=?, body=?, idem_key=?, attempts=?, rejection=?, created_at=?, targets=?${made.length ? ", made_at=?" : ""} WHERE id=?`,
    [...cols, id] as BindParams,
  );
  const atId = one(d, "SELECT id, idem_key FROM pending_writes WHERE id=?", [row.id]);
  if (atId && atId[1] === row.idem_key) { update(row.id); return; }
  if (row.idem_key !== null) {
    const byKey = one(d, "SELECT id FROM pending_writes WHERE idem_key=? ORDER BY id LIMIT 1", [row.idem_key]);
    if (byKey) { update(byKey[0]); return; }
  }
  d.run(
    `INSERT INTO pending_writes (${atId ? "" : "id, "}method, path, body, idem_key, attempts, rejection, created_at, targets${madeCol}) VALUES (${atId ? "" : "?, "}?, ?, ?, ?, ?, ?, ?, ?${made.length ? ", ?" : ""})`,
    (atId ? cols : [row.id, ...cols]) as BindParams,
  );
}

function replayDelete(d: JournalDb, id: number, idemKey: string | null): void {
  if (idemKey === null) d.run("DELETE FROM pending_writes WHERE id=? AND idem_key IS NULL", [id]);
  else d.run("DELETE FROM pending_writes WHERE idem_key=?", [idemKey]);
}

/** Apply journal records to a loaded snapshot, in order, in one transaction.
 *  A record that fails is reported and skipped, so one bad record cannot keep
 *  the rest (queued input) from loading. Returns how many failed. */
export function replayJournalInto(d: JournalDb, entries: JournalEntry[]): number {
  let failed = 0;
  d.run("BEGIN");
  try {
    for (const { op } of entries) {
      try {
        if (op.t === "pw.put") replayPut(d, op.row);
        else if (op.t === "pw.del") replayDelete(d, op.id, op.idem_key);
        else for (const [sql, params] of op.stmts) {
          // The statements already ran once; a best-effort one (the FTS index)
          // may fail again here without failing the record.
          try { d.run(sql, params as BindParams); } catch { /* best-effort statement */ }
        }
      } catch (error) {
        failed++;
        console.error("[onden] local journal record could not be replayed", op.t, error);
      }
    }
    d.run("COMMIT");
  } catch (error) {
    d.run("ROLLBACK");
    throw error;
  }
  return failed;
}
