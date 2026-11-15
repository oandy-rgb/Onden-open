// System actor literal guard (R24): the built-in System actor is marked by
// actors.external_id = SYSTEM_EXTERNAL_ID (spine/systemActor.ts). Source
// code compares against that constant, not a hand-written 'system' literal,
// so the marker has one definition.
//
// Source scan, like bodyWriteGuard.test.ts: comments are skipped (they may
// name the value), test files are out of scope.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { SYSTEM_EXTERNAL_ID, SYSTEM_EXTERNAL_ID_SQL } from "../spine/systemActor.js";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

// external_id compared (=, <>, !=, IS [NOT] DISTINCT FROM) with a quoted literal.
const LITERAL_COMPARE = /\bexternal_id\s*(?:=|<>|!=|IS\s+(?:NOT\s+)?DISTINCT\s+FROM)\s*['"]system['"]/i;

describe("System actor literal guard (R24)", () => {
  it("the SQL form is the quoted constant", () => {
    expect(SYSTEM_EXTERNAL_ID).toBe("system");
    expect(SYSTEM_EXTERNAL_ID_SQL).toBe("'system'");
  });

  it("no source file compares external_id against a 'system' literal", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const code = line.trimStart();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
        if (LITERAL_COMPARE.test(line)) offenders.push(`${relative(srcDir, file).split(sep).join("/")}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
