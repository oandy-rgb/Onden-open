// The one owner of `setInterval(` (guards/dup-b2-infra.guard.test.ts). It imports nothing, so
// services/realtime.ts can hold an SSE heartbeat without pulling backgroundJobs → db → realtime
// into an import cycle. Periodic server work goes through backgroundJobs.ts startPeriodicJob.

/**
 * A per-connection ticker (SSE heartbeat): unlike a periodic job it belongs to one open stream, so it has no name,
 * lock or error log — the caller's `tick` must not throw. The timer is unref'd; call the returned function on close.
 */
export function startTicker(everyMs: number, tick: () => void): () => void {
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
