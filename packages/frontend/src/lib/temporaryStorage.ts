// The page half of the temporary session of the browser app (`?temp=1`, docs/architecture/browser-app.md §17): the page keeps NOTHING of it
// in this browser, so it can be used on a computer that is not the person's own. The worker's half is
// backend/src/browser/worker.ts (no saved copy, no journal, files in memory); this is the page's half.
//
// What the page itself could write, and what stops it. The page's storage globals are replaced, before any other module
// of the app is loaded (browserApp/temporaryEntry.ts is the first import), by ones that live in memory or are absent:
//   localStorage                 → a Map that dies with the page (every preference, the account marker, …)
//   per-tab memory (sessionPrefs)→ the same kind of Map instead of the browser's session store
//   indexedDB                    → absent (the page's marker database; code that asks `typeof indexedDB` finds none). The
//                                  offline copy lives in its own worker, which has its own IndexedDB: every request to it
//                                  says `temporary` (lib/localDb), and it then keeps its copy in memory and no journal
//   caches, the origin's file system (navigator.storage.getDirectory) → absent
// The ordinary session of the same browser keeps its data in the same origin's real storage; this session never opens
// it, so nothing of it is read, changed or erased. The Service Worker that shows uploaded pictures is the app's code,
// not the session's content, and stays as it is.
//
// Only the browser app's entry imports this (browserApp/temporaryEntry.ts); the app everywhere else needs just the flag
// (lib/temporarySession.ts), which keeps this out of the boot bundle.
import { BROWSER_APP_TEMP_PARAM } from "@onden/markdown";
import { readUrlParams } from "./pageUrl";
import { replaceSessionStore } from "./sessionPrefs";
import { isTemporarySession, markTemporarySession } from "./temporarySession";
import { withdrawOriginFileSystem } from "./storagePersist";

/** A Storage that lives in memory: the same interface the app already reads, nothing behind it. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  const storage = {
    get length() { return items.size; },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(String(key)) ?? null,
    setItem: (key: string, value: string) => { items.set(String(key), String(value)); },
    removeItem: (key: string) => { items.delete(String(key)); },
    clear: () => { items.clear(); },
  };
  return storage as Storage;
}

function absent(target: object, name: string): void {
  try { Object.defineProperty(target, name, { configurable: true, value: undefined }); } catch { /* not replaceable: the worker's own rules still keep the session's content out */ }
}

/** Replace the page's persistent storage with nothing. Idempotent. */
function beginTemporarySession(): void {
  if (isTemporarySession()) return;
  markTemporarySession();
  try { Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() }); } catch { /* see absent */ }
  replaceSessionStore(memoryStorage());
  absent(window, "indexedDB");
  absent(window, "caches");
  withdrawOriginFileSystem();
}

/** Called once, first thing, from the browser app's entry: becomes a temporary session when the address says so. */
export function beginTemporarySessionIfAsked(): boolean {
  if (readUrlParams().get(BROWSER_APP_TEMP_PARAM) === "1") beginTemporarySession();
  return isTemporarySession();
}
