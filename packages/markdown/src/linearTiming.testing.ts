// Timing helper shared by the two bodyParsersLinear tests (backend, frontend):
// "linear" means a body four times as long takes about four times as long; a
// quadratic parser takes sixteen. Comparing two sizes on the same machine holds
// under load, where a fixed millisecond budget did not. Test-only: excluded
// from the package build (tsconfig.json) and not an export of @onden/markdown.

export const FAST_MS = 50;
export const MAX_RATIO = 9;
export const CEILING_MS = 10_000;
const PAIRS = 5;

/** CPU milliseconds the run took (user + system of this process), not wall
 *  time: a parse is synchronous, so its CPU time is the parser's own work, and a
 *  busy machine (parallel vitest workers, other packages' suites) only stretches
 *  the wall clock. A run that took 7 s of CPU needed 90 s of wall at 9× contention,
 *  past the test timeout, with the same growth ratio. */
export function timed(run: () => void): number {
  const started = process.cpuUsage();
  run();
  const used = process.cpuUsage(started);
  return (used.user + used.system) / 1000;
}

type Growth = { ratio: number; smallMs: number; bigMs: number; fastestBigMs: number };

function bestPair(small: () => void, big: () => void): Growth {
  let best: Growth = { ratio: Infinity, smallMs: 0, bigMs: 0, fastestBigMs: Infinity };
  for (let i = 0; i < PAIRS; i++) {
    const smallMs = timed(() => { small(); small(); small(); small(); }) / 4, bigMs = timed(big);
    const ratio = bigMs / Math.max(smallMs, 0.01);
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
