// Guard: the stamped snapshot is made for the workspace OWNER only (services/stampedSnapshotStream.ts), and this fails the day another
// caller reads it for a limited reader. readStampedPages itself accepts any person (its scope is that person's readable set, and a
// test shows a limited reader's snapshot digests the same on a receiver), but two things are not ready for one:
//   1. tombstones (spine/snapshotSql.ts readTombstoneChunk) are the workspace's, not cut by the reader's scope: they name the ids of
//      rows the reader cannot read;
//   2. a row whose foreign key names a row the reader cannot read (a note in a readable space whose parent is not, a tag application
//      on a hidden tag, ...) cannot be applied on the receiver, so the whole join rolls back instead of leaving the row out.
// Before a caller for anyone but the owner is added, fix both, make this test name the new caller, and add a test with a limited reader
// whose notes point at notes they cannot read.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { code, productionFiles, rel, SRC } from "./nodeStoreOwnershipScan.js";
import { join } from "node:path";

describe("the snapshot is read for the owner only until limited readers are handled", () => {
  it("one production file calls readStampedPages, and it requires the owner first", () => {
    const callers = productionFiles().map(rel).filter((f) => /\breadStampedPages\s*\(/.test(code(readFileSync(join(SRC, f), "utf8"))) && f !== "services/stampedSnapshot.ts").sort();
    expect(callers, "a new reader of the snapshot: see the header of this test about limited readers").toEqual(["services/stampedSnapshotStream.ts"]);
    expect(readFileSync(join(SRC, "services/stampedSnapshotStream.ts"), "utf8")).toMatch(/isWorkspaceOwner\(/);
  });

  it("the code that would need the fix says so where it is", () => {
    for (const file of ["services/stampedSnapshot.ts", "spine/snapshotSql.ts"]) {
      expect(readFileSync(join(SRC, file), "utf8"), file).toContain("before an export for a limited reader");
    }
  });
});
