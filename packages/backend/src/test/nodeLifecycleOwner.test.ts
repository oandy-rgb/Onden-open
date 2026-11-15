// D111 guard: "a live note never has a deleted parent" holds only if every
// delete and every way back goes through services/nodeTrash.ts trashLive /
// restoreLive. markTrashed / markLive stamp one row with no cascade, so a
// caller outside nodeTrash.ts can orphan a subtree (event restore did, before
// D111). Tag merge is the one exception: it trashes the merged tag alone, its
// sub-tags having moved to the target first.
//
// Deleting for good has one owner too: nodeTrash.ts purgeDeleted (and, for a
// space being deleted, purgeSpaceDeleted) is the only hard delete of a note
// row, and services/purgedContent.ts, which it calls, the only code that
// erases events (migration 118's opt-in). A second purge path would skip the
// erasure — titles left in the log, blobs and files left on disk.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set(["services/nodeTrash.ts", "services/tagMerge.ts"]);
const STAMP = /\bmark(?:Live|Trashed)\b/g;

/** Code only: a comment may name them (reservedTags.ts explains its check). */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("node lifecycle owner (D111)", () => {
  it("only nodeTrash.ts (and tag merge) stamp a row deleted or live", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const key = relative(SRC, file).split(sep).join("/");
      if (ALLOWED.has(key)) continue;
      const hits = withoutComments(readFileSync(file, "utf8")).match(STAMP);
      if (hits) offenders.push(`${key}: ${hits.length}× ${[...new Set(hits)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("only nodeTrash.ts hard-deletes a note row, and only purgedContent.ts erases events", () => {
    const deletes: string[] = [];
    const erasers: string[] = [];
    const purgeCallers: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const key = relative(SRC, file).split(sep).join("/");
      const code = withoutComments(readFileSync(file, "utf8"));
      if (/DELETE\s+FROM\s+content_nodes\b/i.test(code) && key !== "services/nodeTrash.ts") deletes.push(key);
      if (/allow_event_redact/.test(code) && key !== "services/purgedContent.ts") erasers.push(key);
      if (/from\s+"[./]*purgedContent\.js"/.test(code) && key !== "services/nodeTrash.ts") purgeCallers.push(key);
    }
    expect(deletes).toEqual([]);
    expect(erasers).toEqual([]);
    expect(purgeCallers).toEqual([]);
  });

  it("tag merge uses markTrashed only, never markLive", () => {
    const merge = withoutComments(readFileSync(join(SRC, "services/tagMerge.ts"), "utf8"));
    expect(merge.match(/\bmarkLive\b/g)).toBeNull();
  });
});
