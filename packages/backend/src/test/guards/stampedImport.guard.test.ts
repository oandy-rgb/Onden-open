// The stamped snapshot import is the one entry that writes rows together with the stamps they came with, with the stamp triggers
// standing aside (spine/stampedImport.ts, spine/stamps.ts standAsideForImport; migration 204). It is a counted exception to "writes go
// through mutate": it must not become a general write path. This lists who may call it. A new caller has to be added here on purpose,
// with the reason, and the person who adds it answers "who is the operator, and what stops it from writing into a workspace in use?".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}
const rel = (f: string) => relative(SRC, f).split("\\").join("/");
const importersOf = (pattern: RegExp) => sourceFiles(SRC).filter((f) => pattern.test(readFileSync(f, "utf8"))).map(rel).sort();

// ratchet:list STAMPED_IMPORT_CALLERS
const MAY_IMPORT_THE_ENTRY: Record<string, string> = {
  "services/stampedJoin.ts": "the service a route calls: starts a join, applies pages, compares digests, finishes or abandons",
};
// ratchet:list STAND_ASIDE_CALLERS
const MAY_STAND_ASIDE: Record<string, string> = {
  "spine/stampedImport.ts": "the entry itself: the triggers stand aside only inside applyStampedPage, in the transaction that writes one page",
  "spine/stamps.ts": "where it is defined",
};
// ratchet:list STAMPED_JOIN_SERVICE_CALLERS
const MAY_CALL_THE_SERVICE: Record<string, string> = {
  "services/stampedSnapshotStream.ts": "the owner-only wire form: the snapshot stream out, and the upload into an empty workspace",
};
// ratchet:list STAMPED_SNAPSHOT_ROUTES
const MAY_CALL_THE_STREAM: Record<string, string> = {
  "routes/stampedSnapshot.ts": "the two owner-only routes: a thin call each",
};

describe("the stamped snapshot import has a short list of callers", () => {
  it("only the join service imports the import entry", () => {
    const found = importersOf(/spine\/stampedImport\.js|\.\/stampedImport\.js/);
    expect(found.filter((f) => !(f in MAY_IMPORT_THE_ENTRY) && f !== "spine/stampedImport.ts"), "call services/stampedJoin.ts instead").toEqual([]);
  });

  it("only the entry itself makes the stamp triggers stand aside", () => {
    const found = importersOf(/\bstandAsideForImport\b/);
    expect(found.filter((f) => !(f in MAY_STAND_ASIDE))).toEqual([]);
  });

  it("only the owner-only route calls the stream service", () => {
    const found = importersOf(/services\/stampedSnapshotStream\.js/);
    expect(found.filter((f) => !(f in MAY_CALL_THE_STREAM))).toEqual([]);
  });

  it("only the stream service calls the join service", () => {
    const found = importersOf(/services\/stampedJoin\.js|\.\/stampedJoin\.js/);
    expect(found.filter((f) => !(f in MAY_CALL_THE_SERVICE))).toEqual([]);
  });

  it("the lists name only files that still do it", () => {
    for (const [list, pattern] of [[MAY_IMPORT_THE_ENTRY, /spine\/stampedImport\.js/], [MAY_STAND_ASIDE, /\bstandAsideForImport\b/], [MAY_CALL_THE_SERVICE, /stampedJoin\.js/], [MAY_CALL_THE_STREAM, /services\/stampedSnapshotStream\.js/]] as const) {
      const stale = Object.keys(list).filter((f) => !pattern.test(readFileSync(join(SRC, f), "utf8")));
      expect(stale, "remove the entry from the list").toEqual([]);
    }
  });
});
