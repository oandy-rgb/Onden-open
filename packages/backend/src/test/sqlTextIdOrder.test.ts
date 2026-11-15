// `SELECT id::text … ORDER BY id` sorts the TEXT output column, not the bigint:
// "99" comes after "102", so the "newest" event is wrong once ids cross a
// power of ten. It made historyActivity flaky (the order of the shuffled tests
// decided whether ids crossed 100) and reversed an AI session's revert order.
// Order by the table's column (`ORDER BY domain_events.id`) instead.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const BAD = /SELECT (?:DISTINCT )?(?:\w+\.)?id::text(?!\s+AS\s+\w)[^`;]*?FROM domain_events\b[^`;]*?ORDER BY id\b/g;

function* tsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* tsFiles(path);
    else if (path.endsWith(".ts")) yield path;
  }
}

describe("SQL over domain_events never orders by a text-cast id", () => {
  it("has no `SELECT id::text … ORDER BY id`", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(ROOT)) {
      if (file.endsWith("sqlTextIdOrder.test.ts")) continue;
      for (const m of readFileSync(file, "utf8").matchAll(BAD)) offenders.push(`${file.slice(ROOT.length + 1)}: ${m[0].slice(0, 80)}…`);
    }
    expect(offenders).toEqual([]);
  });
});
