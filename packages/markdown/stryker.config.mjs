// Mutation testing (docs/archive/research/mutation-2026-10-24.md). Not part of `npm test`.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: ["src/sanitizeSchema.ts", "src/mediaEmbed.ts", "src/mediaSanitize.ts"],
  coverageAnalysis: "perTest",
  concurrency: 2,
  // The schema modules are built at import time, so nearly all their mutants are "static": they
  // must be run (a static mutant runs every test, which is cheap for this package).
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
