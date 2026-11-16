// Nothing outside the tests may write merged units into a workspace yet. `mergeUnitsIntoWorkspace` (spine/stampedImport.ts) and `storeMergedUnits`
// (spine/stampedMerge/dbUnits.ts) can store a second head of a unit, and a plain write by a background job or any other system actor would still
// "resolve" such a conflict (the stamp trigger cannot tell a person from the system; migration 205 header, stampedMerge README). So whoever connects a
// transport must first make that impossible: only a person's write may cover the heads of a conflicted unit (batch 2b). This fails the moment a
// production file calls either one; its message says what to do first. Pure file check, no database.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
  return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
});
const rel = (f: string) => relative(SRC, f).split("\\").join("/");
const code = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n"); // comments name things too
const naming = (pattern: RegExp) => sourceFiles(SRC).filter((f) => pattern.test(code(f))).map(rel).sort();

describe("merged units are not written by anything but the tests yet", () => {
  it("mergeUnitsIntoWorkspace has no caller outside its own file", () => {
    expect(naming(/\bmergeUnitsIntoWorkspace\b/), "first block system and background writes from resolving a conflict (only a person's write may cover its heads), then connect the transport").toEqual(["spine/stampedImport.ts"]);
  });
  it("storeMergedUnits is reached only through that entry", () => {
    expect(naming(/\bstoreMergedUnits\b/)).toEqual(["spine/stampedImport.ts", "spine/stampedMerge/dbUnits.ts", "spine/stampedMerge/index.ts"]);
  });
  it("the stamp triggers stand aside for a merge from one place only", () => {
    expect(naming(/standAsideForImport\([^)]*"merge"/)).toEqual(["spine/stampedImport.ts"]);
  });
});
