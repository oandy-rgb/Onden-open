// Ratchet: who touches the core graph tables. Counts production files that write each core table and files that
// read it through SQL text, plus files importing the raw event() from db.ts. Numbers may only go down; a PR that
// lowers one should lower the baseline too, but not doing so does not fail (it would make parallel PRs conflict).
// Raising a number is refused by `npm run ratchet:check` (the JSON file is a ratchet baseline) unless a commit carries ratchet-override.
// Plan and the owner modules these numbers are meant to shrink toward:
// docs/architecture/proposals/node-store-ownership-2026-11-14.md
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { code, productionFiles, rel, scan, SRC, TABLES } from "./nodeStoreOwnershipScan.js";

const BASELINE_FILE = join(dirname(fileURLToPath(import.meta.url)), "nodeStoreOwnership-baseline.json");
const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Record<string, number>;
const current = scan();

const measured: Record<string, number> = { rawEventImporters: current.rawEventImporters.length };
for (const table of TABLES) {
  measured[`${table}.writers`] = current.tables[table].writers.length;
  measured[`${table}.readers`] = current.tables[table].readers.length;
}

describe("core table ownership counts only go down", () => {
  it("the baseline names exactly the measured counters", () => {
    expect(Object.keys(baseline).sort()).toEqual(Object.keys(measured).sort());
  });

  for (const [name, count] of Object.entries(measured)) {
    it(`${name} does not grow`, () => {
      const allowed = baseline[name]!;
      expect(
        count,
        `${name}: ${count} files now, baseline ${allowed}. The owner modules in the plan do not exist yet, so until they do:\n` +
          `  1. Put the new SQL in an existing file that already reads/writes this table for the same job (see the plan, section 9), not in a new file.\n` +
          `  2. If a new file really is the right place, raise ${name} by the number of new files in nodeStoreOwnership-baseline.json and put\n` +
          `     "ratchet-override: <why a new direct reader/writer is needed>" on a line in a commit message; npm run ratchet:check then lets it through.\n` +
          `Numbers that go DOWN never fail this test: lower the baseline when you can, so the gain is kept.`,
      ).toBeLessThanOrEqual(allowed);
    });
  }
});

// Two files touch core tables by a TABLE LIST instead of by name, so the scan above cannot count them: spine/snapshotSql.ts reads them
// and spine/stampedImport.ts writes them, for the workspace copy (spine/snapshotTables.json is the list). They are not extra writers
// hidden from the counts but the one copy path; this keeps it that way: no other file reads the list's rows by it, the list carries
// only these core tables, and the two files never name a core table in SQL text (which would count them above and be a second path).
describe("the workspace copy is the one table-list reader and writer of core tables", () => {
  it("carries these core tables, never the event table", async () => {
    const { SNAPSHOT_SPECS } = await import("../../spine/snapshotTables.js");
    const carried = SNAPSHOT_SPECS.map((s) => s.table);
    expect(TABLES.filter((t) => carried.includes(t))).toEqual(["content_nodes", "node_attributes", "node_tags", "block_nodes"]);
    expect(carried).not.toContain("domain_events");
  });
  it("is reached only by the snapshot services and the import", () => {
    const users = productionFiles().map(rel).filter((f) => /\bSNAPSHOT_SPECS\b|\bsnapshotSpec\b/.test(code(readFileSync(join(SRC, f), "utf8")))).sort();
    expect(users).toEqual(["services/stampedSnapshot.ts", "spine/snapshotSql.ts", "spine/snapshotTables.ts", "spine/stampedImport.ts"]);
    for (const f of ["spine/snapshotSql.ts", "spine/stampedImport.ts"]) {
      const c = code(readFileSync(join(SRC, f), "utf8"));
      for (const table of TABLES) expect(c, `${f} names ${table}: it would be counted as a second path`).not.toMatch(new RegExp(`(?:insert\\s+into|update|delete\\s+from|from|join)\\s+"?${table}"?(?![\\w$])`, "i"));
    }
  });
});
