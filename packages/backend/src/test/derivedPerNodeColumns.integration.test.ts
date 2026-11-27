// Every carried column of a stamped table that holds a time says what it is across nodes (issue #2020, owner's decision 甲): REPLICATED (a unit's column, the
// row key, or an `updated_at` that is a function of the row's counting stamps: stampedMerge/dbUnits.ts UPDATED_AT_OF_STAMPS, less the list below), a CREATION
// value (`created_at`: written by the row's creation and carried with it), WORKED OUT ALIKE on every node from replicated state (ALIKE below, each with where
// its rule is), or DERIVED on each node
// (spine/snapshotTables.ts DERIVED_PER_NODE_COLUMNS: compared as the list says, left out or only whether it is set). A time is what a node's own clock writes
// (`now()`), so a time column nobody classified is how a per-node value slips into what two nodes compare; a new one fails here, read from the database's own
// catalog. The list itself may name only columns that do not replicate: refused when the backend loads (derivedColumnsRefused.test.ts). Each check has a
// negative control. The
// behaviour of the rule on two nodes is in updatedAtFollowsStamps.integration.test.ts (T2, T2 hidden_at).
// SAFETY: reads the catalog of the test database; writes nothing.

import { afterAll, describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { DERIVED_PER_NODE_COLUMNS, SNAPSHOT_SPECS, type DerivedColumns } from "../spine/snapshotTables.js";
import { UNIT_SOURCES, UPDATED_AT_OF_STAMPS, replicatedColumnsOf } from "../spine/stampedMerge/dbUnits.js";

afterAll(async () => { await pool.end(); });

type TimeColumn = { table: string; column: string };
const byStamps = Object.keys(UPDATED_AT_OF_STAMPS).filter((t) => DERIVED_PER_NODE_COLUMNS[t]?.updated_at === undefined);
/** Time columns no unit writes whose value every node works out from replicated state by the same rule, so the checks of "the same" compare them as they are
 *  (this is not a list of what is left out: a wrong entry here only lets this guard miss a column, which every two-node check still compares). */
const ALIKE: Readonly<Record<string, string>> = {
  "spaces.deleted_at": "migration 218 spaces_show_deleted: the written deletion (written_deleted_at, the `deleted` unit) unless a live note is in the space",
};

/** Whether `column` of `table` replicates (a unit's column, the key, the workspace, a JSON column whose keys travel): dbUnits.ts replicatedColumnsOf, the
 *  definition the merge and the list's own check (at load: derivedColumnsRefused.test.ts) read. */
const replicates = (table: string, column: string): boolean => {
  const src = UNIT_SOURCES.find((s) => s.table === table);
  return src !== undefined && replicatedColumnsOf(src).has(column);
};

/** The time columns of `columns` that are neither replicated, nor a creation value, nor declared derived on each node in `derived`, as `table.column`. */
function unclassified(columns: readonly TimeColumn[], derived: DerivedColumns): string[] {
  return columns.filter(({ table, column }) => !replicates(table, column) && !(column === "updated_at" && byStamps.includes(table))
    && column !== "created_at" && ALIKE[`${table}.${column}`] === undefined && derived[table]?.[column] === undefined).map(({ table, column }) => `${table}.${column}`);
}

describe("a time column of a stamped table is replicated, a creation value, or derived on each node, never none of them", () => {
  it("the reading of \"replicates\" this guard uses (a unit's column, a key column, a derived column)", () => {
    expect([replicates("node_attributes", "value"), replicates("block_nodes", "anchor_id"), replicates("block_nodes", "hidden_at"), replicates("outbox", "updated_at")]).toEqual([true, true, false, false]);
  });
  it("today: notes replicate updated_at by their stamps; five tables hold it derived; a paragraph row's hidden_at is compared only for whether it is set", () => {
    expect(byStamps).toEqual(["content_nodes"]);
    expect(Object.keys(DERIVED_PER_NODE_COLUMNS).sort()).toEqual(["actor_module_settings", "block_anchors", "block_nodes", "function_refs", "node_attributes", "node_positions"]);
    expect(DERIVED_PER_NODE_COLUMNS.block_nodes).toEqual({ updated_at: "left out", hidden_at: "set or not" });
  });
  it.skipIf(!isTestDatabase())("every carried time column of a table whose rows travel (the catalog) is classified; a planted one, or one taken off the list, is named (negative controls)", async () => {
    const tables = [...new Set(UNIT_SOURCES.map((s) => s.table))];
    const excluded = new Set(SNAPSHOT_SPECS.flatMap((s) => (s.exclude ?? []).map((c) => `${s.table}.${c}`)));
    const all = (await q<{ t: string; c: string; time: boolean }>(
      `SELECT table_name::text AS t, column_name::text AS c, data_type LIKE 'timestamp%' AS time FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ANY($1::text[]) AND is_generated = 'NEVER' ORDER BY 1, 2`, [tables])).rows;
    const times = all.filter((r) => r.time && !excluded.has(`${r.t}.${r.c}`)).map((r) => ({ table: r.t, column: r.c }));
    expect(times.length, "the catalog was read").toBeGreaterThan(0);
    expect(unclassified(times, DERIVED_PER_NODE_COLUMNS)).toEqual([]);
    // every listed column is a carried column of its table (a misspelt one would compare nothing)
    const carried = new Set(all.filter((r) => !excluded.has(`${r.t}.${r.c}`)).map((r) => `${r.t}.${r.c}`));
    for (const [t, how] of Object.entries(DERIVED_PER_NODE_COLUMNS)) for (const c of Object.keys(how)) expect(carried.has(`${t}.${c}`), `${t}.${c}`).toBe(true);
    for (const c of Object.keys(ALIKE)) expect(carried.has(c), c).toBe(true);
    // a new time column nobody classified is named; so is a derived one taken off the list
    expect(unclassified([...times, { table: "block_nodes", column: "planted_at" }], DERIVED_PER_NODE_COLUMNS)).toEqual(["block_nodes.planted_at"]);
    const { block_nodes: _off, ...without } = DERIVED_PER_NODE_COLUMNS;
    expect(unclassified(times, without)).toEqual(["block_nodes.hidden_at", "block_nodes.updated_at"]);
    expect(unclassified(times, { ...DERIVED_PER_NODE_COLUMNS, block_nodes: { updated_at: "left out" } })).toEqual(["block_nodes.hidden_at"]);
    expect(unclassified(times, { ...DERIVED_PER_NODE_COLUMNS, block_anchors: {} })).toEqual(["block_anchors.moved_at"]);
  });
});
