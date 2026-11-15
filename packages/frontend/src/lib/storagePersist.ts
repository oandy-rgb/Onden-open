// P0 durability. Onden's offline mirror + pending-write queue live in IndexedDB
// (the sql.js snapshot via idbSave). By default that storage is "best-effort" —
// the browser may EVICT it under storage pressure, which would silently destroy
// the only durable copy of an offline edit. navigator.storage.persist() asks the
// browser to mark this origin's storage as persistent (exempt from eviction).
//
// Best-effort + idempotent: granted silently on installed PWAs / high engagement,
// may be denied elsewhere (we don't nag). Safe to call once at boot.
/** Resolves to whether the browser keeps this site's storage (true), refused (false) or cannot say (null). */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    const s = typeof navigator !== "undefined" ? navigator.storage : undefined;
    if (!s?.persist) return null;
    const already = s.persisted ? await s.persisted() : false;
    if (already) return true;
    const granted = await s.persist();
    // Quota visibility (telemetry only): helps diagnose "near full" before a write
    // fails. Cheap, no UI — just a console line for the self-host operator.
    if (s.estimate) {
      const { usage = 0, quota = 0 } = await s.estimate();
      const pct = quota ? Math.round((usage / quota) * 100) : 0;
      console.info(`[storage] persistent=${granted} usage=${Math.round(usage / 1e6)}MB/${Math.round(quota / 1e6)}MB (${pct}%)`);
    }
    return granted;
  } catch { /* best effort — never block boot */ }
  return null;
}

export type StorageStatus = {
  /** true = the browser promised not to clear this site's data under pressure; null = this browser cannot say. */
  persistent: boolean | null;
  usedBytes: number | null;
  quotaBytes: number | null;
};

/** What the browser says about this site's storage right now (no prompt). */
export async function storageStatus(): Promise<StorageStatus> {
  const s = typeof navigator !== "undefined" ? navigator.storage : undefined;
  try {
    const persistent = s?.persisted ? await s.persisted() : null;
    const estimate = s?.estimate ? await s.estimate() : null;
    return { persistent, usedBytes: estimate?.usage ?? null, quotaBytes: estimate?.quota ?? null };
  } catch {
    return { persistent: null, usedBytes: null, quotaBytes: null };
  }
}

/** The page's service-worker channel (registration readiness, controller, messages from the worker);
 *  undefined where service workers do not exist (insecure origin, tests). */
export function serviceWorkerContainer(): ServiceWorkerContainer | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
}

/** A temporary session (lib/temporaryStorage.ts) must not reach the origin's private file system, where an ordinary session of
 *  the same browser keeps its notes: this page finds none (`navigator.storage.getDirectory` is absent). */
export function withdrawOriginFileSystem(): void {
  const s = typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!s) return;
  try { Object.defineProperty(s, "getDirectory", { configurable: true, value: undefined }); } catch { /* not replaceable */ }
}
