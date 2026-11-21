// Mutation testing of the stamped merge core (spine/stampedMerge, the pure half). Not part of `npm test`.
// A separate file so the core set in stryker.config.mjs and its database-backed test list stay as they are:
// here the killers are only the three pure test files (no database), so several workers can run at once.
//
//   npx stryker run stryker.stampedMerge.config.mjs
//
// The simulation runs with fewer seeds than `npm test` (vitest.mutation.stampedMerge.config.ts says how many and why);
// the per-file table and the verdict on every surviving mutant are in the PR that added this file.
import base from "./stryker.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  vitest: { configFile: "vitest.mutation.stampedMerge.config.ts" },
  mutate: [
    "src/spine/stampedMerge/unit.ts",
    "src/spine/stampedMerge/store.ts",
    "src/spine/stampedMerge/body.ts",
    "src/spine/stampedMerge/rows.ts",
    "src/spine/stampedMerge/rules/*.ts",
  ],
  // pure tests: no shared database, so workers do not step on each other
  concurrency: 4,
  incrementalFile: "reports/mutation-stampedMerge/stryker-incremental.json",
  jsonReporter: { fileName: "reports/mutation-stampedMerge/mutation.json" },
  htmlReporter: { fileName: "reports/mutation-stampedMerge/index.html" },
  timeoutMS: 60000,
};
