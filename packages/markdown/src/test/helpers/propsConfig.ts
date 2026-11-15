// Run count and seed for the randomized property tests (src/test/properties).
// Same variables as packages/backend/src/test/helpers/propsConfig.ts:
//
//   PROPS_RUNS  runs per property (default 200)
//   PROPS_SEED  fast-check seed (default fixed, so a merge run is deterministic)
//
// The nightly run sets a fresh PROPS_SEED; a failure prints fast-check's seed
// and shrunk counterexample, replay with the same two variables.

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const PROPS_SEED = positive(process.env.PROPS_SEED, 20261023);
export const PROPS_RUNS = positive(process.env.PROPS_RUNS, 200);
