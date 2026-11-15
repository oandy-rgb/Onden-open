// Timing helpers shared by the backend, frontend and bundle parts of `npm run bench`.

/** @param {number[]} sorted ascending */
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  // Nearest rank: with 9 runs p95 is the slowest, which is what a noisy-run budget wants.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * @param {number[]} samples
 * @param {string} unit
 */
export function summarize(samples, unit) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const round = (n) => Math.round(n * 100) / 100;
  return {
    unit, median: round(median), p95: round(percentile(sorted, 95)),
    min: round(sorted[0]), max: round(sorted[sorted.length - 1]), runs: samples.map(round),
  };
}

/**
 * Warm-up runs are discarded (JIT, plan and page caches), then `runs` timed
 * runs. `prepare` runs before each call and is not timed.
 * @param {() => unknown | Promise<unknown>} fn
 * @param {{ runs?: number, warmup?: number, prepare?: () => unknown | Promise<unknown> }} [options]
 */
export async function timeMs(fn, { runs = 9, warmup = 2, prepare } = {}) {
  const samples = [];
  for (let i = 0; i < warmup + runs; i++) {
    if (prepare) await prepare();
    const start = performance.now();
    await fn();
    const elapsed = performance.now() - start;
    if (i >= warmup) samples.push(elapsed);
  }
  return summarize(samples, "ms");
}
