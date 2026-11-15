// Slug owner guard (D55): a note's slug follows its title. services/nodes.ts
// owns the rule (slugFor / slugForTitle); a file that UPDATEs
// content_nodes.title without it leaves the old slug behind, and `[[New]]`
// then links the renamed note by slug and any later "New" by title.
//
// Source scan, like bodyWriteGuard.test.ts: every non-test file that sets the
// title column calls slugForTitle, or is listed below with the
// reason its slug does not follow the title.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

// `SET … title = …` in SQL (up to its WHERE, so a `WHERE title = $2` lookup
// is not a write), a built assignment (`title = $n` pushed onto a SET list),
// or the `set("title", …)` column helper (not a Map's `.set("title", …)`).
const WRITES_TITLE = /\bSET\b(?:(?!\bWHERE\b)[^`;])*?\btitle\s*=|[`"']title\s*=\s*\$|(?<![.\w])set\(\s*["']title["']/i;
const FOLLOWS_TITLE = /\bslugForTitle\(/;

// Writers whose slug is not the title's, with the reason.
const EXEMPT: Record<string, string> = {
  // A task's slug is `task-<uuid>` (slugFor keeps it).
  "services/tasksStore.ts": "task slug names the row",
  // A canvas's slug is `canvas-<uuid>` (slugFor keeps it).
  "services/canvasNodes.ts": "canvas slug names the row",
};

const writers = () => sourceFiles(srcDir)
  .filter((file) => WRITES_TITLE.test(readFileSync(file, "utf8")))
  .map((file) => relative(srcDir, file).split(sep).join("/"));

describe("slug owner guard (D55)", () => {
  it("every file that writes content_nodes.title makes the slug follow it", () => {
    const offenders = writers()
      .filter((file) => !(file in EXEMPT))
      .filter((file) => !FOLLOWS_TITLE.test(readFileSync(join(srcDir, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the scan sees exactly the known title writers", () => {
    // A new writer fails here first: add it to the list once it calls
    // slugForTitle (or to EXEMPT, with the reason).
    // nodeUpdate.ts (applyNodeColumns) and tagIdentity.ts (applyTagIdentity) write
    // the column from a list; the next test checks them and their callers.
    expect(writers().sort()).toEqual([
      "services/canvasNodes.ts",
      "services/tasksStore.ts",
    ]);
  });

  it("the writers that build the column name from a list follow the title too", () => {
    const read = (file: string) => readFileSync(join(srcDir, file), "utf8");
    // A save writes title and slug together (nodeUpdate: the slug it computed).
    expect(read("services/nodeUpdate.ts")).toMatch(/NODE_COLUMNS = \["title", "slug"/);
    expect(read("services/nodeUpdate.ts")).toMatch(FOLLOWS_TITLE);
    // Event-history undo writes its columns through the same function and names the slug with the title.
    const restore = read("services/eventRestore/restore.ts");
    expect(restore).toMatch(/nodeScalarFields = \["title"/);
    expect(restore).toMatch(/applyNodeColumns\(/);
    expect(restore).toMatch(FOLLOWS_TITLE);
    // A tag rename and its undo write the name and the slug it recorded together.
    expect(read("services/tagIdentity.ts")).toMatch(/IDENTITY_COLUMNS = \{ name: "title", slug: "slug"/);
    expect(read("services/eventRestore/tags.ts")).toMatch(/applyTagIdentity\(/);
  });

  it("every exemption is still a title writer", () => {
    const seen = new Set(writers());
    expect(Object.keys(EXEMPT).filter((file) => !seen.has(file))).toEqual([]);
  });
});
