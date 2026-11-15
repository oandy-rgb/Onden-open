import { defineConfig } from "vitest/config";

// `npm run test:fuzz` / `test:fuzz:long`: only the *.fuzz.test.ts files (the
// regular config leaves them out). One file per worker; no shuffle seed to
// replay here, the fuzz seed (FUZZ_SEED) is what reproduces a failure.
export default defineConfig({
  test: {
    include: ["src/**/*.fuzz.test.ts"],
    maxWorkers: 2,
    testTimeout: 120_000,
  },
});
