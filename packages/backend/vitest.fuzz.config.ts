import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

// `npm run test:fuzz` / `test:fuzz:long`: only the *.fuzz.test.ts files (the
// regular config leaves them out), without the database globalSetup: the fuzz
// targets are pure functions and run with no DATABASE_URL.
export default defineConfig({
  resolve: base.resolve,
  test: {
    include: ["src/**/*.fuzz.test.ts"],
    maxWorkers: 2,
    testTimeout: 120_000,
  },
});
