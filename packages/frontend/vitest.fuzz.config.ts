import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// `npm run test:fuzz` / `test:fuzz:long`: only the *.fuzz.test.ts files (the
// regular config leaves them out). Same aliases, jsdom and setup as the
// regular run.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["src/**/*.fuzz.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    testTimeout: 120_000,
  },
});
