// Assumption A6 of the own-node transport (spine/carriedTables.ts; proposal own-node-transport-2026-11-22.md §2.11, §4.1): the tables a snapshot carries are the tables
// change bundles carry plus the ones declared derived, and every label a bundle carries is stamped by this database. Both halves have a negative control: a table the
// lists do not account for is named, and a centre whose stamp trigger is missing is refused.
import { describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { assertTablesCarried, tablesNotCarried, unwiredLabels } from "../spine/carriedTables.js";
import { SNAPSHOT_SPECS } from "../spine/snapshotTables.js";
import { CARRIED_LABELS, UNIT_SOURCES } from "../spine/stampedMerge/dbUnits.js";
import { SYNC_CLASSES } from "../spine/syncClasses.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

/** Snapshot tables no bundle carries yet, each with why: A6 does not hold until this is empty, and the centre refuses a join until then. Only shrinks. */
// ratchet:list a6-not-carried-yet
const NOT_CARRIED_YET: Readonly<Record<string, string>> = {
  rss_seen: "its rows hang on an article each node fetches for itself (rss_staging, derived): a mark that arrives before its article is not made, and nothing makes it when the article comes",
};

describe("A6: what a snapshot carries, bundles carry or the table is derived", () => {
  it("every table a snapshot carries is carried by bundles, declared derived, or named here with why (and nothing else)", () => {
    expect(tablesNotCarried()).toEqual(Object.keys(NOT_CARRIED_YET).sort());
    // the derived ones say why, in their class's note
    const derived = SNAPSHOT_SPECS.map((s) => s.table).filter((t) => SYNC_CLASSES[t]?.class === "derived");
    expect(derived).toEqual(["rss_staging"]);
    for (const t of derived) expect(SYNC_CLASSES[t]!.note.length, t).toBeGreaterThan(10);
  });

  it("negative control: a table a snapshot would carry and the lists do not account for is named; one bundles carry or that is derived is not", () => {
    const tables = [...SNAPSHOT_SPECS.map((s) => s.table), "a_new_table"];
    const carried = UNIT_SOURCES.map((s) => s.table);
    expect(tablesNotCarried(tables, carried)).toEqual(["a_new_table", ...Object.keys(NOT_CARRIED_YET)].sort());
    expect(tablesNotCarried(tables, [...carried, "a_new_table", ...Object.keys(NOT_CARRIED_YET)])).toEqual([]);
    expect(tablesNotCarried(tables, carried, { ...SYNC_CLASSES, a_new_table: { class: "derived", note: "worked out on each node" } })).toEqual(Object.keys(NOT_CARRIED_YET).sort());
  });

  describe.skipIf(!isTestDb)("in this database", () => {
    it("every label a bundle carries has its stamp trigger here", async () => {
      expect(await unwiredLabels()).toEqual([]);
    });

    it("negative control: a centre whose stamp trigger of a carried table is gone names that label and refuses (peer_assumption_tables)", async () => {
      const seen = await withTransaction(async () => {
        await q(`DROP TRIGGER actor_prefs_sync_stamp_insert ON actor_prefs`);
        const labels = await unwiredLabels();
        const refused = await assertTablesCarried().then(() => null, (e: { code?: string; message?: string }) => ({ code: e.code, message: String(e.message) }));
        throw Object.assign(new Error("roll back"), { seen: { labels, refused } });
      }).catch((e: { seen?: unknown }) => e.seen);
      expect(seen).toEqual({ labels: ["actor_prefs"], refused: { code: "peer_assumption_tables", message: expect.stringContaining("actor_prefs (no stamp trigger here)") } });
      // rolled back: the trigger is there again
      expect(await unwiredLabels()).toEqual([]);
      expect(CARRIED_LABELS).toContain("actor_prefs");
    });

    it("today A6 does not hold yet: the centre refuses a join, naming the tables still to carry", async () => {
      const refused = await assertTablesCarried().then(() => null, (e: { code?: string; message?: string }) => ({ code: e.code, message: String(e.message) }));
      if (Object.keys(NOT_CARRIED_YET).length === 0) expect(refused).toBeNull();
      else {
        expect(refused?.code).toBe("peer_assumption_tables");
        for (const t of Object.keys(NOT_CARRIED_YET)) expect(refused?.message).toContain(t);
      }
    });
  });
});
