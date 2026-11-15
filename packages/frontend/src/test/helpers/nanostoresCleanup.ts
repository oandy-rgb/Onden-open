// nanostores unmounts a store 1s (STORE_UNMOUNT_DELAY) after its last listener
// leaves, on a setTimeout. better-auth's session store runs its teardown there
// and the teardown touches `window`. A test file that ends within that second
// has its jsdom torn down before the timer fires → "window is not defined" as an
// unhandled error, which turns the whole run's exit code to 1 (seen under load).
//
// Tests cannot know which store a rendered component subscribed to, so the
// shared setup tracks those timers and runs them while the DOM still exists.

const NANOSTORES_UNMOUNT_DELAY_MS = 1000;
const pending = new Map<ReturnType<typeof setTimeout>, () => void>();
let installed = false;

/** Wrap setTimeout once per test file so nanostores' unmount timers are tracked. */
export function trackNanostoresUnmountTimers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const real = globalThis.setTimeout;
  const tracking = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay !== NANOSTORES_UNMOUNT_DELAY_MS || typeof handler !== "function"
      || !new Error().stack?.includes("nanostores/lifecycle")) {
      return real(handler as never, delay, ...args);
    }
    const run = () => { pending.delete(id); (handler as (...a: unknown[]) => void)(...args); };
    const id = real(run, delay);
    pending.set(id, run);
    return id;
  }) as unknown as typeof setTimeout;
  Object.assign(tracking, real);
  globalThis.setTimeout = tracking;
}

/** Run every tracked unmount timer now (call before the test file's DOM goes away). */
export function flushNanostoresUnmountTimers(): number {
  const due = [...pending];
  pending.clear();
  for (const [id, run] of due) { clearTimeout(id); run(); }
  return due.length;
}
