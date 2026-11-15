// Every integration test that writes to Postgres skips unless DATABASE_URL
// names a test database. A gate narrower than "any name ending in _test"
// makes a whole file skip — and the run look green — on a valid test
// database: importImages and importVaultBatches once required letters only,
// so onden_n54_test silently skipped them. This pins every file's gate.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseName, isTestDatabase } from "./helpers/testDatabase.js";

const DIR = dirname(fileURLToPath(import.meta.url));
const SAMPLES = ["onden_test", "onden_review_test", "onden_n54_test", "onden_spaces_test", "x2_test"];
const url = (name: string) => `postgres://onden:pw@127.0.0.1:55432/${name}`;

/** Regex literals used as `<regex>.test(<db url or name>)` on a gate line. */
function gateRegexes(source: string): RegExp[] {
  const out: RegExp[] = [];
  for (const line of source.split("\n")) {
    if (!/\.test\((?:DB|database|dbName|url|process\.env\.DATABASE_URL[^)]*)\)/.test(line)) continue;
    for (const m of line.matchAll(/\/((?:\\.|[^/\\\n])+)\/([a-z]*)\.test\(/g)) out.push(new RegExp(m[1]!, m[2]));
  }
  return out;
}

describe("integration test database gate", () => {
  it("the shared gate accepts any _test database, digits included, and nothing else", () => {
    for (const name of SAMPLES) expect(isTestDatabase(url(name))).toBe(true);
    for (const name of ["onden", "onden_prod", "test", "onden_test_backup"]) expect(isTestDatabase(url(name))).toBe(false);
    // '_test' in the credentials is not the database name.
    expect(isTestDatabase("postgres://a_test:pw@host/onden")).toBe(false);
    // No URL at all is not a test database. (Calling it with no argument reads
    // DATABASE_URL — that is how every integration file uses it — so the
    // "nothing" case is an explicit empty string, not undefined.)
    expect(isTestDatabase("")).toBe(false);
    const saved = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = url("onden_n54_test");
      expect(isTestDatabase()).toBe(true);
      process.env.DATABASE_URL = url("onden");
      expect(isTestDatabase()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
    }
    expect(databaseName(url("onden_n54_test"))).toBe("onden_n54_test");
  });

  const files = readdirSync(DIR).filter((name) => name.endsWith(".integration.test.ts")).sort();
  it.each(files)("%s runs on every test database name", (name) => {
    const source = readFileSync(join(DIR, name), "utf8");
    if (/isTestDatabase\(/.test(source)) return;
    // Files that never reach a real database: db mocked, or kept skipped.
    if (/vi\.mock\(["']\.\.\/db\.js["']/.test(source) || /\bdescribe\.skip\(/.test(source)) return;
    const gates = gateRegexes(source);
    expect(gates.length, "a recognizable test-database gate (prefer helpers/testDatabase isTestDatabase())").toBeGreaterThan(0);
    for (const sample of SAMPLES) {
      const accepted = gates.some((re) => re.test(url(sample)) || re.test(`/${sample}`));
      expect(accepted, `would skip on ${sample}`).toBe(true);
    }
  });
});
