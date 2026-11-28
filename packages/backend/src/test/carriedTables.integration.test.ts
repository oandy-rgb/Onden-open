// Assumption A6 of the own-node transport (proposal own-node-transport-2026-11-22.md §2.11, §4.1): every table a snapshot carries can be reached by a change bundle too,
// or is declared derived; a table a joiner takes from a snapshot and no bundle carries afterwards differs on two nodes in silence from the first write after the join
// (§4.2 item 15). The check lives here, beside its test, until the transport has a caller for it: the centre asks it before it lets a node join and before every
// exchange (the routes are batch 8 and 9; spine/stampedMerge/README.md 接上傳輸前必須完成), and refuses with `peer_assumption_tables` when it does not hold. That batch
// moves these three functions into the product code with their first caller. Two halves, both needed:
//   - in code: each table of spine/snapshotTables.json is a table of stampedMerge/dbUnits.ts UNIT_SOURCES, or its class in spine/syncClasses.json is `derived` (every node
//     works it out itself; the class's note says why). `tablesNotCarried`.
//   - in this database: each label a bundle carries has its stamp trigger installed. A centre whose migration did not run, or whose trigger was dropped, writes
//     rows no stamp names, so no bundle carries them (`unwiredLabels`).
// Both halves have a negative control: a table the lists do not account for is named, and a centre whose stamp trigger is missing is refused.
import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { q, withTransaction } from "../db.js";
import { db } from "../dbKysely.js";
import { bundleRefused } from "../spine/bundleRefusal.js";
import { SNAPSHOT_SPECS } from "../spine/snapshotTables.js";
import { CARRIED_LABELS, UNIT_SOURCES } from "../spine/stampedMerge/dbUnits.js";
import { SYNC_CLASSES } from "../spine/syncClasses.js";
import classes from "../spine/syncClasses.json" with { type: "json" };

type ClassOf = Readonly<Record<string, { class: string; note: string; snapshot?: string }>>;

/** The tables a snapshot carries, as the classification says (`snapshot` is a mode other than `no`; the list spine/snapshotTables.json describes, which
 *  syncClasses.integration.test.ts keeps equal to it). */
const SNAPSHOT_TABLES = Object.entries(classes as ClassOf).filter(([, e]) => e.snapshot && e.snapshot !== "no").map(([t]) => t);

/** The tables a snapshot carries that no change bundle carries and that are not declared derived, given the lists (the arguments are for the negative control). */
function tablesNotCarried(snapshotTables: readonly string[] = SNAPSHOT_TABLES, carried: readonly string[] = UNIT_SOURCES.map((s) => s.table),
  classOf: ClassOf = classes as ClassOf): string[] {
  return snapshotTables.filter((t) => !carried.includes(t) && classOf[t]?.class !== "derived").sort();
}

/** The labels a bundle carries for which this database has no stamp trigger on a row's creation (a row trigger on INSERT, as migration 202's genesis pass reads them:
 *  without it a new row has no stamp and no bundle names it). The JSON labels are made by their own trigger, named by its first argument. */
async function unwiredLabels(labels: readonly string[] = CARRIED_LABELS): Promise<string[]> {
  const made = new Set((await sql<{ label: string }>`
    SELECT DISTINCT split_part(encode(t.tgargs, 'escape'), '\\000', 1) AS label FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND (t.tgtype & 5) = 5 AND p.proname IN ('sync_stamp_trigger', 'sync_stamp_json_trigger')
    UNION SELECT 'node_attributes' FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE NOT t.tgisinternal AND (t.tgtype & 5) = 5 AND p.proname = 'sync_stamp_attribute_trigger'`.execute(db)).rows.map((r) => r.label));
  return labels.filter((l) => !made.has(l)).sort();
}

/** A6: refuse (409 `peer_assumption_tables`) unless every table a snapshot carries is carried by bundles or derived, and every carried label is stamped here. */
async function assertTablesCarried(): Promise<void> {
  const tables = tablesNotCarried();
  const labels = await unwiredLabels();
  if (tables.length || labels.length) {
    throw bundleRefused("peer_assumption_tables", `a snapshot carries what no change bundle does: ${[...tables, ...labels.map((l) => `${l} (no stamp trigger here)`)].join(", ")}`);
  }
}

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

    it("assertTablesCarried refuses today because rss_seen is not carried yet (peer_assumption_tables, naming the tables still to carry)", async () => {
      const refused = await assertTablesCarried().then(() => null, (e: { code?: string; message?: string }) => ({ code: e.code, message: String(e.message) }));
      if (Object.keys(NOT_CARRIED_YET).length === 0) expect(refused).toBeNull();
      else {
        expect(refused?.code).toBe("peer_assumption_tables");
        for (const t of Object.keys(NOT_CARRIED_YET)) expect(refused?.message).toContain(t);
      }
    });
  });
});
