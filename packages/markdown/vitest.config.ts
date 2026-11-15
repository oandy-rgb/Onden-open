import { defineConfig } from "vitest/config";

// Two workers, as in the frontend and backend configs: vitest's default is one
// per core (16 here) on a 7 GB machine. Widen with --maxWorkers=N.
export default defineConfig({
  test: {
    // Fuzz suites run by `npm run test:fuzz` (vitest.fuzz.config.ts).
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.fuzz.test.ts"],
    maxWorkers: 2,
    // Files and tests run shuffled; the seed is printed at the top of every
    // run. Rerun an order with --sequence.seed=<seed> (see the frontend config).
    sequence: { shuffle: { files: true, tests: true } },
  },
});
