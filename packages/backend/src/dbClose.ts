// Closing the database is: stop background work that still writes, wait for it, then end the pool.
// Work started from a commit (services/dispatcherQueue.ts, services/outbox.ts) registers here, so every caller of
// pool.end() (tests, scripts, a shutdown) gets the same order without remembering to drain first (db.ts wires it).
// Its own file, not db.ts: a test that replaces db.js with a stand-in still loads the services that register.

const beforePoolEnd: Array<() => Promise<void>> = [];

export function onBeforePoolEnd(drain: () => Promise<void>): void {
  beforePoolEnd.push(drain);
}

/** Run every registered drain, in registration order; db.ts calls this inside pool.end(). */
export async function drainBeforePoolEnd(): Promise<void> {
  for (const drain of beforePoolEnd) await drain();
}
