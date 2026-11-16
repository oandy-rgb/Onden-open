// The SQL a stamped snapshot is read, written and compared with, built from spine/snapshotTables.ts.
// Read by services/stampedSnapshot.ts (export), spine/stampedImport.ts (import) and the digest below, so a column or a rule is
// named once. Every function that queries runs inside the caller's transaction (kysely `db` shares it).

import { sql } from "kysely";
import { inTransaction } from "../db.js";
import { db } from "../dbKysely.js";
import { sha256Hex } from "../utils.js";
import type { Scope, SnapshotSpec } from "./snapshotTables.js";
import { SNAPSHOT_SPECS } from "./snapshotTables.js";

type ScopeFactory = (params: unknown[]) => Scope;

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

/** `jsonb_build_object` of the carried columns of row `t`, each as the value to carry. */
export function valueSql(spec: SnapshotSpec, cols: string[], scope: Scope): string {
  const override = spec.override?.(scope) ?? {};
  return `jsonb_build_object(${cols.map((c) => `${literal(c)}, ${override[c] ?? `t.${quote(c)}`}`).join(", ")})`;
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

/** One head of a unit that is not the one its stamp shows: a write nobody who wrote later had seen, that lost on the stamp order, with its value (migration 205 sync_stamp_heads). */
type WireHead = {
  origin: string; seq: number; contentHash: string; wall: number; counter: number; author: string | null; device: string | null; deleted: boolean;
  saw: Record<string, number>; meta: unknown | null; value: string | null;
};
/** A stamp as it travels: who wrote, when, what the writer had seen of the unit (`saw`) and knew beyond it (`meta`), and the unit's other heads (`heads`, usually none). */
export type WireStamp = {
  label: string; rowKey: string; field: string; origin: string; seq: number; wall: number; counter: number; author: string | null; device: string | null; deleted: boolean;
  saw: Record<string, number>; meta: unknown | null; heads: WireHead[];
};

export type SnapshotItem =
  | { kind: "row"; table: string; values: Record<string, unknown>; stamps: WireStamp[] }
  | { kind: "tombstone"; table: string; stamp: WireStamp }
  | { kind: "refs"; table: string; key: Record<string, unknown>; values: Record<string, unknown> };

export type StampedPage = {
  /** `rows` is done; `history` and `blobs` are in the format so a later stage needs no new page shape, and are refused until then. */
  layer: "rows" | "history" | "blobs";
  page: number;
  /** The source's own sequence number when the read started: later changes have a larger one. */
  cut: number;
  /** The node the snapshot was made on. */
  source: string;
  workspaceId: string;
  items: SnapshotItem[];
};

const STAMP_COLUMNS = `s.table_name AS label, s.row_key AS "rowKey", s.field, s.origin, s.seq::float8 AS seq, s.hlc_wall::float8 AS wall,
  s.hlc_counter AS counter, s.author, s.device::text AS device, s.deleted, s.saw, s.meta,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('origin', h.origin, 'seq', h.seq, 'contentHash', h.content_hash, 'wall', h.hlc_wall, 'counter', h.hlc_counter, 'author', h.author,
                                               'device', h.device::text, 'deleted', h.deleted, 'saw', h.saw, 'meta', h.meta, 'value', h.value) ORDER BY h.origin COLLATE "C", h.seq, h.content_hash)
              FROM sync_stamp_heads h WHERE h.workspace_id = s.workspace_id AND h.table_name = s.table_name AND h.row_key = s.row_key AND h.field = s.field), '[]'::jsonb) AS heads`;

/** The stamps of the given rows: `pairs` are (label, row key). */
export async function readStampsOf(workspaceId: string, pairs: { label: string; rowKey: string }[]): Promise<WireStamp[]> {
  if (pairs.length === 0) return [];
  const r = await snapshotRows<WireStamp>(
    `SELECT ${STAMP_COLUMNS} FROM sync_stamps s JOIN unnest($2::text[], $3::text[]) AS w(label, row_key) ON s.table_name = w.label AND s.row_key = w.row_key
      WHERE s.workspace_id = $1 ORDER BY s.table_name COLLATE "C", s.row_key COLLATE "C", s.field COLLATE "C"`,
    [workspaceId, pairs.map((p) => p.label), pairs.map((p) => p.rowKey)]);
  return r.rows;
}

/** Tombstones whose row is gone (a deleted row's stamp stays): after `after` (label, row key, field), in that order. NOT cut by any
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
      WHERE s.workspace_id = $1 AND s.table_name = $2 AND s.deleted${cursor}
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
 *  are not in it. */
export async function computeSnapshotDigest(workspaceId: string, scopeOf: ScopeFactory): Promise<TableDigest[]> {
  if (!inTransaction()) throw new Error("computeSnapshotDigest must run inside a transaction");
  await snapshotRows(`SELECT set_config('TimeZone', 'UTC', true)`);
  const out: TableDigest[] = [];
  for (const spec of SNAPSHOT_SPECS) {
    const params: unknown[] = [workspaceId];
    const scope = scopeOf(params);
    const cols = await carriedColumns(spec);
    const rows = (await snapshotRows<{ n: number; agg: string }>(
      `SELECT count(*)::int AS n, COALESCE(string_agg(r.h, ',' ORDER BY r.k COLLATE "C"), '') AS agg FROM (
         SELECT concat_ws(chr(31), ${spec.order.join(", ")}) AS k, encode(sha256(convert_to((${valueSql(spec, cols, scope)})::text, 'UTF8')), 'hex') AS h
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
            WHERE s.workspace_id = $1 AND s.table_name = ${label}
              AND (EXISTS (SELECT 1 FROM inscope i WHERE i.k = s.row_key)
                   OR (s.deleted AND NOT EXISTS (SELECT 1 FROM every e WHERE e.k = s.row_key)))) r`, sp)).rows[0]!;
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
