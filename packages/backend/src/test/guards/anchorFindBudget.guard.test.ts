// Guard: the number of lookups a save may make (mapping.ts FIND_BUDGET) is part of the function, not a setting of the caller.
// `MoveContext.findBudget` exists so a test can show that where the budget is cut changes only how many passes settle takes
// (properties/anchorPath.property.test.ts). Product code (src/, without test/) must never pass it: a node that used another number
// would reach another state from the same body (proposal docs/architecture/proposals/anchors-deterministic-2026-11-16.md §3.1).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === "node_modules" || name === "dist" || name === "test") return [];
  if (statSync(path).isDirectory()) return sources(path);
  return /\.ts$/.test(name) ? [path] : [];
});

describe("anchor lookup budget", () => {
  it("no product file but mapping.ts mentions findBudget", () => {
    const users = sources(SRC).filter((file) => /\bfindBudget\b/.test(readFileSync(file, "utf8"))).map((file) => relative(SRC, file));
    expect(users).toEqual(["services/blockAnchors/mapping.ts"]);
  });
});
