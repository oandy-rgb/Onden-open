// The write-ahead log of the browser app: every write request is recorded here BEFORE the backend runs it, so a
// page that is closed or reloaded right after an edit loses nothing. The database copy (snapshotStore.ts) is
// still how data is kept; the journal covers the gap between two copies (docs/architecture/browser-app.md §4).
//
// Contract:
//   • append() resolves when the entry is durable (an IndexedDB transaction with strict durability). Only then does
//     the worker run the request and answer "saved".
//   • Each copy records `journalSeq` = the last entry that was fully run when the copy was made (saveLoop does this
//     inside the same queue job as the copy, so no entry is half-in). On boot, entries after that number are run
//     again in order; entries up to it are never replayed, which is why replay is safe without relying on every
//     request carrying an idempotency key (the ones that do carry it keep it, so a request is also deduplicated
//     by the backend itself).
//   • A request whose body is larger than MAX_BODY_BYTES is not logged (it is covered by the next copy only); the
//     journal says so (`skippedLarge`), and the person is never told such a change is safer than it is.

import { idbCommitted, idbRequest } from "./idb.js";

export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export type JournalEntry = {
  seq: number;
  method: string;
  path: string;
  headers: Array<[string, string]>;
  body: ArrayBuffer | null;
};

export type Journal = {
  /** Records a request; resolves with its number once it is durable. Rejects if it could not be recorded. */
  append(request: Omit<JournalEntry, "seq">): Promise<number>;
  /** Entries with a number above `seq`, oldest first. */
  after(seq: number): Promise<JournalEntry[]>;
  /** The highest number ever used (0 when empty). */
  lastSeq(): Promise<number>;
  /** Forget entries up to and including `seq` (a copy that contains them is durable). */
  trimThrough(seq: number): Promise<void>;
  /** Numbers must stay above the copy that was loaded (a trimmed log starts empty, but that copy remembers its number). */
  startAfter(seq: number): void;
  /** Forget everything ("start over"). */
  clear(): Promise<void>;
};

const NAME = "onden-browser-journal";
const STORE = "entries";

/** Whether a request is something the journal should keep: anything that may change data. */
export function isJournaled(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return false;
  const bare = path.split("?")[0];
  // The worker's own endpoints, signing in/out (the local session is made again on every start), and the steps of a
  // restore (its upload lives only in memory, so a replayed "apply" could not find it; the restore's result is a
  // change to the database like any other and is saved by the copy that follows it). Uploaded files: the file is on the
  // browser's storage before the upload is answered, and a replay would store it a second time under a new id.
  // The sync pulls are POSTs that only read (routes/sync.ts).
  return !bare.startsWith("/api/browser-app/") && bare !== "/api/sync" && !bare.startsWith("/api/sync/") && !bare.startsWith("/api/auth/") && !bare.startsWith("/api/backup/restore") && bare !== "/api/media";
}

/** `undefined` when this browser has no IndexedDB (then nothing but the copy protects a change). */
export async function openJournal(): Promise<Journal | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const open = indexedDB.open(NAME, 1);
  open.onupgradeneeded = () => { open.result.createObjectStore(STORE, { keyPath: "seq" }); };
  let db: IDBDatabase;
  try { db = await idbRequest(open); } catch { return undefined; }
  // Numbers keep growing across starts even when the log was emptied, so a copy's `journalSeq` never points
  // at a different entry than it did when it was made.
  let floor = 0;
  const highest = async (): Promise<number> => {
    const cursor = await idbRequest(db.transaction(STORE, "readonly").objectStore(STORE).openCursor(null, "prev"));
    return Math.max(floor, cursor ? (cursor.value as JournalEntry).seq : 0);
  };
  let next = (await highest()) + 1;
  // `durability: "strict"` (Chromium, Firefox) asks for the entry to reach the disk before oncomplete; Safari ignores it.
  const write = () => db.transaction(STORE, "readwrite", { durability: "strict" } as IDBTransactionOptions);
  return {
    async append(request) {
      const seq = next++;
      const transaction = write();
      transaction.objectStore(STORE).put({ ...request, seq } satisfies JournalEntry);
      await idbCommitted(transaction);
      return seq;
    },
    async after(seq) {
      const range = IDBKeyRange.lowerBound(seq, true);
      return (await idbRequest(db.transaction(STORE, "readonly").objectStore(STORE).getAll(range))) as JournalEntry[];
    },
    lastSeq: highest,
    startAfter(seq) { floor = Math.max(floor, seq); next = Math.max(next, floor + 1); },
    async trimThrough(seq) {
      floor = Math.max(floor, seq);
      const transaction = write();
      transaction.objectStore(STORE).delete(IDBKeyRange.upperBound(seq));
      await idbCommitted(transaction);
    },
    async clear() {
      floor = Math.max(floor, next - 1);
      const transaction = write();
      transaction.objectStore(STORE).clear();
      await idbCommitted(transaction);
    },
  };
}
