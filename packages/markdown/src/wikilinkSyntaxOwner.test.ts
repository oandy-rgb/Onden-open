import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Guard: what a `[[link]]` is belongs to this package (text.ts: scanWikilinks,
// soleWikilink, replaceWikilinks). A regex or pattern string of the form
// `\[\[…` anywhere else is a second definition that drifts when the syntax does
// (ten of them had, before D). A new need gets a function here; an exception
// goes in ALLOWED with the reason it cannot use one.

const ALLOWED: Record<string, string> = {
  "frontend/src/lib/editorCompletion.ts": "a half-typed `[[xx` under the cursor: no closing `]]` yet, so not a link to scan",
  "backend/src/modules/rss/htmlToMarkdown.ts": "writes an escape (`[[` -> `\\[\\[`) into converted text; reads no link",
  "backend/src/services/wikilinkEdges.ts": "SQL text pre-filter of relinkTarget; the exact rule runs after it, held to the fixture by test/wikilinkTargets.integration.test.ts",
};

/** Lines of `source` outside comments that hold an escaped `[[` (a regex or a pattern string). */
export function wikilinkPatternLines(source: string): number[] {
  const hits: number[] = [];
  source.split("\n").forEach((line, i) => {
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
    if (/\\{1,2}\[\\{1,2}\[/.test(code)) hits.push(i + 1);
  });
  return hits;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" || name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|testing)\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("who defines `[[link]]` syntax", () => {
  it("the guard finds a hand-written link pattern (a violation it must catch)", () => {
    expect(wikilinkPatternLines("const LINK = /^\\[\\[([^\\]]+)\\]\\]$/;")).toEqual([1]);
    expect(wikilinkPatternLines(["// a comment on /\\[\\[x/", "const ok = text.indexOf(\"[[\");"].join("\n"))).toEqual([]);
  });

  it("no source file outside this package writes one", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const found: string[] = [];
    for (const pkg of ["frontend", "backend", "site"]) {
      for (const file of sourceFiles(join(root, pkg, "src"))) {
        const name = relative(root, file).split(sep).join("/");
        if (name in ALLOWED) continue;
        for (const line of wikilinkPatternLines(readFileSync(file, "utf8"))) found.push(`${name}:${line}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("every exception still needs its exception", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    for (const name of Object.keys(ALLOWED)) {
      expect(wikilinkPatternLines(readFileSync(join(root, name), "utf8")).length, name).toBeGreaterThan(0);
    }
  });
});
