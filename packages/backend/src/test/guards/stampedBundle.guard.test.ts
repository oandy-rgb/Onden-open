// What a change bundle never carries and where its checks live. Pure file check, no database.
//   - structure_log is this device's own history and never leaves it (docs/architecture/proposals/causal-stamps-2026-11-12.md §8.5): the files that read a bundle (spine/stampedBundle.ts)
//     and the wire types (spine/snapshotSql.ts) do not read it; the only file that writes it for a merge is spine/stampedMerge/dbRows.ts, as lines of what came from another device.
//   - the shape version has one definition (spine/syncDataShape.ts) and is carried by the snapshot page and the bundle header.
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
const code = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("a change bundle and the structure log", () => {
  it("the bundle's reader and its wire types never select from structure_log", () => {
    for (const f of ["spine/stampedBundle.ts", "spine/snapshotSql.ts"]) expect(code(join(SRC, f)), `${f} reads structure_log into something that is sent`).not.toMatch(/\bstructure_log\b/);
  });
  it("only dbRows.ts writes structure_log for a merge, and only by INSERT (the table is append-only)", () => {
    const writers = sourceFiles(SRC).filter((f) => /\bINSERT\s+INTO\s+structure_log\b/i.test(code(f))).map(rel).sort();
    expect(writers).toEqual(["spine/stampedMerge/dbRows.ts"]);
  });
});

describe("the data shape version", () => {
  it("is defined once and carried by the snapshot page and the bundle header", () => {
    const definers = sourceFiles(SRC).filter((f) => /export const SYNC_DATA_SHAPE_VERSION\b/.test(code(f))).map(rel);
    expect(definers).toEqual(["spine/syncDataShape.ts"]);
    expect(code(join(SRC, "services/stampedSnapshot.ts"))).toMatch(/dataShape:\s*SYNC_DATA_SHAPE_VERSION/);
    expect(code(join(SRC, "spine/stampedBundle.ts"))).toMatch(/dataShape:\s*SYNC_DATA_SHAPE_VERSION/);
    expect(code(join(SRC, "spine/stampedImport.ts"))).toMatch(/bundle\.dataShape !== SYNC_DATA_SHAPE_VERSION/);
    expect(code(join(SRC, "spine/stampedImport.ts"))).toMatch(/page\.dataShape !== SYNC_DATA_SHAPE_VERSION/);
  });
  it("the bundle is read in ONE snapshot: the cut and the stamps cannot be read at different moments", () => {
    const c = code(join(SRC, "spine/stampedBundle.ts"));
    expect(c).toMatch(/if \(!inTransaction\(\)\) throw/); // the spine reader refuses to run outside a snapshot the caller opened
    expect(c.match(/\bpool\b/g)).toBeNull();
    expect(code(join(SRC, "services/stampedBundle.ts"))).toMatch(/return withActorReadSnapshot\(authenticated, workspaceId,/);
  });
});

describe("a row key is compared as its own type", () => {
  it("the merge's SQL never compares a key as text (it keeps the primary key's index from being used: the apply cost was quadratic)", () => {
    for (const f of ["spine/stampedMerge/dbUnits.ts", "spine/stampedMerge/dbRows.ts", "spine/stampedBundle.ts"]) {
      expect(code(join(SRC, f)), `${f} compares a key as text`).not.toMatch(/\b(?:id|keyColumn\)\})::text\s*=\s*\$\d/);
    }
  });
});

describe("the merge never renumbers siblings", () => {
  it("no file of the merge or the bundle names the order-key writers: a renumbering made by every node on its own would be a stamped write nobody made (rules/place.ts; equal keys are ordered by key, order_stamp, id, and split by the next person's reorder, planSiblingOrder)", () => {
    const files = [...sourceFiles(join(SRC, "spine/stampedMerge")), join(SRC, "spine/stampedBundle.ts"), join(SRC, "spine/stampedImport.ts")];
    for (const f of files) expect(code(f), rel(f)).not.toMatch(/\b(respaceSiblings|respaceIfTooLong|appendOrderKey|keyForRestore|orderKeys\.js)\b/);
  });
});
