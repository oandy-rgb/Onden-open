// Nothing outside the tests may write merged units into a workspace except through ONE entry: `applyChangeBundle` (spine/stampedImport.ts, batch 2b-1). It is the allowed
// product caller of the merge write-back (`storeMergedUnits`, `storeMergedRows`) and of the stand-aside switch for a merge, because it is the entry that checks what a merge
// needs before any head can be written: the sender is an origin this workspace admitted, the data shape is the same, the bundle continues what this node holds, no stamp this
// node holds comes back with other content (spine/stampedImport.ts lists the refusals). A system or background write can no longer resolve the conflict such a head makes
// (migration 206 sync_stamp_put_over refuses it; syncSystemWriteConflict.integration.test.ts), which is what this guard was waiting for. `mergeUnitsIntoWorkspace` (single
// units) stays a test and tool entry with no product caller. Pure file check, no database.
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

describe("merged units are written by one product entry only", () => {
  it("applyChangeBundle is defined in its own file and has no caller outside it yet (the transport, a later batch, is the first)", () => {
    expect(naming(/\bapplyChangeBundle\b/)).toEqual(["spine/stampedImport.ts"]);
  });
  it("mergeUnitsIntoWorkspace has no caller outside its own file", () => {
    expect(naming(/\bmergeUnitsIntoWorkspace\b/)).toEqual(["spine/stampedImport.ts"]);
  });
  it("the write-back of units and rows is reached only through those two entries", () => {
    expect(naming(/\bstoreMergedUnits\b/)).toEqual(["spine/stampedImport.ts", "spine/stampedMerge/dbUnits.ts", "spine/stampedMerge/index.ts"]);
    expect(naming(/\bstoreMergedRows\b/)).toEqual(["spine/stampedImport.ts", "spine/stampedMerge/dbRows.ts", "spine/stampedMerge/index.ts"]);
  });
  it("the stamp triggers stand aside for a merge from one place only", () => {
    expect(naming(/standAsideForImport\([^)]*"merge"/)).toEqual(["spine/stampedImport.ts"]);
  });
  it("no product code writes a foreign stamp or a merged unit by another road than applyChangeBundle: have (sync_origins) stays contiguous only if one entry moves it", () => {
    expect(naming(/\badoptForeignStamp\b/)).toEqual(["spine/stamps.ts"]); // defined, called by nothing
  });
  it("a bundle is read by nothing but its own service (no product caller before the transport)", () => {
    expect(naming(/\breadChangeBundle\b/)).toEqual(["services/stampedBundle.ts"]);
  });
});
