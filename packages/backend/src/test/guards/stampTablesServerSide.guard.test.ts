// The write stamps (sync_stamps) and the structure log (structure_log) stay on the server (causal-stamps proposal §2, §8.5): no payload a
// device is sent is built from them, so migration 202 (which only adds rows to them) cannot change what a device receives, and a local copy
// needs no re-read after it (the lesson of migration 201). This lists the files that may name either table; a new reader has to be added
// here on purpose, and its author asks "does this reach a device?".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MAY_NAME_THEM = new Set([
  "spine/stamps.ts", // allocates and adopts the transaction's stamp, counts writes without one
  "spine/syncClasses.ts", // the classification of what is stamped
  "services/attributeWrites.ts", // reads the replaced value's own stamp to compare clocks (#1658)
  "services/attributeChange.ts", // stamps an attribute a new note inherits when it is made, and reads the replaced value's stamp (#1658)
  "browser/nodeIdentity.ts", // a browser-app copy moves its own stamps to its own node id once (#1706); in that copy only, nothing is sent
  "db.ts", // at start, discards the stamps and clock of a snapshot import that was cut off (discardUnfinishedJoins); nothing is sent
  "spine/snapshotSql.ts", // reads the stamps of the rows a stamped snapshot carries, and their digest (export and check of a copy to an empty database)
  "spine/stampedImport.ts", // the one entry that writes a snapshot's stamps as received into a database that is joining (sync_join, migration 204)
  "services/stampedSnapshot.ts", // names sync_stamps only to refuse a snapshot of a database that holds stamps of another node; never sends one but through the owner-only snapshot route
  "dbSchema.generated.ts", // generated column types
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("the stamp tables are server-side", () => {
  it("only the listed files name sync_stamps or structure_log", () => {
    const named = sourceFiles(SRC).filter((f) => /\b(sync_stamps|structure_log)\b/.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f).split("\\").join("/")).sort();
    expect(named.filter((f) => !MAY_NAME_THEM.has(f))).toEqual([]);
  });
});
