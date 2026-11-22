// The list of what a backup carries (services/backupCoverage.ts) stays complete without a database: a table added to the schema
// has to say whether a backup carries it, and the losses the list admits to can only shrink.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BACKUP_COVERAGE, backupGaps } from "../helpers/backupCoverage.js";
import { SYNC_CLASSES } from "../../spine/syncClasses.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, "../../dbSchema.generated.ts"), "utf8");
/** Every table of the generated schema types (`export interface DB { name: Type; … }`). */
const TABLES = [...schema.slice(schema.indexOf("export interface DB {")).matchAll(/^ {2}(\w+): \w+;/gm)].map((m) => m[1]!);

// What the list admits a backup does not carry: tables with a gap or a `missing` part. A table leaves when it is carried in full;
// none may be added (a new table is carried, or left out on purpose with a reason, not as a gap).
// ratchet:list backup-coverage-gaps
const GAPS = [
  "ai_edit_suggestion_items", "ai_edit_suggestions", "block_nodes", "external_calendars", "imported_media", "ink_chunks", "ink_manifests", "review_states", "rss_mutes", "snapshot_media", "workspaces",
];

describe("backup coverage", () => {
  it("reads the schema's tables", () => {
    expect(TABLES.length).toBeGreaterThan(60);
    expect(TABLES).toContain("note_pointers");
  });

  it("every table is listed, unless it is derived or belongs to one server", () => {
    const unlisted = TABLES.filter((t) => !(t in BACKUP_COVERAGE) && !["derived", "node-local"].includes(SYNC_CLASSES[t]?.class ?? ""));
    expect(unlisted, `these tables say nothing about backups: add them to test/helpers/backupCoverage.ts (carried by what, or left out and why)`).toEqual([]);
  });

  it("lists no table that is gone, and every entry says what it needs to", () => {
    expect(Object.keys(BACKUP_COVERAGE).filter((t) => !TABLES.includes(t))).toEqual([]);
    for (const [table, entry] of Object.entries(BACKUP_COVERAGE)) {
      if (entry.carried === "no") expect(entry.why.length, `${table} needs a reason`).toBeGreaterThan(10);
      else if (entry.missing !== undefined) expect(entry.missing.length, `${table}.missing`).toBeGreaterThan(10);
    }
  });

  it("the losses it admits to are exactly the ratchet list", () => {
    expect(backupGaps()).toEqual([...GAPS].sort());
  });
});
