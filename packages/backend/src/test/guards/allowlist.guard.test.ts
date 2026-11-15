// Guard: allowlists, not blocklists, for the backend. Each rule names who MAY do a thing (allowlist/owners.ts);
// every other file is a violation. Today's violations are counted per file in scripts/allowlist-baseline.json
// and may only shrink: a higher count or a new file fails with "this file may not use X, use <owner>"; a lower
// count passes and prints that the baseline can be lowered (npm run allowlist:baseline).
// Detectors are in allowlist/detect.ts, the per-file rule table in allowlist/fileRules.ts (shared with
// scripts/checkEditedFile.mjs); allowlistRules.guard.test.ts feeds the detectors samples.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRule } from "../../../../../scripts/allowlistLib.mjs";
import { backendViolations, RULE_META } from "./allowlist/fileRules.js";

const SRC = join(import.meta.dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

const countsByRule = new Map<string, Record<string, number>>(Object.keys(RULE_META).map((rule) => [rule, {}]));
for (const path of sourceFiles(SRC)) {
  const rel = relative(SRC, path).split("\\").join("/");
  for (const { rule } of backendViolations(rel, readFileSync(path, "utf8"))) {
    const counts = countsByRule.get(rule)!;
    counts[rel] = (counts[rel] ?? 0) + 1;
  }
}

describe("backend allowlists", () => {
  for (const [rule, meta] of Object.entries(RULE_META)) {
    it(rule, () => {
      const result = checkRule(rule, countsByRule.get(rule)!, meta);
      for (const note of result.notes) console.info(note);
      expect(result.errors.join("\n")).toBe("");
    });
  }
});
