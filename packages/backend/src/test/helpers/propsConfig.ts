// Run count and seed for the randomized property tests (src/test/properties).
//
//   PROPS_RUNS  runs per property (default 200)
//   PROPS_SEED  fast-check seed (default: a fresh one per test file on every run, owner 2026-11-18 「種子都隨機」;
//               `npm run test:props:long` uses today's date and prints it)
//
// A failure reports the seed and fast-check's shrunk counterexample; replay it
// with the same two variables, e.g.
//   PROPS_SEED=123 PROPS_RUNS=5000 npm -w packages/backend exec vitest -- run src/test/properties/bodyMerge.property.test.ts

import fc from "fast-check";

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** A seed nobody has run before: every run without PROPS_SEED explores new cases. */
const freshSeed = (): number => 1 + Math.floor(Math.random() * (2 ** 31 - 2));

export const PROPS_SEED = positive(process.env.PROPS_SEED, freshSeed());
export const PROPS_RUNS = positive(process.env.PROPS_RUNS, 200);

function withReplay(error: unknown, runs: number): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${detail}\n\nreplay: PROPS_SEED=${PROPS_SEED} PROPS_RUNS=${runs}`, { cause: error });
}

/** fc.assert with the env seed and run count; failures name the seed to replay. */
export function check<T>(property: fc.IProperty<T>, maxRuns = Infinity): void {
  const runs = Math.min(PROPS_RUNS, maxRuns);
  try {
    fc.assert(property, { seed: PROPS_SEED, numRuns: runs });
  } catch (error) {
    throw withReplay(error, runs);
  }
}

/** `check` for async properties; `maxRuns` caps slow (database) properties. */
export async function checkAsync<T>(property: fc.IAsyncProperty<T>, maxRuns = Infinity): Promise<void> {
  const runs = Math.min(PROPS_RUNS, maxRuns);
  try {
    await fc.assert(property, { seed: PROPS_SEED, numRuns: runs });
  } catch (error) {
    throw withReplay(error, runs);
  }
}
