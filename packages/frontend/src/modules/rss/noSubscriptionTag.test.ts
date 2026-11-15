// #subscription retired (migration 114): and since migration 145 an RSS source
// is a row of a table, not a note, so no frontend code may treat a tag called
// "subscription" — or the reserved key of that name — as special.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("#subscription appears nowhere", () => {
  it("no source file names the #subscription tag or its reserved key", () => {
    const hits = sourceFiles(SRC).flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return /#subscription\b|["']subscription["']/.test(text) ? [relative(SRC, path)] : [];
    });
    expect(hits).toEqual([]);
  });
});
