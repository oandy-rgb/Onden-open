// A hash of every row of every carried table, made WITHOUT the digest function (spine/snapshotSql.ts computeSnapshotDigest): the digest
// only compares what the snapshot selected, so a row the selection forgot (the Site Config note once) is invisible to it. This one
// looks at the whole table: `to_jsonb(row)` minus the columns a snapshot leaves out on purpose, hashed with md5, keyed by the row's own
// key. Two databases are the same when every key of one is in the other with the same hash, except the rows listed as left out on purpose.
// It reads only the table list (which columns are left out), not the selection (`where`).
import { q } from "../../db.js";
import { SNAPSHOT_SPECS } from "../../spine/snapshotTables.js";

export type RowHash = { h: string; /** left out on purpose (see notCarriedOnPurpose) */ allowed: boolean };
export type TableHashes = Record<string, Record<string, RowHash>>;

/** `allowedMissing`: per table, SQL over `t` of the rows a snapshot leaves out on purpose (null on the receiver: nothing is allowed there). */
export async function independentRowHashes(allowedMissing: Record<string, string> | null): Promise<TableHashes> {
  await q(`SELECT set_config('TimeZone', 'UTC', false)`);
  const out: TableHashes = {};
  for (const spec of SNAPSHOT_SPECS) {
    const drop = [...(spec.exclude ?? []), ...(spec.table === "actors" ? ["external_id"] : [])];
    const allowed = allowedMissing?.[spec.table] ?? "false";
    const rows = await q<{ k: string; h: string; a: boolean }>(
      `SELECT concat_ws(chr(31), ${spec.order.join(", ")}) AS k, md5((to_jsonb(t) - $1::text[])::text) AS h, COALESCE((${allowed}), false) AS a FROM "${spec.table}" t`, [drop]);
    out[spec.table] = Object.fromEntries(rows.rows.map((r) => [r.k, { h: r.h, allowed: r.a }]));
  }
  return out;
}

export type HashComparison = { table: string; missing: number; missingNotAllowed: number; extra: number; different: number };

/** Source against receiver, table by table: how many source rows the receiver lacks (and how many of those were not left out on
 *  purpose), how many the receiver has that the source does not, and how many differ. All of the last three must be 0. */
export function compareRowHashes(source: TableHashes, receiver: TableHashes): HashComparison[] {
  return Object.keys(source).map((table) => {
    const a = source[table]!;
    const b = receiver[table] ?? {};
    let missing = 0; let missingNotAllowed = 0; let different = 0;
    for (const [key, row] of Object.entries(a)) {
      const there = b[key];
      if (!there) { missing++; if (!row.allowed) missingNotAllowed++; } else if (there.h !== row.h) different++;
    }
    const extra = Object.keys(b).filter((key) => !(key in a)).length;
    return { table, missing, missingNotAllowed, extra, different };
  });
}
