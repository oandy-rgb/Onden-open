// Mutation testing (docs/archive/research/mutation-2026-10-24.md). Not part of `npm test`.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts" },
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "src/lib/data/draftActions.ts",
    "src/lib/data/writeQueue.ts",
    "src/lib/data/storeOps.ts",
    "src/lib/localDbJournal.ts",
  ],
  coverageAnalysis: "perTest",
  concurrency: 2,
  // Static mutants (run at module load) re-run the whole test set each: hours for no signal.
  ignoreStatic: true,
  dryRunTimeoutMinutes: 40,
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
  reporters: ["clear-text", "json", "html"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  htmlReporter: { fileName: "reports/mutation/index.html" },
  timeoutMS: 30000,
  timeoutFactor: 2,
  // The vitest configs alias @onden/markdown by a path relative to the package, which a
  // sandbox copy under .stryker-tmp would break.
  inPlace: true,
};
