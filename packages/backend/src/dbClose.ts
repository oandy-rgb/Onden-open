// Closing the database is: stop background work that still writes, wait for it, then end the pool.
// Anything that writes to the database after a commit or on a timer registers here (guards/backgroundWriters.guard.test.ts
// lists every such place and fails for a new one that neither registers nor says why it need not), so every caller of
// pool.end() (tests, scripts, the desktop shutdown) gets the same order without remembering to drain first (db.ts wires it).
// Its own file, not db.ts: a test that replaces db.js with a stand-in still loads the services that register.
//
// One close per process. Nothing in the product ends the pool and then opens another: the server has no shutdown path,
// admin.ts and the desktop shutdown exit right after pool.end(), the browser host never ends its pool (reset clears
// stored copies only) and the build scripts exit after pglite.end(). So "closing" is not reset; the dispatcher stops
// retrying for good once it is set (a retry after the pool ended could only fail).

import { isTest } from "./config.js";
import { log } from "./logger.js";

/** One thing that may still write. `pending` is how many jobs it has right now (0 = idle);
 *  `drain` returns once those are done, and may start more jobs of other registrants. */
interface PoolEndDrain {
  pending(): number;
  drain(): Promise<void>;
}

/** How long closing waits for background work. Past it the pool ends anyway: the intent rows of unfinished work stay,
 *  and the next start's catch-up does it. Under the desktop app's 8 s hard stop (desktop/src/serverEntry.mjs). */
const DRAIN_LIMIT_MS = 5_000;
/** A registrant that still has work after this many whole passes keeps feeding itself: report it instead of looping. */
const MAX_PASSES = 20;

const registered = new Map<string, PoolEndDrain>();
let closing = false;

/** Register what must finish before the pool ends. Returns a function that removes it (tests). */
export function onBeforePoolEnd(name: string, drain: PoolEndDrain): () => void {
  registered.set(name, drain);
  return () => { registered.delete(name); };
}

/** True once closing has begun: do not wait to retry, the pool is going away. */
export function isPoolClosing(): boolean {
  return closing;
}

/** Repeat whole passes until one finds nothing pending: a drained job may queue work for a registrant that was
 *  already checked in this pass, whatever the registration (import) order is. */
async function drainToFixedPoint(): Promise<Map<string, number>> {
  let busiest = "";
  const drained = new Map<string, number>();
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    let found = 0;
    for (const [name, drain] of registered) {
      const jobs = drain.pending();
      if (jobs === 0) continue;
      found += jobs;
      busiest = name;
      drained.set(name, (drained.get(name) ?? 0) + jobs);
      await drain.drain();
    }
    if (found === 0) return drained;
  }
  throw new Error(`closing the database: "${busiest}" still had work after ${MAX_PASSES} passes`);
}

/** Drain, then end the pool. The pool ends even if a drain throws or the limit passes; the drain's error still reaches the caller. */
export async function closeDatabase(endPool: () => Promise<void>): Promise<void> {
  closing = true;
  const caller = isTest() ? new Error().stack : undefined; // names the test file in the line below
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const draining = drainToFixedPoint();
    draining.catch(() => undefined); // a late failure after the limit must not become an unhandled rejection
    const limit = new Promise<"limit">((resolve) => { timer = setTimeout(() => resolve("limit"), DRAIN_LIMIT_MS); });
    const outcome = await Promise.race([draining, limit]);
    if (outcome !== "limit") {
      // The test run only: a test file that leaves work behind without awaiting it becomes visible (log only; the drain
      // made the run safe), so it can get its own awaitAllDispatchers(). The line's shape is read by
      // scripts/lib/skipGateReporter.mjs, which lists these per file at the end of the run: change both together.
      if (outcome.size > 0 && caller) {
        const file = /src\/test\/([^:)\s]+)/.exec(caller)?.[1] ?? "an unknown test file";
        const jobs = [...outcome.values()].reduce((a, b) => a + b, 0);
        const byName = [...outcome].map(([name, n]) => `${name}: ${n}`).join(", ");
        log.warn("tests", `pool.end() waited for ${jobs} background job(s) in ${file} [${byName}]; await them in the test (awaitAllDispatchers)`);
      }
    } else {
      const waiting = [...registered].map(([name, d]) => [name, d.pending()] as const).filter(([, n]) => n > 0);
      log.warn("db", `closing the database: stopped waiting after ${DRAIN_LIMIT_MS / 1000}s, ${waiting.map(([n, c]) => `${c} in ${n}`).join(", ")}; their intent rows stay for the next start`);
    }
  } finally {
    clearTimeout(timer);
    await endPool();
  }
}
