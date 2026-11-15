// Timing helper shared by the two bodyParsersLinear tests (backend, frontend):
// "linear" means a body four times as long takes about four times as long; a
// quadratic parser takes sixteen. Comparing two sizes on the same machine holds
// under load, where a fixed millisecond budget did not. Test-only: excluded
// from the package build (tsconfig.json) and not an export of @onden/markdown.

export const FAST_MS = 50;
export const MAX_RATIO = 9;
export const CEILING_MS = 10_000;
const PAIRS = 5;

/** The calling thread's CPU milliseconds so far; the whole process's where Node (before 22.19) has no per-thread clock. */
export function cpuMs(): number {
  const used = process.threadCpuUsage ? process.threadCpuUsage() : process.cpuUsage();
  return (used.user + used.system) / 1000;
}

/** CPU milliseconds the run took on this thread, not wall time: a parse is synchronous, so its CPU time is the parser's own work,
 *  and a busy machine (parallel vitest workers, other packages' suites) only stretches the wall clock. A run that took 7 s of
 *  CPU needed 90 s of wall at 9× contention, past the test timeout, with the same growth ratio.
 *  The thread, not the process (process.cpuUsage adds every thread of it): V8's garbage-collector and compiler helper threads
 *  burn CPU in bursts that land on whichever run happens to be going, and a big input allocates more, so draws more of them.
 *  Those bursts are not the parser's work. Inside a run, the main thread's own collections still count: they are its garbage. */
export function timed(run: () => void): number {
  const started = cpuMs();
  run();
  return cpuMs() - started;
}

/** The CPU clock ticks in about 4 ms steps on some machines (a container without precise accounting), so a run of 1-2 ms reads 0 or
 *  4. Anything compared as a ratio is measured over at least this long. */
export const CLOCK_TICK_MS = 4;
const MIN_BATCH_MS = 6 * CLOCK_TICK_MS;

/** CPU milliseconds per run of `run`: the median of `batches` (odd). A batch repeats the run until it has used about MIN_BATCH_MS
 *  of CPU, so a clock tick is a small part of what is measured; a run that takes longer is measured once per batch.
 *  The median, not the fastest: interference makes a batch read high (another process, a collection) and the per-thread clock,
 *  which is only as fine as the kernel's accounting, sometimes reads a batch low or even 0; one of three of either is outvoted.
 *  (The wall clock is read once, to size the batch, never to judge.) */
export function typicalMs(run: () => void, batches = 3): number {
  const started = performance.now();
  run();
  const repeats = Math.min(50_000, Math.max(1, Math.ceil(MIN_BATCH_MS / Math.max(performance.now() - started, 0.05))));
  const readings: number[] = [];
  for (let batch = 0; batch < batches; batch++) readings.push(timed(() => { for (let i = 0; i < repeats; i++) run(); }) / repeats);
  return readings.sort((a, b) => a - b)[Math.floor(readings.length / 2)]!;
}

type Growth = { ratio: number; smallMs: number; bigMs: number; fastestBigMs: number };

function bestPair(small: () => void, big: () => void): Growth {
  let best: Growth = { ratio: Infinity, smallMs: 0, bigMs: 0, fastestBigMs: Infinity };
  for (let i = 0; i < PAIRS; i++) {
    const smallMs = timed(() => { small(); small(); small(); small(); }) / 4, bigMs = timed(big);
    const ratio = bigMs / Math.max(smallMs, CLOCK_TICK_MS);
    const fastestBigMs = Math.min(bigMs, best.fastestBigMs);
    best = ratio < best.ratio ? { ratio, smallMs, bigMs, fastestBigMs } : { ...best, fastestBigMs };
    // The best pair is what counts, and it can only get lower: one pair under
    // the limit is the verdict, the rest would only cost CPU.
    if (best.ratio < MAX_RATIO) break;
  }
  return best;
}

/** The size ratio from back-to-back pairs of equal work: four runs on the
 *  quarter-size body against one on the full body, best pair of PAIRS. A pair
 *  shares one moment's load, and with equal work in both halves a pause from
 *  a busy CPU is as likely in either half. A busy CPU only ever slows a run,
 *  so the best pair is the parser's own growth: a quadratic one is ~16× in
 *  every pair. A ratio over MAX_RATIO is measured once more (parallel vitest
 *  workers can load the machine for a whole round) and the lower round wins,
 *  so a real quadratic still fails and a noisy round does not.
 *  `fastestBigMs` is the fastest full-size run of any pair. */
export function bestRatio(small: () => void, big: () => void): Growth {
  const first = bestPair(small, big);
  if (first.ratio < MAX_RATIO) return first;
  const retry = bestPair(small, big);
  return { ...(retry.ratio < first.ratio ? retry : first), fastestBigMs: Math.min(first.fastestBigMs, retry.fastestBigMs) };
}
