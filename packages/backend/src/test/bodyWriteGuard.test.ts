// Body write guard (D27): a note body is written in one way. Whoever UPDATEs
// content_nodes.markdown also runs the body pipeline (services/
// bodySideEffects.ts applyBodyChange): wikilink edges, block ids, backup,
// module content hooks (search embedding) and the cascade. A file that writes
// the column without it leaves the body unlinked, unindexed and unbacked —
// the Notion row-page import did (importNotionDatabase.ts attachBody).
//
// Source scan, like readGuard.test.ts: every non-test file that sets the
// markdown column must also call applyBodyChange.

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

// `SET … markdown = …` in SQL, a built assignment (`markdown = $n` pushed
// onto a SET list), or the `set("markdown", …)` column helper.
const WRITES_BODY = /\bSET\b[^`;]*?\bmarkdown\s*=|[`"']markdown\s*=\s*\$|\bset\(\s*["']markdown["']/i;

describe("body write guard (D27)", () => {
  it("every file that writes content_nodes.markdown runs applyBodyChange", () => {
    const offenders = sourceFiles(srcDir)
      .filter((file) => !file.endsWith("bodySideEffects.ts"))
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return WRITES_BODY.test(text) && !text.includes("applyBodyChange(");
      })
      .map((file) => relative(srcDir, file).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });

  it("the scan sees the known body writers", () => {
    const writers = sourceFiles(srcDir)
      .filter((file) => WRITES_BODY.test(readFileSync(file, "utf8")))
      .map((file) => relative(srcDir, file).split(sep).join("/"));
    expect(writers).toEqual(expect.arrayContaining([
      "services/nodeUpdate.ts", "modules/importers/notion/database.ts",
      "services/eventRestore/restore.ts",
    ]));
  });
});
