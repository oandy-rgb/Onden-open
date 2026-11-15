import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

// The vitest config Stryker uses (stryker.config.mjs): the normal one, minus the tests
// named in ONDEN_MUTATION_SKIP_TESTS (comma-separated). Stryker's first run must be all
// green, so a test that is already red on main has to be left out of it.
const skip = (process.env.ONDEN_MUTATION_SKIP_TESTS ?? "").split(",").filter(Boolean);

// Spread, not mergeConfig: merging would append to base's exclude, which is fine here,
// but keeps one habit with the backend config.
export default defineConfig({
  ...base,
  test: { ...base.test, exclude: [...(base.test?.exclude ?? []), ...skip] },
});
