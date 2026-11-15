// Mutation testing (docs/archive/research/mutation-2026-10-24.md). Not part of `npm test`.
// `npm run test:mutation` mutates the core set below; `npm run test:mutation:file -- <path>` one file.
//
// The integration tests need a test database: DATABASE_URL must name a `_test` database.
// They share ONE database and scrub it in beforeAll, so Stryker runs a single worker
// (concurrency 1) and the database is kept, not rebuilt (ONDEN_TEST_DB_KEEP=1).
process.env.ONDEN_TEST_DB_KEEP ??= "1";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts" },
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "src/services/eventLog/bodyMerge.ts",
    "src/spine/authority.ts",
    "src/services/readPolicy.ts",
    "src/spine/spaceAccess.ts",
    "src/spine/spaceScope.ts",
    "src/spine/idempotency.ts",
    "src/services/sync/delta.ts",
    "src/services/parentKind.ts",
    "src/services/nodeTree.ts",
  ],
  coverageAnalysis: "perTest",
  concurrency: 1,
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
