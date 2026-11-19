// Run count and seed for the randomized property tests (src/test/properties).
// Same variables as packages/backend/src/test/helpers/propsConfig.ts:
//
//   PROPS_RUNS  runs per property (default 200)
//   PROPS_SEED  fast-check seed (default: a fresh one per test file on every run, owner 2026-11-18 「種子都隨機」)
//
// A failure prints fast-check's seed and shrunk counterexample; replay with the
// same two variables, and keep the counterexample as a fixed regression case.

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** A seed nobody has run before: every run without PROPS_SEED explores new cases. */
const freshSeed = (): number => 1 + Math.floor(Math.random() * (2 ** 31 - 2));

export const PROPS_SEED = positive(process.env.PROPS_SEED, freshSeed());
export const PROPS_RUNS = positive(process.env.PROPS_RUNS, 200);

/**
 * Known defects (each pinned by an `it.fails` in the same file) are left out of the random runs so every other invariant
 * keeps being checked. PROPS_INCLUDE_KNOWN=1 puts them back: the property then fails with the shrunk case. The one switch for
 * all random tests (guard: packages/markdown/src/test/guards/knownCases.guard.test.ts); a file that leaves a case out
 * names the `it.fails` that pins it.
 */
export const INCLUDE_KNOWN_CASES = process.env.PROPS_INCLUDE_KNOWN === "1";
