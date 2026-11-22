import { onAppResume } from "./appResume";

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

/** Ask the browser to keep the screen on while something long runs (a file being made or taken in); a phone that sleeps pauses the page.
 *  Best effort: a browser without the API, or one that refuses (low battery), just goes on without it. Returns the release.
 *  The browser drops the hold when the page is hidden, so it is asked for again when the page comes back. */
export function keepScreenAwake(): () => void {
  const wakeLock = typeof navigator !== "undefined" ? (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock : undefined;
  if (!wakeLock) return () => {};
  let held: { release(): Promise<void> } | null = null;
  let stopped = false;
  const take = () => { void wakeLock.request("screen").then((lock) => { if (stopped) void lock.release().catch(() => {}); else held = lock; }, () => {}); };
  take();
  const stopWatching = onAppResume(() => { if (!held) take(); }, ["visible"]);
  return () => {
    stopped = true;
    stopWatching();
    void held?.release().catch(() => {});
    held = null;
  };
}

/** Take the named lock and keep it until the returned release is called (or the page dies, which releases every lock
 *  it held). Resolves once the lock is held. Where the browser has no Web Locks it resolves at once with a no-op. */
export function holdLockUntilReleased(name: string): Promise<() => void> {
  if (typeof navigator === "undefined" || !navigator.locks?.request) return Promise.resolve(() => {});
  return new Promise<() => void>((resolve) => {
    void navigator.locks.request(name, () => new Promise<void>((release) => resolve(release))).catch(() => resolve(() => {}));
  });
}

/** The names of the locks some live page of this origin holds now, among those starting with `prefix`. Empty where the
 *  browser has no Web Locks (or cannot say). */
export async function heldLockNames(prefix: string): Promise<Set<string>> {
  if (typeof navigator === "undefined" || !navigator.locks?.query) return new Set();
  try {
    const { held } = await navigator.locks.query();
    return new Set((held ?? []).map((lock) => lock.name ?? "").filter((name) => name.startsWith(prefix)));
  } catch { return new Set(); }
}

/** Resolves when the named lock is free (its holder released it or died). */
export function whenLockFree(name: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.locks?.request) return Promise.resolve();
  return navigator.locks.request(name, async () => {}).then(() => {}, () => {});
}
