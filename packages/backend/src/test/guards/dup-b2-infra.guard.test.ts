// Batch 2, backend infrastructure (docs/research/dup-patterns-2026-10-30-be.md):
//   R9  periodic work is scheduled by backgroundJobs.ts startPeriodicJob only
//   R13 the environment is read in config.ts only (logger.ts reads per call)
//   R14 logging goes through logger.ts only
// ESLint enforces R13/R14 while editing (eslint.config.js); this test enforces the
// same rules in `vitest`, and keeps the shared exception list exact: a listed
// file must still break its rule (otherwise delete the entry) and every entry
// needs a reason. Exceptions only shrink.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");
const exceptions = JSON.parse(
  readFileSync(join(SRC, "..", "eslint-rules", "dup-b2-infra-exceptions.json"), "utf8"),
) as Record<"process-env" | "console" | "set-interval", Record<string, string>>;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}
const files = sourceFiles(SRC).map((path) => ({ file: relative(SRC, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));

// Comments are blanked so prose that mentions `setInterval(` never counts.
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));

const PROCESS_ENV = /\bprocess(?:\.env\b|\[\s*["']env["']\s*\])/;
const CONSOLE = /\bconsole\.\w+/;
const SET_INTERVAL = /(?<![\w.$])setInterval\s*\(/;

function violators(pattern: RegExp, owners: string[], list = files): string[] {
  return list.filter((f) => !owners.includes(f.file) && pattern.test(stripComments(f.text))).map((f) => f.file);
}

// Exception keys are repo-relative to the package (what ESLint matches on).
const asKey = (file: string) => `src/${file}`;

function expectExactExceptions(rule: keyof typeof exceptions, pattern: RegExp, owners: string[], label: string) {
  const listed = Object.keys(exceptions[rule]).sort();
  expect(violators(pattern, owners).map(asKey), `${label}: use the owner, or list the file (with a reason) in eslint-rules/dup-b2-infra-exceptions.json`)
    .toEqual(listed);
  for (const [file, reason] of Object.entries(exceptions[rule])) {
    expect(reason.trim(), `${file} needs a reason`).not.toBe("");
  }
}

describe("R9 periodic jobs: backgroundJobs.ts startPeriodicJob", () => {
  it("setInterval( appears only in ticker.ts (plus the listed exceptions)", () => {
    expectExactExceptions("set-interval", SET_INTERVAL, ["ticker.ts"], "R9");
  });

  it("catches a hand-rolled interval", () => {
    expect(violators(SET_INTERVAL, [], [{ file: "x.ts", text: "setInterval(() => run(), 1000);" }])).toEqual(["x.ts"]);
    expect(violators(SET_INTERVAL, [], [{ file: "x.ts", text: "// setInterval( in prose\nconst a = 1;" }])).toEqual([]);
  });
});

describe("R13 environment: config.ts", () => {
  it("process.env is read in config.ts and logger.ts only (plus the listed exceptions)", () => {
    expectExactExceptions("process-env", PROCESS_ENV, ["config.ts", "logger.ts"], "R13");
  });

  it("catches direct reads", () => {
    for (const text of ["const p = process.env.PORT;", "const v = process['env'].X;", "f(env = process.env)"]) {
      expect(violators(PROCESS_ENV, [], [{ file: "x.ts", text }]), text).toEqual(["x.ts"]);
    }
  });
});

describe("R14 logging: logger.ts", () => {
  it("console.* is used in logger.ts only (plus the listed exceptions)", () => {
    expectExactExceptions("console", CONSOLE, ["logger.ts"], "R14");
  });

  it("catches console calls", () => {
    expect(violators(CONSOLE, [], [{ file: "x.ts", text: "console.error('x')" }])).toEqual(["x.ts"]);
  });
});
