// The source cache in sources.ts must never serve stale text: a guard self-test
// that writes a file, scans it, rewrites it and scans again has to see both versions.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codeLines, findImports, readSource, sourceFiles } from "./sources";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sources-cache-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("sources cache", () => {
  it("returns the same lines on repeated calls (read once)", () => {
    const [file] = sourceFiles("lib").slice(0, 1);
    expect(codeLines(file)).toBe(codeLines(file));
  });

  it("sees a file rewritten between two reads, with the same size", () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, 'import x from "./one";\n');
    expect(findImports([file], /./)).toHaveLength(1);
    expect(findImports([file], /one/)).toHaveLength(1);
    writeFileSync(file, 'import x from "./two";\n');
    // Same size, so only the mtime tells them apart; two writes this close can share a timestamp.
    utimesSync(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    expect(findImports([file], /one/)).toHaveLength(0);
    expect(findImports([file], /two/)).toHaveLength(1);
    expect(readSource(file)).toContain("two");
  });

  it("sees a rewrite with a different size", () => {
    const file = join(dir, "b.ts");
    writeFileSync(file, "const a = 1;\n");
    expect(codeLines(file)).toEqual(["const a = 1;", ""]);
    writeFileSync(file, "const a = 12345;\n// note\n");
    expect(codeLines(file)).toEqual(["const a = 12345;", "", ""]);
  });

  it("freezes cached lines so one guard cannot change what another sees", () => {
    const file = join(dir, "c.ts");
    writeFileSync(file, "x\n");
    expect(() => (codeLines(file) as string[]).push("y")).toThrow();
  });
});
