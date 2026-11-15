// Guard: how long a note takes to read has one rule, and it lives here.
// Review 2026-10-27 (docs/archive/research/review-2026-10-27/deep-modules-site.md, problem 1) found the app's
// editor and the published site counting differently because each carried its own
// copy of the words-per-minute constants. The editor now calls `readingMinutes`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = fileURLToPath(new URL("../../../../", import.meta.url));
const OWNER = join("markdown", "src", "readingTime.ts");
const RATE = /\b(?:WORDS|CJK|CHARS|CHARACTERS)_PER_MIN(?:UTE)?\b|\bWPM\b/;

/** Production source of every package: no tests, fixtures, comments-only lines or build output. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", "test", "fixtures", "__snapshots__"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|testing)\./.test(entry.name) ? [path] : [];
  });
}

const code = (text: string) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

describe("reading time has one rule", () => {
  it("the words-per-minute constants exist only in @onden/markdown's readingTime.ts", () => {
    const offenders = ["markdown", "site", "backend", "frontend"]
      .flatMap((pkg) => sourceFiles(join(PACKAGES, pkg, "src")))
      .filter((file) => RATE.test(code(readFileSync(file, "utf8"))))
      .map((file) => relative(PACKAGES, file).split(sep).join("/"))
      .filter((file) => file !== OWNER.split(sep).join("/"));
    expect(offenders, "call readingMinutes(markdown) instead of keeping a second rate").toEqual([]);
  });

  it("the guard still sees the owner (a rename would otherwise make it pass for nothing)", () => {
    expect(RATE.test(code(readFileSync(join(PACKAGES, OWNER), "utf8")))).toBe(true);
  });
});
