// The SQL a stamped snapshot is read, written and compared with, built from spine/snapshotTables.ts.
// Read by services/stampedSnapshot.ts (export), spine/stampedImport.ts (import) and the digest below, so a column or a rule is
// named once. Every function that queries runs inside the caller's transaction (kysely `db` shares it).

import { sql } from "kysely";
import { inTransaction } from "../db.js";
import { db } from "../dbKysely.js";
import { sha256Hex } from "../utils.js";
import type { DerivedColumns, DerivedHow, Scope, SnapshotSpec } from "./snapshotTables.js";
import { DERIVED_PER_NODE_COLUMNS, SNAPSHOT_SPECS, comparedSql, stampMayLeaveSql } from "./snapshotTables.js";

export type ScopeFactory = (params: unknown[]) => Scope;

/** Run SQL text that has `$1…` placeholders (the shape every builder here produces) on the caller's transaction. */
export async function snapshotRows<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  const parts = text.split(/\$(\d+)/);
  const fragments = parts.map((part, i) => (i % 2 === 0 ? sql.raw(part) : sql`${params[Number(part) - 1]}`));
  return { rows: (await sql<T>`${sql.join(fragments, sql.raw(""))}`.execute(db)).rows };
}

const columnCache = new Map<string, string[]>();

/** The columns of `spec.table` a snapshot carries: every stored column, in table order, except `exclude`. */
export async function carriedColumns(spec: SnapshotSpec): Promise<string[]> {
  const hit = columnCache.get(spec.table);
  if (hit) return hit;
  const r = await snapshotRows<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`, [spec.table]);
  if (r.rows.length === 0) throw new Error(`snapshot table ${spec.table} does not exist`);
  const cols = r.rows.map((c) => c.column_name).filter((c) => !(spec.exclude ?? []).includes(c));
  columnCache.set(spec.table, cols);
  return cols;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** `jsonb_build_object` of the carried columns of row `t`, each as the value to carry; with `derived` (a table's entry of DERIVED_PER_NODE_COLUMNS), each as a
 *  check of "two nodes hold the same" compares it (snapshotTables.ts comparedSql: a "left out" column is not in it). */
export function valueSql(spec: SnapshotSpec, cols: string[], scope: Scope, derived: Readonly<Record<string, DerivedHow>> = {}): string {
  const override = spec.override?.(scope) ?? {};
  const pairs = cols.map((c) => [c, comparedSql(derived[c], override[c] ?? `t.${quote(c)}`)] as const).filter((p): p is readonly [string, string] => p[1] !== null);
  return `jsonb_build_object(${pairs.map(([c, v]) => `${literal(c)}, ${v}`).join(", ")})`;
}

const typeCache = new Map<string, string[]>();

/** The way a table is walked, page after page: by its primary key as it is stored (so the primary key's index gives the next rows
 *  without sorting the table again, and a page costs what it holds, not what the table holds), else by the `order` expressions
 *  as text (the few tables without a primary key are small). `cast(i, mark)` writes the `after` value of key part i as a typed parameter. */
async function keyset(spec: SnapshotSpec): Promise<{ exprs: string[]; cast: (i: number, mark: string) => string }> {
  if (spec.pk.length === 0) return { exprs: spec.order.map((e) => `(${e}) COLLATE "C"`), cast: (_i, mark) => `${mark}::text` };
  let types = typeCache.get(spec.table);
  if (!types) {
    const r = await snapshotRows<{ attname: string; type: string }>(
      `SELECT a.attname::text AS attname, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attname = ANY($2::text[])`,
      [quote(spec.table), spec.pk]);
    types = spec.pk.map((c) => r.rows.find((row) => row.attname === c)!.type);
    typeCache.set(spec.table, types);
  }
  return { exprs: spec.pk.map((c) => `t.${quote(c)}`), cast: (i, mark) => `${mark}::${types![i]}` };
}

/** One chunk of rows in key order after `after` (the previous chunk's last key): `v` the values, `k` the key, `sk` the row key of each stamp kind. */
export async function readRowChunk(
  spec: SnapshotSpec, workspaceId: string, scopeOf: ScopeFactory, after: string[] | null, limit: number,
): Promise<{ v: Record<string, unknown>; k: string[]; sk: (string | null)[] }[]> {
  const params: unknown[] = [workspaceId];
  const scope = scopeOf(params);
  const cols = await carriedColumns(spec);
  const stampKeys = (spec.stamps ?? []).map((d) => (d.when ? `CASE WHEN ${d.when} THEN ${d.rowKey} END` : d.rowKey));
  const value = valueSql(spec, cols, scope); // builds its params now: every placeholder is numbered before the limit's
  let where = `(${spec.where(scope)})`;
  const walk = await keyset(spec);
  if (after) where += ` AND (${walk.exprs.join(", ")}) > (${after.map((a, i) => walk.cast(i, `$${params.push(a)}`)).join(", ")})`;
  params.push(limit);
  const r = await snapshotRows<{ v: Record<string, unknown>; k: string[]; sk: (string | null)[] }>(
    `SELECT ${value} AS v, jsonb_build_array(${walk.exprs.join(", ")}) AS k,
            jsonb_build_array(${stampKeys.length ? stampKeys.join(", ") : "NULL"}) AS sk
       FROM ${quote(spec.table)} t WHERE ${where} ORDER BY ${walk.exprs.join(", ")} LIMIT $${params.length}`, params);
  return r.rows;
}

/**
 * How a change bundle names the rows of a table: `match(alias, params)` is the SQL that picks the rows asked for (the key compared as its columns' types, so the index is used),
 * `idSql(alias)` the text of a row's key (what `sync_stamps.row_key` holds), `workspace(alias, wsParam)` that the row belongs to the workspace. spine/stampedMerge/dbUnits.ts builds them.
 */
export type RowMatch = { match(alias: string, params: unknown[]): string; idSql(alias: string): string; workspace(alias: string, wsParam: string): string };

/**
 * The rows of `table` (a table of the snapshot list) that `rows` picks, each as the values a snapshot carries and the text of each unit as the stamps name it (`texts`: SQL over `t`
 * giving a jsonb object, unit name → text, spine/stampedMerge/dbUnits.ts `unitTextsSql`). For a change bundle: the rows the caller's scope carries (`scopeOf`).
 */
export async function readCarriedRows(table: string, workspaceId: string, rows: RowMatch, texts: string, scopeOf: ScopeFactory): Promise<Map<string, { v: Record<string, unknown>; texts: Record<string, string | null> }>> {
  const spec = snapshotSpecOf(table);
  const cols = await carriedColumns(spec);
  const params: unknown[] = [workspaceId];
  const scope = scopeOf(params);
  const value = valueSql(spec, cols, scope); // numbers its parameters now: before the keys'
  const r = await snapshotRows<{ id: string; v: Record<string, unknown>; texts: Record<string, string | null> }>(
    `SELECT ${rows.idSql("t")} AS id, ${value} AS v, ${texts} AS texts
       FROM ${quote(table)} t WHERE (${spec.where(scope)}) AND ${rows.match("t", params)}`, params);
  return new Map(r.rows.map((row) => [row.id, { v: row.v, texts: row.texts }]));
}

/** Which of `rows` of `table` a read under `scope` carries (the snapshot's `where`, without reading the values). */
export async function carriedKeys(table: string, workspaceId: string, rows: RowMatch, scope: ScopeFactory): Promise<Set<string>> {
  const spec = snapshotSpecOf(table);
  const params: unknown[] = [workspaceId];
  const where = spec.where(scope(params));
  return new Set((await snapshotRows<{ id: string }>(`SELECT ${rows.idSql("t")} AS id FROM ${quote(table)} t WHERE (${where}) AND ${rows.match("t", params)}`, params)).rows.map((r) => r.id));
}

/** Write a row a bundle carries that this database does not hold, with the values a snapshot carries, the deferred columns (a parent) empty (the units' write-back sets them once every row is in) and the placeholders of columns a snapshot never carries. A row that is there is left as it is. */
/** Returns how many rows it made: 0 when a unique key of the table already holds the row (ON CONFLICT DO NOTHING; a bundle decides what that means, dbRows.ts). */
export async function insertCarriedRow(table: string, workspaceId: string, values: Record<string, unknown>): Promise<number> {
  const spec = snapshotSpecOf(table);
  const cols = await carriedColumns(spec);
  const deferred = new Set(spec.deferred ?? []);
  const placeholders = Object.entries(spec.placeholders ?? {});
  const ws = cols.includes("workspace_id") ? `WHERE r.workspace_id = $2` : "";
  const r = await snapshotRows(
    `INSERT INTO ${quote(table)} (${[...cols, ...placeholders.map(([c]) => c)].map(quote).join(", ")})
     SELECT ${[...cols.map((c) => (deferred.has(c) ? "NULL" : `r.${quote(c)}`)), ...placeholders.map(([, e]) => e)].join(", ")} FROM jsonb_populate_recordset(NULL::${quote(table)}, $1::jsonb) r
     ${ws} ON CONFLICT DO NOTHING RETURNING 1`, ws ? [JSON.stringify([values]), workspaceId] : [JSON.stringify([values])]);
  return r.rows.length;
}

/**
 * The creation columns of a row that exists here, replaced by the ones another creation of the same row carried (`values`, as a bundle's row item has them): all carried columns except
 * the key, the workspace, the deferred ones and `keep` (the units' columns, which their own merge decides). A row made twice on two nodes (the same id) is one row after a merge, and it
 * must show the creation that won, on every node.
 */
export async function overwriteCarriedColumns(table: string, workspaceId: string, row: RowMatch, values: Record<string, unknown>, keep: readonly string[]): Promise<void> {
  const spec = snapshotSpecOf(table);
  // a column derived on each node and "left out" (DERIVED_PER_NODE_COLUMNS) is this node's own: the carried value only starts a row made here. A "set or not"
  // one is written with the other display columns: whether it is set is the winning creation's, as on the node that made it
  const derived = Object.entries(DERIVED_PER_NODE_COLUMNS[table] ?? {}).filter(([, how]) => how === "left out").map(([c]) => c);
  const skip = new Set(["workspace_id", ...(spec.deferred ?? []), ...derived, ...keep]);
  const cols = (await carriedColumns(spec)).filter((c) => !skip.has(c));
  if (cols.length === 0) return;
  const params: unknown[] = [JSON.stringify(values), workspaceId];
  await snapshotRows(
    `UPDATE ${quote(table)} t SET ${cols.map((c) => `${quote(c)} = r.${quote(c)}`).join(", ")}
       FROM jsonb_populate_record(NULL::${quote(table)}, $1::jsonb) r WHERE ${row.match("t", params)} AND ${row.workspace("t", "$2")}`, params);
}

/** Columns of a row that follow a unit's winner or the latest write: `copy` columns take the carried `values` of the row (the same names as the snapshot's columns); `latest` columns take the later of the two. */
export async function followCarriedColumns(table: string, workspaceId: string, row: RowMatch, values: Record<string, unknown>, copy: readonly string[], latest: readonly string[]): Promise<void> {
  const spec = snapshotSpecOf(table);
  const all = new Set(await carriedColumns(spec));
  const sets = [...copy.filter((c) => all.has(c)).map((c) => `${quote(c)} = r.${quote(c)}`), ...latest.filter((c) => all.has(c)).map((c) => `${quote(c)} = GREATEST(t.${quote(c)}, r.${quote(c)})`)];
  if (sets.length === 0) return;
  const params: unknown[] = [JSON.stringify(values), workspaceId];
  await snapshotRows(
    `UPDATE ${quote(table)} t SET ${sets.join(", ")} FROM jsonb_populate_record(NULL::${quote(table)}, $1::jsonb) r WHERE ${row.match("t", params)} AND ${row.workspace("t", "$2")}`, params);
}

/** The columns of `table` a snapshot leaves empty and sets once every row is in (`deferred`: a parent). A row made from a bundle's values holds NULL there until its unit is written. */
export const deferredColumnsOf = (table: string): readonly string[] => snapshotSpecOf(table).deferred ?? [];

function snapshotSpecOf(table: string): SnapshotSpec {
  const spec = SNAPSHOT_SPECS.find((s) => s.table === table);
  if (!spec) throw new Error(`${table} is not a table of the snapshot list`);
  return spec;
}

/** One head of a unit that is not the one its stamp shows: a write nobody who wrote later had seen, that lost on the stamp order, with its value (migration 205 sync_stamp_heads). */
type WireHead = {
  origin: string; seq: number; contentHash: string; wall: number; counter: number; author: string | null; device: string | null; deleted: boolean;
  saw: Record<string, number>; meta: unknown | null; value: string | null;
  /** This copy of the write does not say its value (stampedMerge/unit.ts `valueless`; then `value` is null). Absent: false. */
  valueless?: boolean;
};
/** A stamp as it travels: who wrote, when, what the writer had seen of the unit (`saw`) and knew beyond it (`meta`), and the unit's other heads (`heads`, usually none). */
export type WireStamp = {
  label: string; rowKey: string; field: string; origin: string; seq: number; wall: number; counter: number; author: string | null; device: string | null; deleted: boolean;
  saw: Record<string, number>; meta: unknown | null; heads: WireHead[];
  /** What the stamp says it wrote, over the row's text (stampedMerge/dbUnits.ts KeptValue): `{ text }` a value no column holds (a row that goes with its note and is
   *  not here; a column a foreign key emptied), `{ none: true }` this copy has no value; null or absent: the row's text (a row item's `texts`), or none for a row not held. */
  kept?: { text: string | null } | { none: true } | null;
};

export type SnapshotItem =
  | { kind: "row"; table: string; values: Record<string, unknown>; stamps: WireStamp[] }
  | { kind: "tombstone"; table: string; stamp: WireStamp }
  | { kind: "refs"; table: string; key: Record<string, unknown>; values: Record<string, unknown> };

export type StampedPage = {
  /** `rows` is done; `history` and `blobs` are in the format so a later stage needs no new page shape, and are refused until then. */
  layer: "rows" | "history" | "blobs";
  /** SYNC_DATA_SHAPE_VERSION of the node that made the page (spine/syncDataShape.ts): another version is refused. */
  dataShape: number;
  page: number;
  /** The source's own sequence number when the read started: later changes have a larger one. */
  cut: number;
  /** The node the snapshot was made on. */
  source: string;
  /** The ids that node had before it was restored from a backup and took a new one (migration 213), each with the highest sequence number of it the
   *  source holds: their stamps are the source's own. `{}` for a node that was never restored. The same on every page of one snapshot. */
  former: Record<string, number>;
  /** The other origins the source holds writes of (every sync_origins row of the source that is not a former id: the snapshot's source, a node it admitted, an origin
   *  one of those brought), per label and origin as far as the source holds them (its sync_origins.have; spine/stampedBundle.ts Have). The joining node holds exactly
   *  that afterwards, and takes their stamps up to those numbers only (spine/stampedImport.ts checkPage). `{}` for a source that holds no other origin. The same on every
   *  page of one snapshot, and on the first line of a snapshot stream (data shape 6). */
  brought: Record<string, Record<string, number>>;
  workspaceId: string;
  items: SnapshotItem[];
};

/**
 * One page of a change bundle (spine/stampedBundle.ts reads it, spine/stampedImport.ts `applyChangeBundle` takes the pages of one bundle back). The items are the
 * snapshot's: a row with ALL its stamps of the scope (saw, meta, the other heads), or the tombstone of a row that is gone. A row also says each unit's value as TEXT
 * (`texts`, what `sync_logged_value` gives), so the receiver never works a value out of the JSON of `values`. Every page of one bundle has the same header.
 */
type BundleRow = { kind: "row"; table: string; values: Record<string, unknown>; stamps: WireStamp[]; texts: Record<string, string | null> };
export type BundleItem = BundleRow | Extract<SnapshotItem, { kind: "tombstone" }>;
type ChangeBundleHeader = {
  layer: "changes";
  dataShape: number;
  workspaceId: string;
  /** Which units the bundle speaks about. `stamped`: every label of spine/stampedMerge/dbUnits.ts CARRIED_LABELS, at one cut (each label has its number in `sync_origins.have`). A per-space bundle would be another scope. */
  scope: "stamped";
  /** The node that made the bundle. */
  sender: string;
  /** The sender's own sequence number when the read started (its stamps in the bundle are at most this). */
  cut: number;
  /** What the receiver said it holds (the `have` of the request), per label and origin (spine/stampedBundle.ts Have): the bundle has every write of the scope above these. */
  base: Record<string, Record<string, number>>;
  /** What the receiver holds of the scope, per label and origin, after taking the bundle: what the sender holds at the cut (`holds`), except that an origin with a write the
   *  bundle withholds (its row is outside the reader's scope) stops below that write, so the receiver's `have` never passes it and a later bundle sends it once
   *  the reader may read it (invariant I5, PR "fix/merge-space-follows-parent"). */
  upTo: Record<string, Record<string, number>>;
  /** What the sender holds of the scope, per label and origin, at the cut: no stamp of the bundle is beyond the number of its label and origin. */
  holds: Record<string, Record<string, number>>;
  /** How many pages the bundle has. */
  pages: number;
};
export type ChangeBundlePage = ChangeBundleHeader & { page: number; items: BundleItem[] };
/** The pages of one bundle, put together (spine/stampedBundle.ts `bundleOf`). */
export type ChangeBundle = ChangeBundleHeader & { items: BundleItem[] };

const STAMP_COLUMNS = `s.table_name AS label, s.row_key AS "rowKey", s.field, s.origin, s.seq::float8 AS seq, s.hlc_wall::float8 AS wall,
  s.hlc_counter AS counter, s.author, s.device::text AS device, s.deleted, s.saw, s.meta, s.kept_value AS kept,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('origin', h.origin, 'seq', h.seq, 'contentHash', h.content_hash, 'wall', h.hlc_wall, 'counter', h.hlc_counter, 'author', h.author,
                                               'device', h.device::text, 'deleted', h.deleted, 'saw', h.saw, 'meta', h.meta, 'value', h.value, 'valueless', h.valueless) ORDER BY h.origin COLLATE "C", h.seq, h.content_hash)
              FROM sync_stamp_heads h WHERE h.workspace_id = s.workspace_id AND h.table_name = s.table_name AND h.row_key = s.row_key AND h.field = s.field), '[]'::jsonb) AS heads`;

/** The stamps of the given rows: `pairs` are (label, row key). */
export async function readStampsOf(workspaceId: string, pairs: { label: string; rowKey: string }[]): Promise<WireStamp[]> {
  if (pairs.length === 0) return [];
  const r = await snapshotRows<WireStamp>(
    `SELECT ${STAMP_COLUMNS} FROM sync_stamps s JOIN unnest($2::text[], $3::text[]) AS w(label, row_key) ON s.table_name = w.label AND s.row_key = w.row_key
      WHERE s.workspace_id = $1 AND ${stampMayLeaveSql()} ORDER BY s.table_name COLLATE "C", s.row_key COLLATE "C", s.field COLLATE "C"`,
    [workspaceId, pairs.map((p) => p.label), pairs.map((p) => p.rowKey)]);
  return r.rows;
}

/** Every stamp of a row that is not in the table: its tombstone (a deleted row's stamp stays), and the live stamps of a row that was never made here because it
 *  hangs on a note this node deleted for good (rule 4.9, stampedMerge/dbRows.ts) or the keys a delete left: the same stamps a change bundle sends as `tombstone`
 *  items (spine/stampedBundle.ts), so a node that joins holds every stamp its source holds (review of the snapshot-source batch, round 1, A1). The digest counts
 *  the same set (computeSnapshotDigest). After `after` (label, row key, field), in that order. NOT cut by any
 *  reader's scope: fine for the owner's whole-workspace copy; before an export for a limited reader the ids of rows the reader cannot
 *  read must not appear here (guards/snapshotLimitedScope.guard.test.ts).
 */
export async function readTombstoneChunk(
  spec: SnapshotSpec, workspaceId: string, label: string, after: string[] | null, limit: number,
): Promise<WireStamp[]> {
  const def = spec.stamps!.find((d) => d.label === label)!;
  const params: unknown[] = [workspaceId, label];
  let cursor = "";
  if (after) cursor = ` AND (s.row_key COLLATE "C", s.field COLLATE "C") > ($${params.push(after[0])}::text, $${params.push(after[1])}::text)`;
  params.push(limit);
  const r = await snapshotRows<WireStamp>(
    `SELECT ${STAMP_COLUMNS} FROM sync_stamps s
      WHERE s.workspace_id = $1 AND s.table_name = $2 AND ${stampMayLeaveSql()}${cursor}
        AND NOT EXISTS (SELECT 1 FROM ${quote(spec.table)} t WHERE ${def.when ? `(${def.when}) AND ` : ""}${def.rowKey} = s.row_key)
      ORDER BY s.row_key COLLATE "C", s.field COLLATE "C" LIMIT $${params.length}`, params);
  return r.rows;
}

/** For each deferred column of a table: the rows that have a value in it, as (key columns, deferred columns). */
export async function readRefsChunk(
  spec: SnapshotSpec, workspaceId: string, scopeOf: ScopeFactory, after: string[] | null, limit: number,
): Promise<{ k: string[]; key: Record<string, unknown>; values: Record<string, unknown> }[]> {
  const params: unknown[] = [workspaceId];
  const scope = scopeOf(params);
  const override = spec.override?.(scope) ?? {};
  const deferred = spec.deferred!;
  const carried = deferred.map((c) => override[c] ?? `t.${quote(c)}`);
  let where = `(${spec.where(scope)}) AND (${carried.map((e) => `(${e}) IS NOT NULL`).join(" OR ")})`;
  const walk = await keyset(spec);
  if (after) where += ` AND (${walk.exprs.join(", ")}) > (${after.map((a, i) => walk.cast(i, `$${params.push(a)}`)).join(", ")})`;
  params.push(limit);
  const r = await snapshotRows<{ k: string[]; key: Record<string, unknown>; values: Record<string, unknown> }>(
    `SELECT jsonb_build_array(${walk.exprs.join(", ")}) AS k,
            jsonb_build_object(${spec.pk.map((c) => `${literal(c)}, t.${quote(c)}`).join(", ")}) AS key,
            jsonb_build_object(${deferred.map((c, i) => `${literal(c)}, ${carried[i]}`).join(", ")}) AS values
       FROM ${quote(spec.table)} t WHERE ${where} ORDER BY ${walk.exprs.join(", ")} LIMIT $${params.length}`, params);
  return r.rows;
}

// ── Digest ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What one table holds, as counts and hashes only (no title, text or id): how many rows and stamps, and one hash of each. */
export type TableDigest = { table: string; rows: number; rowsHash: string; stamps: number; stampsHash: string };

const hashOf = (aggregate: string) => sha256Hex(aggregate);

/** The digest of every carried table of `workspaceId` under `scopeOf`. Run it inside one transaction (a read snapshot on the
 *  source, any transaction on the receiver): the rows and the stamps of a table must be read at one moment, and timestamps are
 *  written as text in UTC here so that two databases with different time zones agree. The columns a snapshot does not carry
 *  are not in it. `derived` compares the columns it names as it says (spine/snapshotTables.ts DerivedHow: left out, or only whether set): a check of "two nodes
 *  hold the same replicated data" after an exchange passes DERIVED_PER_NODE_COLUMNS; a snapshot's own check passes nothing, as a snapshot is an exact copy (and
 *  the source's digest travels in it). */
export async function computeSnapshotDigest(workspaceId: string, scopeOf: ScopeFactory, derived: DerivedColumns = {}): Promise<TableDigest[]> {
  if (!inTransaction()) throw new Error("computeSnapshotDigest must run inside a transaction");
  await snapshotRows(`SELECT set_config('TimeZone', 'UTC', true)`);
  const out: TableDigest[] = [];
  for (const spec of SNAPSHOT_SPECS) {
    const params: unknown[] = [workspaceId];
    const scope = scopeOf(params);
    const cols = await carriedColumns(spec);
    const rows = (await snapshotRows<{ n: number; agg: string }>(
      `SELECT count(*)::int AS n, COALESCE(string_agg(r.h, ',' ORDER BY r.k COLLATE "C"), '') AS agg FROM (
         SELECT concat_ws(chr(31), ${spec.order.join(", ")}) AS k, encode(sha256(convert_to((${valueSql(spec, cols, scope, derived[spec.table])})::text, 'UTF8')), 'hex') AS h
           FROM ${quote(spec.table)} t WHERE ${spec.where(scope)}) r`, params)).rows[0]!;
    let stamps = 0;
    let stampAgg = "";
    for (const def of spec.stamps ?? []) {
      const sp: unknown[] = [workspaceId];
      const sscope = scopeOf(sp);
      const label = `$${sp.push(def.label)}`;
      const when = def.when ? `(${def.when})` : "true";
      // The row keys of this kind are worked out once (a hash to look each stamp up in), not once per stamp.
      const r = (await snapshotRows<{ n: number; agg: string }>(
        `WITH inscope AS MATERIALIZED (SELECT ${def.rowKey} AS k FROM ${quote(spec.table)} t WHERE (${spec.where(sscope)}) AND ${when}),
              every AS MATERIALIZED (SELECT ${def.rowKey} AS k FROM ${quote(spec.table)} t WHERE ${when})
         SELECT count(*)::int AS n, COALESCE(string_agg(r.h, ',' ORDER BY r.k COLLATE "C"), '') AS agg FROM (
           SELECT concat_ws(chr(31), s.table_name, s.row_key, s.field) AS k,
                  encode(sha256(convert_to(concat_ws(chr(31), s.table_name, s.row_key, s.field, s.origin, s.seq, s.hlc_wall, s.hlc_counter,
                    COALESCE(s.author, '~'), COALESCE(s.device::text, '~'), s.deleted, s.saw::text, COALESCE(s.meta::text, '~'),
                    COALESCE((SELECT string_agg(concat_ws(chr(30), h.origin, h.seq, h.content_hash, h.hlc_wall, h.hlc_counter, COALESCE(h.author, '~'), COALESCE(h.device::text, '~'), h.deleted,
                                                      h.saw::text, COALESCE(h.meta::text, '~'), COALESCE(h.value, '~')), chr(29) ORDER BY h.origin COLLATE "C", h.seq, h.content_hash)
                                FROM sync_stamp_heads h WHERE h.workspace_id = s.workspace_id AND h.table_name = s.table_name AND h.row_key = s.row_key AND h.field = s.field), '~')), 'UTF8')), 'hex') AS h
             FROM sync_stamps s
            WHERE s.workspace_id = $1 AND s.table_name = ${label} AND ${stampMayLeaveSql()}
              AND (EXISTS (SELECT 1 FROM inscope i WHERE i.k = s.row_key)
                   OR NOT EXISTS (SELECT 1 FROM every e WHERE e.k = s.row_key))) r`, sp)).rows[0]!;
      stamps += r.n;
      stampAgg += `${def.label}=${r.agg};`;
    }
    out.push({ table: spec.table, rows: rows.n, rowsHash: hashOf(rows.agg), stamps, stampsHash: hashOf(stampAgg) });
  }
  return out;
}

export type DigestDifference = { table: string; what: "rows" | "stamps"; sourceCount: number; receiverCount: number; countDifference: number; sameCount: boolean };

/** Where two digests differ: which table, whether its rows or its stamps, and by how many. Empty = the two databases hold the same. */
export function compareDigests(source: TableDigest[], receiver: TableDigest[]): DigestDifference[] {
  const theirs = new Map(receiver.map((d) => [d.table, d]));
  const out: DigestDifference[] = [];
  for (const a of source) {
    const b = theirs.get(a.table);
    for (const what of ["rows", "stamps"] as const) {
      const sourceCount = a[what];
      const receiverCount = b ? b[what] : 0;
      const same = b && a[what === "rows" ? "rowsHash" : "stampsHash"] === b[what === "rows" ? "rowsHash" : "stampsHash"];
      if (!same) out.push({ table: a.table, what, sourceCount, receiverCount, countDifference: receiverCount - sourceCount, sameCount: sourceCount === receiverCount });
    }
  }
  for (const b of receiver) if (!source.some((a) => a.table === b.table)) out.push({ table: b.table, what: "rows", sourceCount: 0, receiverCount: b.rows, countDifference: b.rows, sameCount: false });
  return out;
}
