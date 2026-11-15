/** Run `operation` while holding the named cross-tab lock (Web Locks), so two tabs never run it at once.
 *  Where the browser has no Web Locks the operation just runs: one tab at a time is then the best we can do. */
export async function withTabLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return await navigator.locks.request(name, operation);
  }
  return await operation();
}

/** Take the named lock only if no other tab holds it, and keep it until this page closes. Resolves false when another tab
 *  has it (the browser app: two tabs would write one saved copy). Where the browser has no Web Locks it resolves true. */
export function holdTabLock(name: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.locks?.request) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    void navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      return lock ? new Promise<void>(() => {}) : undefined;
    });
  });
}
