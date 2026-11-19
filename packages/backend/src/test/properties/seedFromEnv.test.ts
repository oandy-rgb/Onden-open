// Every property suite here must take its run count from PROPS_RUNS (helpers/propsConfig). A hard-coded
// `numRuns: 200` ignores it. Fixed seeds are caught for all tests and e2e scripts by
// packages/markdown/src/test/guards/seedRandom.guard.test.ts.
// A per-property cap is fine as an expression, e.g. Math.min(PROPS_RUNS, 50).
// fc.sample (checking what a generator reaches, not a property) may fix its seed.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("property suites read PROPS_RUNS", () => {
  const files = readdirSync(here).filter((f) => f.endsWith(".property.test.ts"));

  it.each(files)("%s has no literal numRuns", (file) => {
    const src = readFileSync(join(here, file), "utf8").split("\n").filter((line) => !line.includes("fc.sample(")).join("\n");
    expect(src.match(/\bnumRuns\s*:\s*\d/g) ?? []).toEqual([]);
    expect(src.match(/\bRUNS\s*=\s*\d/g) ?? []).toEqual([]);
  });
});
