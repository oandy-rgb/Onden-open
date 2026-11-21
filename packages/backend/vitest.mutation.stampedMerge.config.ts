import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

// The vitest config stryker.stampedMerge.config.mjs uses: only the pure tests of the merge core. No database, so this is an
// explicit no-database run. The simulation runs 2 seeds of 100 steps per scenario instead of 5 (each mutant re-runs every
// test that reaches it; at 5 seeds a surviving mutant costs about a minute). The seeds of stampedMergeSim.test.ts are its own.
// The run-mode gate (scripts/lib/skipGateReporter.mjs) and globalSetup read it in the main process, not the workers.
process.env.ONDEN_TESTS_WITHOUT_DATABASE ??= "1";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    testTimeout: 120_000,
    include: [
      "src/test/stampedMerge.test.ts",
      "src/test/stampedMergeAlgebra.test.ts",
      "src/test/stampedMergeSim.test.ts",
      // rows.ts has its own pure test (the database form of a row's merge against the store's); the supplementary run of rows.ts adds it:
      //   STAMPED_MUTATION_ROWS=1 npx stryker run stryker.stampedMerge.config.mjs --mutate src/spine/stampedMerge/rows.ts --incrementalFile reports/mutation-stampedMerge/rows-incremental.json
      ...(process.env.STAMPED_MUTATION_ROWS ? ["src/test/stampedRows.test.ts"] : []),
      // body.ts's anchor merge (mergeAnchors, resolveBodyAnchors, anchorsOfVersion; PR #1853) has its own pure property test; the supplementary run of body.ts adds it:
      //   STAMPED_MUTATION_ANCHORS=1 npx stryker run stryker.stampedMerge.config.mjs --mutate src/spine/stampedMerge/body.ts --incrementalFile reports/mutation-stampedMerge/body-incremental.json
      ...(process.env.STAMPED_MUTATION_ANCHORS ? ["src/test/properties/anchorMerge.property.test.ts"] : []),
    ],
    env: { ...base.test?.env, STAMPED_SIM_SEEDS: "2" },
  },
});
