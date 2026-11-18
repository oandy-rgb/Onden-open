// ── Periodic background jobs ─────────────────────────────────────────────
// The one place that schedules recurring server work (pruning, sweeps, retries).
// Every job gets the same behaviour so a new one can't forget a piece:
//   • a failing run is logged under the job's name and never escapes as an
//     unhandled rejection; the next tick still runs;
//   • the timer is unref'd, so a job never keeps the process (or a script / test
//     that merely imported the module) alive;
//   • `exclusive: true` runs a pass only on the instance that wins a session-level
//     advisory lock (key = hashtext(name)), so N replicas don't all do the same
//     sweep; a losing instance skips that pass. The lock dies with its connection;
//   • a job name is started once per process — starting it again returns the
//     running one, and `stop()` / `stopAllPeriodicJobs()` clear the timers.
//
//   startPeriodicJob({ name: "rss", everyMs: 60_000, exclusive: true }, sweepRss);
//
// The timer itself comes from ticker.ts, the one owner of `setInterval(` (guards/dup-b2-infra.guard.test.ts).

import { withLeaderLock } from "./db.js";
import { log } from "./logger.js";
import { startTicker } from "./ticker.js";

export interface PeriodicJobOptions {
  /** Log tag and advisory-lock identity; unique per job. */
  name: string;
  everyMs: number;
  /** Run once this long after start (0 = right away). Omitted: wait one interval. */
  runFirstAfterMs?: number;
  /** Only one instance runs each pass (advisory lock). Default false. */
  exclusive?: boolean;
}

export interface PeriodicJob {
  stop(): void;
}

const running = new Map<string, PeriodicJob>();

type JobRunner = (job: () => Promise<void>) => Promise<void>;
let runJob: JobRunner = (job) => job();
/** A host that serialises all its work (the browser worker: one queue for requests and jobs,
 *  docs/architecture/portable-backend.md §3) runs every pass through its queue. */
export function useJobRunner(next: JobRunner): void {
  runJob = next;
}

async function runExclusive(name: string, run: () => Promise<void> | void): Promise<void> {
  await withLeaderLock({ name: `onden-job:${name}` }, async () => run());
}

export function startPeriodicJob(opts: PeriodicJobOptions, run: () => Promise<void> | void): PeriodicJob {
  const existing = running.get(opts.name);
  if (existing) return existing;

  const pass = (): Promise<void> => runJob(async () => {
    try {
      if (opts.exclusive) await runExclusive(opts.name, run);
      else await run();
    } catch (e) {
      log.error(opts.name, "periodic job failed", { err: e });
    }
  });

  let first: ReturnType<typeof setTimeout> | null = null;
  if (opts.runFirstAfterMs !== undefined) {
    if (opts.runFirstAfterMs <= 0) void pass();
    else first = setTimeout(() => void pass(), opts.runFirstAfterMs).unref();
  }
  const stopTimer = startTicker(opts.everyMs, () => void pass());

  const job: PeriodicJob = {
    stop() {
      if (first) clearTimeout(first);
      stopTimer();
      if (running.get(opts.name) === job) running.delete(opts.name);
    },
  };
  running.set(opts.name, job);
  return job;
}

/** Clear every timer (graceful shutdown, tests). */
export function stopAllPeriodicJobs(): void {
  for (const job of [...running.values()]) job.stop();
}
