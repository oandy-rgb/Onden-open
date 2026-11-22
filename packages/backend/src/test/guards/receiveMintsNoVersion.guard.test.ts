// What a node takes in from another (a snapshot join, a change bundle) carries the versions it had; it never mints one of its own
// (docs/architecture/proposals/history-replication-2026-11-22.md §4.2; review of PR #1935 round 1, point 8). Versions are minted by the
// local write paths (spine/noteVersions.ts recordVersion, called from updateNode, createNote and the writers listed in that file), and the
// receiving entries write rows with the stamp triggers standing aside, where minting is refused. This keeps it so: no file the receiving
// entries reach by import may import the local write paths or the minting itself. A merge that one day derives state through updateNode
// (2b-2b) fails here first, and has to answer "which node minted that version?" before it is allowed.
// The import graph is read with the TypeScript parser (ts.preProcessFile), not by matching text.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const rel = (f: string) => relative(SRC, f).split("\\").join("/");

/** Every source file `entry` reaches through relative imports (type-only imports included: they cost nothing to list). */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [join(SRC, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const imported of ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles) {
      if (imported.fileName.startsWith(".")) stack.push(resolve(dirname(file), imported.fileName).replace(/\.js$/, ".ts"));
    }
  }
  return new Set([...seen].map(rel));
}

/** The entries a received change or snapshot is written through. */
const RECEIVING_ENTRIES = ["spine/stampedImport.ts", "spine/stampedMerge/dbUnits.ts", "spine/stampedMerge/dbRows.ts"];
/** The local write paths that mint versions, and the minting itself. */
const MINTING = ["services/nodeUpdate.ts", "services/noteCreate.ts", "spine/noteVersions.ts"];

describe("a received change mints no version", () => {
  it.each(RECEIVING_ENTRIES)("%s reaches none of the local write paths that mint versions", (entry) => {
    const files = reachable(entry);
    expect(files.size).toBeGreaterThan(1); // the walk read the entry and what it imports
    expect(MINTING.filter((f) => files.has(f))).toEqual([]);
  });

  it("the walk sees a path that does reach them (the guard can fail)", () => {
    expect(MINTING.filter((f) => reachable("services/nodeUpdate.ts").has(f))).toEqual(["services/nodeUpdate.ts", "spine/noteVersions.ts"]);
  });
});
