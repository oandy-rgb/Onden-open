// Stamped personal data is written only through the one write entry (docs/architecture/proposals/causal-stamps-2026-11-12.md §3, S4).
// Runtime: db.ts q() refuses, in tests, a write to a coreWriteSql.ts STAMPED_ENTRY_TABLES table outside a transaction that
// spine/mutate.ts stamped (src/test/stampedPersonalWrites.integration.test.ts). This file keeps the two lists honest without a database:
//   - the writes that stay outside the entry, each a visible allowUnstampedWrite() call: the list can only shrink;
//   - the files that contain SQL writing those tables: a new file is a new place to review, it must route through the entry.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STAMPED_ENTRY_TABLES, stampedTableWritten } from "../../coreWriteSql.js";

const src = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sources = (() => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "test" ? [] : walk(join(dir, e.name))) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : []);
  return walk(src).map((path) => ({ rel: relative(src, path).split(sep).join("/"), text: readFileSync(path, "utf8") }));
})();

// Writes that stay outside the entry: the columns are the fetching node's own state, not stamped data, and a background
// pass has no person to author a stamp. Each is `file:number of allowUnstampedWrite() calls`. Shrink only, never add.
// ratchet:list stamped-writes-outside-entry
const UNSTAMPED_WRITES = [
  "modules/external_calendars/store.ts:2",
  "modules/rss/sources.ts:2",
];

// Files whose SQL writes a stamped personal table. Every one runs those statements inside mutatePersonal()/mutate() (the
// runtime guard proves it for the paths the suite reaches). A new file must be added here on purpose.
// ratchet:list stamped-table-writer-files
const WRITER_FILES = [
  "modules/external_calendars/store.ts", "modules/review/seam.ts", "modules/review/settings.ts", "modules/review/state.ts",
  "modules/rss/mutes.ts", "modules/rss/sources.ts", "modules/rss/staging.ts",
  "services/actorPrefs.ts", "services/backupExtras.ts",
];

describe("stamped personal writes", () => {
  it("the writes outside the entry are the listed ones", () => {
    const found = sources.filter((s) => s.rel !== "db.ts")
      .map((s) => [s.rel, (s.text.match(/\ballowUnstampedWrite\(/g) ?? []).length] as const).filter(([, n]) => n > 0)
      .map(([rel, n]) => `${rel}:${n}`).sort();
    expect(found, "a write that skips mutatePersonal()/mutate() must go through the entry; this list only shrinks").toEqual([...UNSTAMPED_WRITES].sort());
  });

  it("only the listed files contain SQL or query-builder writes to a stamped personal table", () => {
    const tables = STAMPED_ENTRY_TABLES.join("|");
    const builder = new RegExp(String.raw`\.(?:insertInto|updateTable|deleteFrom)\(\s*"(?:${tables})"`);
    const found = sources.filter((s) => s.rel !== "coreWriteSql.ts" && s.rel !== "db.ts")
      .filter((s) => [...s.text.matchAll(/`([^`]*)`|"((?:[^"\\\n]|\\.)*)"/g)].some((m) => stampedTableWritten(m[1] ?? m[2] ?? "") !== null) || builder.test(s.text))
      .map((s) => s.rel).sort();
    expect(found, "a new file writes a stamped personal table: route it through mutatePersonal() and list it with the others").toEqual([...WRITER_FILES].sort());
  });
});
