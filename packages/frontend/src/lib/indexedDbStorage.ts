import { randomUUID } from "./uuid";
const IDB_NAME = "onden-storage";
const STORE = "sqlite";
function snapshotKey(scope: string | null): string {
  return scope === null ? "db" : `db:account-v1:${scope}`;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Every tab and the installed PWA of one origin write this one key, each from
// its own in-memory copy. A snapshot is stored only over the generation this
// context last loaded or saved (compare-and-swap in one transaction); a stale
// context gets SnapshotStaleError and must reload before saving, or its older
// copy would erase another context's compacted queue writes.
const knownGeneration = new Map<string, string | null>();
const generationKey = (scope: string | null) => `${snapshotKey(scope)}:generation`;

/** The stored snapshot is newer than the one this context holds. */
export class SnapshotStaleError extends Error {
  override name = "SnapshotStaleError";
}

/** Read failures reject: treating an inaccessible snapshot as absent could
 * overwrite acknowledged queued input with a fresh, empty database. */
export async function idbLoad(scope: string | null = null): Promise<ArrayBuffer | null> {
  const db = await openIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const snapshot = store.get(snapshotKey(scope));
      snapshot.onsuccess = () => {
        // Same transaction: the generation belongs to the bytes just read.
        const generation = store.get(generationKey(scope));
        generation.onsuccess = () => {
          knownGeneration.set(snapshotKey(scope), (generation.result as string | undefined) ?? null);
          resolve((snapshot.result as ArrayBuffer) ?? null);
        };
        generation.onerror = () => reject(generation.error);
      };
      snapshot.onerror = () => reject(snapshot.error);
      tx.onabort = () => reject(tx.error ?? new DOMException("Local snapshot read aborted", "AbortError"));
    });
  } finally { db.close(); }
}

/** Whether another context stored a snapshot since this one loaded or saved. */
export async function idbIsStale(scope: string | null = null): Promise<boolean> {
  const key = snapshotKey(scope);
  if (!knownGeneration.has(key)) return false;
  const db = await openIdb();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(generationKey(scope));
      req.onsuccess = () => resolve(((req.result as string | undefined) ?? null) !== knownGeneration.get(key));
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

/** The event idbSave dispatches when a local-snapshot write fails (quota,
 *  blocked/aborted tx). The app can latch onto it for a "couldn't save locally"
 *  indicator. Dispatched on `self` (works in both window and worker contexts). */
export const LOCAL_PERSIST_FAILED_EVENT = "onden:local-persist-failed";

/** `replace` stores over whatever is there (an import replaces the database on
 *  purpose); otherwise a snapshot this context never loaded is stored the same
 *  way, and a loaded one only over its own generation. */
export async function idbSave(buffer: ArrayBuffer, scope: string | null = null, { replace = false } = {}): Promise<void> {
  const key = snapshotKey(scope);
  const next = randomUUID();
  try {
    const db = await openIdb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new DOMException("Local snapshot transaction aborted", "AbortError"));
        const store = tx.objectStore(STORE);
        const write = () => { store.put(buffer, key); store.put(next, generationKey(scope)); };
        if (replace || !knownGeneration.has(key)) return write();
        const stored = store.get(generationKey(scope));
        stored.onsuccess = () => {
          if (((stored.result as string | undefined) ?? null) === knownGeneration.get(key)) write();
          else { reject(new SnapshotStaleError("Local snapshot changed in another tab")); tx.abort(); }
        };
      });
    } finally { db.close(); }
    knownGeneration.set(key, next);
  } catch (err) {
    if (err instanceof SnapshotStaleError) throw err;
    // Callers need rejection to retry the snapshot and surface failed queued
    // writes. The worker's background/unload paths already catch failures.
    console.error("[onden] local snapshot save to IndexedDB failed", err);
    try {
      const g = self as unknown as { dispatchEvent?: (e: Event) => void };
      g.dispatchEvent?.(new CustomEvent(LOCAL_PERSIST_FAILED_EVENT, { detail: { error: String(err) } }));
    } catch {
      // CustomEvent / dispatchEvent unavailable in this runtime — log already emitted.
    }
    throw err;
  }
}

/** Move the old unscoped native snapshot onto `scope` (its owner, see
 *  lib/accountStorage claimLegacyNativeStore). One transaction writes the new
 *  key and deletes the old one, so the store can never be adopted twice. */
export async function idbAdoptLegacy(buffer: ArrayBuffer, scope: string): Promise<void> {
  const next = randomUUID();
  const db = await openIdb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new DOMException("Local snapshot transaction aborted", "AbortError"));
      const store = tx.objectStore(STORE);
      store.put(buffer, snapshotKey(scope));
      store.put(next, generationKey(scope));
      store.delete(snapshotKey(null));
    });
    knownGeneration.set(snapshotKey(scope), next);
  } finally { db.close(); }
}
