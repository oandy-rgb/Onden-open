// Assumption A6 of the own-node transport (docs/architecture/proposals/own-node-transport-2026-11-22.md §2.11, §4.1): every table a snapshot carries can be reached by a
// change bundle too, or is declared derived. A table that a joiner takes from a snapshot and no bundle carries afterwards differs on two nodes in silence from the first
// write after the join (or never arrives at all), one table at a time (§4.2 item 15). So the centre asks this before it lets a node join and before every exchange
// (the routes are batch 8 and 9; until then the only callers are tests), and refuses with `peer_assumption_tables` when it does not hold:
//
//   await assertTablesCarried();   // throws a 409 `peer_assumption_tables` naming the tables (only into the log: no screen shows a table name)
//
// Two halves, both needed:
//   - in code: each table of spine/snapshotTables.json is a table of stampedMerge/dbUnits.ts UNIT_SOURCES, or its class in spine/syncClasses.json is `derived` (every node
//     works it out itself; the class's note says why). `tablesNotCarried`.
//   - in this database: each label a bundle carries has its stamp trigger installed. A centre whose migration did not run, or whose trigger was dropped, writes
//     rows no stamp names, so no bundle carries them (`unwiredLabels`).
// The guard test (test/carriedTables.integration.test.ts) asserts both, with a negative control for each.
import { sql } from "kysely";
import { db } from "../dbKysely.js";
import { bundleRefused } from "./bundleRefusal.js";
import { CARRIED_LABELS, UNIT_SOURCES } from "./stampedMerge/index.js";
import classes from "./syncClasses.json" with { type: "json" };

type ClassOf = Readonly<Record<string, { class: string; note: string; snapshot?: string }>>;

/** The tables a snapshot carries, as the classification says (`snapshot` is a mode other than `no`; the list spine/snapshotTables.json describes, which
 *  syncClasses.integration.test.ts keeps equal to it). */
const SNAPSHOT_TABLES = Object.entries(classes as ClassOf).filter(([, e]) => e.snapshot && e.snapshot !== "no").map(([t]) => t);

/** The tables a snapshot carries that no change bundle carries and that are not declared derived, given the lists (the arguments are for the negative control). */
export function tablesNotCarried(snapshotTables: readonly string[] = SNAPSHOT_TABLES, carried: readonly string[] = UNIT_SOURCES.map((s) => s.table),
  classOf: ClassOf = classes as ClassOf): string[] {
  return snapshotTables.filter((t) => !carried.includes(t) && classOf[t]?.class !== "derived").sort();
}

/** The labels a bundle carries for which this database has no stamp trigger on a row's creation (a row trigger on INSERT, as migration 202's genesis pass reads them:
 *  without it a new row has no stamp and no bundle names it). The JSON labels are made by their own trigger, named by its first argument. */
export async function unwiredLabels(labels: readonly string[] = CARRIED_LABELS): Promise<string[]> {
  const made = new Set((await sql<{ label: string }>`
    SELECT DISTINCT split_part(encode(t.tgargs, 'escape'), '\\000', 1) AS label FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND (t.tgtype & 5) = 5 AND p.proname IN ('sync_stamp_trigger', 'sync_stamp_json_trigger')
    UNION SELECT 'node_attributes' FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE NOT t.tgisinternal AND (t.tgtype & 5) = 5 AND p.proname = 'sync_stamp_attribute_trigger'`.execute(db)).rows.map((r) => r.label));
  return labels.filter((l) => !made.has(l)).sort();
}

/** A6: refuse (409 `peer_assumption_tables`) unless every table a snapshot carries is carried by bundles or derived, and every carried label is stamped here. */
export async function assertTablesCarried(): Promise<void> {
  const tables = tablesNotCarried();
  const labels = await unwiredLabels();
  if (tables.length || labels.length) {
    throw bundleRefused("peer_assumption_tables", `a snapshot carries what no change bundle does: ${[...tables, ...labels.map((l) => `${l} (no stamp trigger here)`)].join(", ")}`);
  }
}
