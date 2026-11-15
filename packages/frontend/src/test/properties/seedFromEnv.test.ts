// Every property suite here must take its seed and run count from
// PROPS_SEED / PROPS_RUNS (helpers/propsConfig). A hard-coded `seed: 123` or
// `numRuns: 200` makes the nightly fresh-seed run replay the same cases forever.
// A per-property cap is fine as an expression, e.g. Math.min(PROPS_RUNS, 50).
// fc.sample (checking what a generator reaches, not a property) may fix its seed.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("property suites read PROPS_SEED / PROPS_RUNS", () => {
  const files = readdirSync(here).filter((f) => f.endsWith(".property.test.ts"));

  it.each(files)("%s has no literal seed or numRuns", (file) => {
    const src = readFileSync(join(here, file), "utf8").split("\n").filter((line) => !line.includes("fc.sample(")).join("\n");
    expect(src.match(/\b(seed|numRuns)\s*:\s*\d/g) ?? []).toEqual([]);
    expect(src.match(/\b(SEED|RUNS)\s*=\s*\d/g) ?? []).toEqual([]);
  });
});
