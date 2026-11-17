// The database end of the merge core, at the level of ONE unit: read what the database holds of a unit as the core's input, and write
// the core's answer back. Contract and design: ./README.md "Between the core and the database".
//
// A unit here is a field of a row in a table that the stamp triggers watch (UNIT_SOURCES), or the row itself (`*`, existing or gone for good).
// What the database holds of a unit, and where:
//   the heads        what sync_stamps shows (the head with the largest stamp, saw and meta included) and sync_stamp_heads (the others, each with its value);
//   the value        the winner's value is the column of the row; a loser's is in its sync_stamp_heads row;
//   a field with no stamp of its own follows its row's creation: its cell is the creation stamp with an empty saw.
// Every value the core is given is TEXT (the column as text, `sync_logged_value` in migration 194) or null, so that what a database names a
// genesis value by (sha-256 of the text, migration 205) is what unit.ts names it by. A `*` unit holds `{}` (the row is there) or a tombstone: a row's
// creation values are not stored, so two nodes can never disagree about what a creation stamp "said".
//
// Writing back goes through ONE entry, `mergeUnitsIntoWorkspace` (spine/stampedImport.ts, which calls `storeMergedUnits` below): inside the workspace's event
// transaction, the stamp triggers stand aside the way they do for a snapshot import (stamps.ts, reason "merge": the same switch, counted in sync_clock.merge_batches),
// the column and the stamp rows are written as the core decided, and nothing makes a stamp of its own. A person's write to the same unit goes
// through the ordinary path and is stamped by the triggers (migration 205 works its `saw` out from what is stored here).
// Not done here, on purpose: the domain effects of a changed note (search index, links, body anchors), a row that has to be created or removed,
// JSON units (`key:…`), and any decision on who may write; the caller (the changes pack, later) owns those.

import { deferredColumnsOf, snapshotRows, type RowMatch } from "../snapshotSql.js";
import { RETIRED_STAMP_LABELS } from "../snapshotTables.js";
import { type Cell, type Json, type MergeResult, type SkewGate, type Stamp, type Unit, DEFAULT_MAX_SKEW_MS, GENESIS_STAMP_ORIGIN, canonical, genesisName, isGenesis, maximalHeads, mergeUnit } from "./unit.js";
import { type StoreMerge, type UnitAddress, STAR } from "./store.js";

/** One column of a row key, in the order `sync_key` (migration 194) joins them with '/'. Every part but the last is a uuid (36 characters), so a key is split without guessing. */
type KeyPart = { column: string; type: "uuid" | "text" };
/** How a row names its workspace, the same three forms as the stamp trigger's `sync_workspace` argument (migration 199): a column, the note one of its columns names, or the space one names. */
type WorkspaceOf = { column: string } | { viaNode: string } | { viaSpace: string };

/** A stamped table whose rows are units (`*` and the fields of the trigger's watch list), as the stamp trigger of the table files them. */
export type RowSource = {
  /** The stamp table name (`sync_stamps.table_name`). Also the scope of `sync_origins.have` (one per label). */
  label: string;
  table: string;
  /** The columns of the row key (`sync_stamps.row_key`). The key is compared as the column's type, never as text (a cast on the column keeps the index from being used: the apply cost was quadratic). */
  key: readonly KeyPart[];
  workspace: WorkspaceOf;
  /** stamp field → column; `a+b` is a composite (`sync_composite`: the JSON object of those columns). The field `deleted` is the row's deleted state, not the timestamp: `'true'` / `'false'`. */
  fields: Readonly<Record<string, string>>;
  /** SQL over `t`: the rows of the table that are units (the rest is derived and never travels). */
  where?: string;
  /** A bundle makes and removes rows of this table. False for `workspaces`: the row is the workspace itself, made by its install or its snapshot. */
  rows: boolean;
};
/** A JSON column whose keys are units of their own (`key:…` fields, `sync_stamp_json_diff`, migration 199), carried with the row of `of` that holds the column. */
type JsonSource = { label: string; of: string; column: string; shape: "object" | "set"; prefix: string };

const ws = (column = "workspace_id"): WorkspaceOf => ({ column });
const uuidKey = (column = "id"): KeyPart[] => [{ column, type: "uuid" }];
/**
 * The tables whose units this file reads and writes, in the order a bundle writes them (a row's parents first: a space before its members, a note before what hangs on it).
 * A guard test (stampedBundleSources.integration.test.ts) compares each with the arguments of its stamp trigger in the database, so it cannot drift, and fails for a
 * `stamped` table of spine/syncClasses.json that is wired and has no entry here unless its NOT_CARRIED_YET names it with the reason.
 */
export const UNIT_SOURCES: readonly RowSource[] = [
  { label: "workspaces", table: "workspaces", key: uuidKey(), workspace: ws("id"), fields: { time_zone: "time_zone", day_start: "day_start_hour" }, rows: false },
  { label: "spaces", table: "spaces", key: uuidKey(), workspace: ws(), fields: { name: "name", kind: "kind", owner: "owner_actor_id", deleted: "deleted_at" }, rows: true },
  { label: "space_members", table: "space_members", key: [{ column: "space_id", type: "uuid" }, { column: "actor_id", type: "uuid" }], workspace: { viaSpace: "space_id" }, fields: { permission: "permission" }, rows: true },
  { label: "content_nodes", table: "content_nodes", key: uuidKey(), workspace: ws(),
    fields: { title: "title", body: "markdown", parent: "parent_id", sort: "order_key", hidden: "hidden", space: "space_id", deleted: "deleted_at" }, rows: true },
  { label: "node_attributes", table: "node_attributes", key: [{ column: "node_id", type: "uuid" }, { column: "key", type: "text" }], workspace: ws(),
    fields: { value: "value", type: "value_type", inheritable: "is_inheritable" }, where: "t.source IN ('ui', 'explicit', 'dispatcher')", rows: true },
  { label: "node_tags", table: "node_tags", key: [{ column: "node_id", type: "uuid" }, { column: "tag_id", type: "uuid" }], workspace: { viaNode: "node_id" }, fields: {}, rows: true },
  { label: "node_edges", table: "node_edges", key: [{ column: "source_node_id", type: "uuid" }, { column: "target_node_id", type: "uuid" }, { column: "edge_type", type: "text" }], workspace: ws(),
    fields: { status: "status" }, where: "t.origin = 'manual'", rows: true },
  { label: "note_pointers", table: "note_pointers", key: uuidKey(), workspace: ws(), fields: { sort: "order_key", prefix: "display_prefix" }, rows: true },
  { label: "node_positions", table: "node_positions", key: [{ column: "node_id", type: "uuid" }, { column: "surface", type: "text" }], workspace: ws(),
    fields: { position: "x+y", look: "width+height+color+folded", sub_canvas: "sub_canvas_id" }, rows: true },
  { label: "function_refs", table: "function_refs", key: uuidKey(), workspace: ws(),
    fields: { function: "function_id", instance: "instance", holder: "holder_node_id", space: "holder_space_id" }, rows: true },
  { label: "rss_subscriptions", table: "rss_subscriptions", key: uuidKey(), workspace: ws(),
    fields: { title: "title", url: "url", space: "space_id", interval: "fetch_interval_minutes", auto_tag: "auto_tag_id", embed: "embed", dismiss: "auto_dismiss_days", default_tags: "default_tag_ids",
      default_parent: "default_parent_id", fulltext: "always_fulltext", voice: "voice", display: "display_mode" }, rows: true },
  { label: "rss_mutes", table: "rss_mutes", key: uuidKey(), workspace: ws(), fields: { keyword: "keyword", source: "subscription_id", expires: "expires_at" }, rows: true },
  { label: "external_calendars", table: "external_calendars", key: uuidKey(), workspace: ws(), fields: { name: "name", color: "color", enabled: "enabled" }, rows: true },
  { label: "actor_module_settings", table: "actor_module_settings", key: [{ column: "actor_id", type: "text" }, { column: "tag_id", type: "uuid" }], workspace: { viaNode: "tag_id" },
    fields: { settings: "settings" }, rows: true },
];

/** The JSON columns whose keys travel one by one with their row: an object (a unit per key, its value the key's value) or a set (an array of strings: a unit per element,
 *  there or not; the column is kept sorted, by its BEFORE trigger for a local write (migration 209) and here for a merged one, so the same units are the same bytes). */
const JSON_SOURCES: readonly JsonSource[] = [
  { label: "content_nodes.tag_schema", of: "content_nodes", column: "tag_schema", shape: "object", prefix: "key:" },
  { label: "spaces.capabilities", of: "spaces", column: "capabilities", shape: "object", prefix: "switch:" },
  { label: "function_refs.config", of: "function_refs", column: "config", shape: "object", prefix: "key:" },
  { label: "workspaces.modules_off", of: "workspaces", column: "modules_off", shape: "set", prefix: "off:" },
  { label: "workspaces.modules_confirmed", of: "workspaces", column: "modules_confirmed", shape: "set", prefix: "confirmed:" },
];


/** The units of a note whose stamps do NOT count for its `updated_at` (migration 206 sync_touch_updated_at; a stamp with `meta.quiet` does not count either). Today's write path (services/nodeUpdate.ts applyNodeColumns) keeps `updated_at` for a position among siblings only; a creation's value is carried as a column. A test compares this list with the function in the database. */
export const NOT_AN_EDIT_FIELDS: readonly string[] = ["*", "sort"];

export const sourceOf = (label: string): RowSource => {
  const s = UNIT_SOURCES.find((u) => u.label === label);
  if (!s) throw new Error(`units of ${label} are not read from the database here`);
  return s;
};
export const jsonSourceOf = (label: string): JsonSource | undefined => JSON_SOURCES.find((j) => j.label === label);
/** Every label a bundle carries: the scopes of `sync_origins.have`. */
export const CARRIED_LABELS: readonly string[] = [...UNIT_SOURCES.map((s) => s.label), ...JSON_SOURCES.map((j) => j.label)];
// a retired label (made before 2026-11, no longer made: snapshotTables.ts) is never carried, as no snapshot lists it either
for (const l of CARRIED_LABELS) if (RETIRED_STAMP_LABELS.includes(l)) throw new Error(`dbUnits.ts: ${l} is a retired stamp label and cannot be carried`);

/** The parts of a row key, column by column (`sync_key` joins them with '/'; every part but the last is 36 characters). */
function splitRowKey(src: RowSource, row: string): string[] {
  const parts: string[] = [];
  let rest = row;
  for (let i = 0; i < src.key.length - 1; i++) {
    const m = /^([^/]{36})\/([\s\S]*)$/.exec(rest);
    if (!m) throw new Error(`${row} is not a row key of ${src.label}`);
    parts.push(m[1]!); rest = m[2]!;
  }
  parts.push(rest);
  return parts;
}
/** `t.<key> = <param>` for one row, with the parameters pushed onto `params` (typed as the columns are, so the index is used). */
function rowWhere(src: RowSource, alias: string, row: string, params: unknown[]): string {
  return splitRowKey(src, row).map((v, i) => `${alias}.${quote(src.key[i]!.column)} = $${params.push(v)}::${src.key[i]!.type}`).join(" AND ");
}
/** The rows of `src` whose key is among `rows`: one parameter per key column (arrays), joined by position. */
function rowsWhere(src: RowSource, alias: string, rows: readonly string[], params: unknown[]): string {
  const split = rows.map((r) => splitRowKey(src, r));
  const cols = src.key.map((k, i) => `$${params.push(split.map((p) => p[i]!))}::${k.type}[]`);
  return `(${src.key.map((k) => `${alias}.${quote(k.column)}`).join(", ")}) IN (SELECT * FROM unnest(${cols.join(", ")}))`;
}
/** The SQL text of a row's key over `alias`, the same text `sync_key` makes. */
const rowKeySql = (src: RowSource, alias: string): string => src.key.map((k) => `${alias}.${quote(k.column)}::text`).join(" || '/' || ");
/** `alias` belongs to the workspace in parameter `wsParam` (e.g. `$2`). */
function workspaceWhere(src: RowSource, alias: string, wsParam: string): string {
  const w = src.workspace;
  if ("column" in w) return `${alias}.${quote(w.column)} = ${wsParam}::uuid`;
  // the workspace by the database's own rule, the one the stamp trigger files the row under (sync_workspace, migrations 194 / 199): one definition of "whose row is this"
  if ("viaNode" in w) return `sync_workspace(${alias}, 'via:${w.viaNode}') = ${wsParam}::uuid`;
  return `sync_workspace(${alias}, 'space:${w.viaSpace}') = ${wsParam}::uuid`;
}
/** The rows `rows` of `src`, as the carried-row helpers of spine/snapshotSql.ts take them. */
export const rowMatchOf = (src: RowSource, rows: readonly string[]): RowMatch => ({
  match: (alias, params) => rowsWhere(src, alias, rows, params),
  idSql: (alias) => rowKeySql(src, alias),
  workspace: (alias, wsParam) => workspaceWhere(src, alias, wsParam),
});
/** The JSON sources whose column a row of `src` holds. */
export const jsonSourcesOf = (src: RowSource): JsonSource[] => JSON_SOURCES.filter((j) => j.of === src.label);
/** Every label the stamps of a row of `src` are filed under: its own and its JSON columns'. */
export const labelsOf = (src: RowSource): string[] => [src.label, ...jsonSourcesOf(src).map((j) => j.label)];
/** The name a unit of a row is known by in a row's state (dbRows.ts, rows.ts): its field for the row's own label, `<label>:<field>` for a key of a JSON column. */
export const unitName = (src: RowSource, label: string, field: string): string => (label === src.label ? field : `${label}:${field}`);
/** The address of the unit a row state calls `name` (the inverse of `unitName`). */
export function addressOfUnit(src: RowSource, row: string, name: string): UnitAddress {
  for (const j of jsonSourcesOf(src)) if (name.startsWith(`${j.label}:`)) return { table: j.label, row, field: name.slice(j.label.length + 1) };
  return { table: src.label, row, field: name };
}
/** SQL over `t`: the jsonb object of every unit's value as text, by unit name (the row's fields, and each key of its JSON columns as `<label>:<field>`, the jsonb text the json trigger names a value by). */
export function unitTextsSql(src: RowSource, alias = "t"): string {
  const own = Object.keys(src.fields).map((f) => `'${f}', ${fieldTextSql(src, f, alias)}`);
  const parts = [own.length ? `jsonb_build_object(${own.join(", ")})` : `'{}'::jsonb`];
  for (const j of jsonSourcesOf(src)) {
    const col = `${alias}.${quote(j.column)}`;
    parts.push(j.shape === "object"
      ? `COALESCE((SELECT jsonb_object_agg('${j.label}:${j.prefix}' || x.key, x.value::text) FROM jsonb_each(CASE WHEN jsonb_typeof(${col}) = 'object' THEN ${col} ELSE '{}'::jsonb END) x), '{}'::jsonb)`
      // an element's value is the element itself, as the json trigger names it (sync_json_units, migration 199)
      : `COALESCE((SELECT jsonb_object_agg('${j.label}:${j.prefix}' || (x #>> '{}'), x::text) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END) x WHERE jsonb_typeof(x) = 'string'), '{}'::jsonb)`);
  }
  return parts.join(" || ");
}
/** The text of a unit's value as the stamps name it, over row `alias` (sync_logged_value, migration 194). */
const fieldTextSql = (src: RowSource, field: string, alias = "t"): string => `sync_logged_value(${alias}, '${field}', '${src.fields[field]}')`;

export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const STAR_PRESENT: Json = {};

export type StampRow = {
  origin: string; seq: string; hlc_wall: string; hlc_counter: number; author: string | null; device: string | null; deleted: boolean;
  saw: Record<string, number>; meta: Json | null;
};
export type HeadRow = StampRow & { content_hash: string; value: string | null };

export const stampOf = (r: StampRow): Stamp => ({ origin: r.origin, seq: Number(r.seq), wall: Number(r.hlc_wall), counter: r.hlc_counter, author: r.author, device: r.device });
export const cellMetaOf = (r: StampRow): { meta?: Json } => (r.meta === null || r.meta === undefined ? {} : { meta: r.meta });
export const STAMP_COLS = `origin, seq::text, hlc_wall::text, hlc_counter, author, device::text, deleted, saw, meta`;

/** The unit as the database holds it, or undefined when it holds nothing of it (no stamp of its own and no creation stamp it follows). */
export async function readUnit(workspaceId: string, a: UnitAddress): Promise<Unit | undefined> {
  const own = (await snapshotRows<StampRow>(
    `SELECT ${STAMP_COLS} FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, [workspaceId, a.table, a.row, a.field])).rows[0];
  const heads = (await snapshotRows<HeadRow>(
    `SELECT ${STAMP_COLS}, content_hash, value FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4 ORDER BY origin, seq, content_hash`,
    [workspaceId, a.table, a.row, a.field])).rows;
  const cells: Cell[] = [];
  if (a.field === STAR) {
    if (own) cells.push({ stamp: stampOf(own), saw: own.saw, deleted: own.deleted, value: own.deleted ? null : STAR_PRESENT, ...cellMetaOf(own) });
    for (const h of heads) cells.push({ stamp: stampOf(h), saw: h.saw, deleted: h.deleted, value: h.deleted ? null : STAR_PRESENT, ...cellMetaOf(h) });
  } else if (jsonSourceOf(a.table)) {
    // a JSON key always has a stamp of its own (sync_stamp_json_diff stamps every key a row is made with): no creation to follow
    const j = jsonSourceOf(a.table)!, src = sourceOf(j.of);
    const params: unknown[] = [a.field.slice(j.prefix.length), workspaceId];
    const pick = j.shape === "set" ? `(SELECT x::text FROM jsonb_array_elements(t.${quote(j.column)}) x WHERE x #>> '{}' = $1::text LIMIT 1)` : `(t.${quote(j.column)} -> $1::text)::text`;
    const value = (await snapshotRows<{ v: string | null }>(
      `SELECT ${pick} AS v FROM ${quote(src.table)} t WHERE ${rowWhere(src, "t", a.row, params)} AND ${workspaceWhere(src, "t", "$2")}`, params)).rows[0];
    if (own) cells.push({ stamp: stampOf(own), saw: own.saw, deleted: own.deleted, value: own.deleted ? null : (value?.v ?? null), ...cellMetaOf(own) });
  } else {
    const src = sourceOf(a.table);
    const column = src.fields[a.field];
    if (!column) throw new Error(`${a.table} has no unit named ${a.field}`);
    const params: unknown[] = [a.field, column, workspaceId];
    const value = (await snapshotRows<{ v: string | null }>(
      `SELECT sync_logged_value(t, $1, $2) AS v FROM ${quote(src.table)} t WHERE ${rowWhere(src, "t", a.row, params)} AND ${workspaceWhere(src, "t", "$3")}`, params)).rows[0];
    if (value) {
      if (own) cells.push({ stamp: stampOf(own), saw: own.saw, deleted: own.deleted, value: own.deleted ? null : value.v, ...cellMetaOf(own) });
      else {
        const star = (await snapshotRows<StampRow>(`SELECT ${STAMP_COLS} FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = '*'`, [workspaceId, a.table, a.row])).rows[0];
        if (star) cells.push({ stamp: stampOf(star), saw: {}, deleted: false, value: value.v });
      }
      // the field follows EVERY head of its row's creation (two nodes made the same derived id), as store.ts `derived` does
      for (const h of (await snapshotRows<StampRow>(`SELECT ${STAMP_COLS} FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = '*' AND NOT deleted`, [workspaceId, a.table, a.row])).rows) {
        if (!own) cells.push({ stamp: stampOf(h), saw: {}, deleted: false, value: value.v });
      }
    }
    for (const h of heads) cells.push({ stamp: stampOf(h), saw: h.saw, deleted: h.deleted, value: h.deleted ? null : h.value, ...cellMetaOf(h) });
  }
  return cells.length ? maximalHeads(cells) : undefined;
}

/** The hash a genesis head is stored under (sync_stamp_heads.content_hash): the part of unit.ts `genesisName` after `genesis:`, which migration 205's `sync_genesis_hash` makes in SQL. */
const genesisHashOf = (c: Cell): string => genesisName(c).slice(GENESIS_STAMP_ORIGIN.length + 1);


/** The tables with an `order_stamp` column (migration 200): it is the stamp of the order key's winning write. */
const ORDER_STAMPED: readonly string[] = ["content_nodes", "note_pointers"];

const fkCache = new Map<string, Map<string, { table: string; column: string }>>();
/** The columns of `table` that point at one column of another table (a single-column foreign key): a value whose row this node does not hold is written as NULL, which is what
 *  the database itself does on the node that removed it (ON DELETE SET NULL); the unit keeps saying where it pointed. */
async function foreignKeys(table: string): Promise<Map<string, { table: string; column: string }>> {
  const hit = fkCache.get(table);
  if (hit) return hit;
  const r = await snapshotRows<{ col: string; ftable: string; fcol: string }>(
    `SELECT a.attname::text AS col, c.confrelid::regclass::text AS ftable, fa.attname::text AS fcol
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND c.conrelid = $1::regclass AND array_length(c.conkey, 1) = 1`, [quote(table)]);
  const map = new Map(r.rows.map((x) => [x.col, { table: x.ftable.replaceAll('"', ""), column: x.fcol }] as const));
  fkCache.set(table, map);
  return map;
}

const jsonColumnCache = new Map<string, Set<string>>();
/** The columns of `table` declared jsonb: their text is the JSON itself (a field's text is `column::text`), so it is cast, not wrapped as a JSON string. */
async function jsonColumns(table: string): Promise<Set<string>> {
  const hit = jsonColumnCache.get(table);
  if (hit) return hit;
  const r = await snapshotRows<{ col: string }>(`SELECT attname::text AS col FROM pg_attribute WHERE attrelid = $1::regclass AND atttypid = 'jsonb'::regtype AND attnum > 0 AND NOT attisdropped`, [quote(table)]);
  const set = new Set(r.rows.map((x) => x.col));
  jsonColumnCache.set(table, set);
  return set;
}

/** Write a field's winning value (its text, or null) into its column(s). */
async function writeColumn(workspaceId: string, src: RowSource, a: UnitAddress, text: string | null): Promise<void> {
  const column = src.fields[a.field]!;
  const params: unknown[] = [workspaceId];
  const keyed = rowWhere(src, "t", a.row, params);
  const where = (extra: string) => `${keyed} AND ${workspaceWhere(src, "t", "$1")} AND ${extra}`;
  if (a.field === "deleted") {
    // `deleted` is the row's deleted state; the time it was deleted follows the unit that won (dbRows.ts DERIVED_WITH)
    const gone = text === "true";
    await snapshotRows(`UPDATE ${quote(src.table)} t SET ${quote(column)} = ${gone ? `COALESCE(t.${quote(column)}, now())` : "NULL"} WHERE ${where(`(t.${quote(column)} IS NOT NULL) IS DISTINCT FROM ${gone}`)}`, params);
    return;
  }
  if (column.includes("+")) {
    // a composite: the JSON object of its columns (sync_composite)
    const cols = column.split("+");
    const v = `$${params.push(text)}::jsonb`;
    await snapshotRows(
      `UPDATE ${quote(src.table)} t SET ${cols.map((c) => `${quote(c)} = r.${quote(c)}`).join(", ")} FROM jsonb_populate_record(NULL::${quote(src.table)}, ${v}) r
        WHERE ${where(`(${cols.map((c) => `t.${quote(c)}::text`).join(", ")}) IS DISTINCT FROM (${cols.map((c) => `r.${quote(c)}::text`).join(", ")})`)}`, params);
    return;
  }
  const fk = (await foreignKeys(src.table)).get(column);
  const v = `$${params.push(text)}::text`;
  // a value of the column's type, from its text (jsonb_populate_record casts as the column is declared)
  // a jsonb column's text is its JSON: wrapped by jsonb_build_object it would be stored as a JSON string of that text (found in round 2: actor_module_settings.settings)
  const typed = (await jsonColumns(src.table)).has(column) ? `${v}::jsonb`
    : `(jsonb_populate_record(NULL::${quote(src.table)}, jsonb_build_object($${params.push(column)}::text, ${v}))).${quote(column)}`;
  const value = fk ? `(SELECT p.${quote(fk.column)} FROM ${quote(fk.table)} p WHERE p.${quote(fk.column)} = ${typed})` : typed;
  await snapshotRows(`UPDATE ${quote(src.table)} t SET ${quote(column)} = ${value} WHERE ${where(`t.${quote(column)} IS DISTINCT FROM ${value}`)}`, params);
}

/** Write a JSON key's winning write into its column: the value (the JSON text the stamps name it by), or the key removed for a tombstone. A row this node does not hold keeps only the stamps. */
async function writeJsonKey(workspaceId: string, j: JsonSource, a: UnitAddress, win: Cell): Promise<void> {
  const src = sourceOf(j.of);
  const params: unknown[] = [workspaceId, a.field.slice(j.prefix.length)];
  const col = quote(j.column);
  const gone = win.deleted || win.value === null;
  const next = j.shape === "set"
    // the elements other than this one, and this one when it is there: sorted, so the same units are the same bytes on every node
    ? `(SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e COLLATE "C"), '[]'::jsonb) FROM (SELECT DISTINCT e FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(t.${col}) = 'array' THEN t.${col} ELSE '[]'::jsonb END) e
         WHERE e <> $2::text ${gone ? "" : "UNION SELECT $2::text"}) x)`
    : gone ? `COALESCE(t.${col}, '{}'::jsonb) - $2::text` : `COALESCE(t.${col}, '{}'::jsonb) || jsonb_build_object($2::text, $${params.push(win.value)}::jsonb)`;
  const keyed = rowWhere(src, "t", a.row, params);
  await snapshotRows(`UPDATE ${quote(src.table)} t SET ${col} = ${next} WHERE ${keyed} AND ${workspaceWhere(src, "t", "$1")} AND t.${col} IS DISTINCT FROM ${next}`, params);
}

/**
 * Write one merged unit's state: the winner's value into its column and its stamp row, the other heads into sync_stamp_heads. Only inside `storeMergedUnits` and
 * `storeMergedRows` (./dbRows.ts). A field whose winner is only what its row's creation gives it (a cell with the creation's stamp and an empty saw) has no stamp
 * row of its own: it is read from the creation, so two nodes that hold the same writes hold the same rows. A head that lost is stored with its value, a creation value
 * that lost to a write that had not seen the creation included (the creation's values are stored nowhere else); one that says what the winner says is not (it is read again from the creation).
 * `creation`: the (origin:seq) of the creation heads of the row (`*`), when the caller knows them; else they are read here.
 * `fresh`: the row was just made here from the values the bundle carried, and this node held nothing of it (no stamp, no head): its columns already hold the winners
 * (they are the sender's columns, which hold the sender's winners), so only the stamps are written, and the columns a snapshot leaves empty (a parent) are set.
 */
export async function storeUnit(workspaceId: string, a: UnitAddress, unit: Unit, creation?: ReadonlySet<string>, fresh = false): Promise<void> {
  const win = unit[0]!;
  let others = unit.slice(1);
  let winnerFollows = false;
  if (jsonSourceOf(a.table)) {
    if (!fresh) await writeJsonKey(workspaceId, jsonSourceOf(a.table)!, a, win);
  } else if (a.field !== STAR) {
    const keys = creation ?? new Set((await snapshotRows<StampRow>(
      `SELECT origin, seq::text FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = '*'
       UNION ALL SELECT origin, seq::text FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = '*'`, [workspaceId, a.table, a.row])).rows.map((r) => `${r.origin}:${r.seq}`));
    const derived = (c: Cell) => !isGenesis(c) && Object.keys(c.saw).length === 0 && c.meta === undefined && keys.has(`${c.stamp.origin}:${c.stamp.seq}`);
    winnerFollows = derived(win);
    others = others.filter((c) => !(derived(c) && c.deleted === win.deleted && canonical(c.value) === canonical(win.value)));
    if (win.deleted) throw new Error("a field of a row is never a tombstone here");
    const src = sourceOf(a.table);
    if (!fresh || deferredColumnsOf(src.table).includes(src.fields[a.field]!)) await writeColumn(workspaceId, src, a, win.value as string | null);
  }
  // The order key travels with the stamp of the write that set it (migration 200 order_stamp): the tie rule of the sibling order reads it. (A fresh row carried it.)
  if (!fresh && ORDER_STAMPED.includes(a.table) && a.field === "sort" && !isGenesis(win)) {
    const params: unknown[] = [String(win.stamp.wall).padStart(15, "0") + String(win.stamp.counter).padStart(6, "0"), workspaceId];
    const src = sourceOf(a.table);
    await snapshotRows(`UPDATE ${quote(src.table)} t SET order_stamp = $1 WHERE ${rowWhere(src, "t", a.row, params)} AND ${workspaceWhere(src, "t", "$2")}`, params);
  }
  const key = [workspaceId, a.table, a.row, a.field];
  // with a head beside it the winner keeps a stamp row (a head is sent with the stamp row it belongs to), a copy of the creation's stamp with an empty saw
  if (winnerFollows && others.length === 0) {
    if (!fresh) await snapshotRows(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, key);
  } else {
    await snapshotRows(
      `INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12::jsonb, $13::jsonb)
       ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
         origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter, author = EXCLUDED.author,
         device = EXCLUDED.device, deleted = EXCLUDED.deleted, saw = EXCLUDED.saw, meta = EXCLUDED.meta`,
      [...key, isGenesis(win) ? GENESIS_STAMP_ORIGIN : win.stamp.origin, win.stamp.seq, win.stamp.wall, win.stamp.counter, win.stamp.author, win.stamp.device, win.deleted, JSON.stringify(win.saw), win.meta === undefined ? null : JSON.stringify(win.meta)]);
  }
  if (!fresh) await snapshotRows(`DELETE FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, key);
  for (const h of others) {
    await snapshotRows(
      `INSERT INTO sync_stamp_heads (workspace_id, table_name, row_key, field, origin, seq, content_hash, hlc_wall, hlc_counter, author, device, deleted, saw, meta, value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12, $13::jsonb, $14::jsonb, $15)`,
      [...key, h.stamp.origin, h.stamp.seq, isGenesis(h) ? genesisHashOf(h) : "", h.stamp.wall, h.stamp.counter, h.stamp.author, h.stamp.device, h.deleted, JSON.stringify(h.saw),
        h.meta === undefined ? null : JSON.stringify(h.meta), h.deleted || a.field === STAR ? null : (h.value as string | null)]);
  }
}

export type IncomingUnit = { address: UnitAddress; unit: Unit };
export type UnitMergeReport = {
  /** For each unit whose state changed or that now holds a conflict: what the core made of it (`result.unit` is what is stored). */
  events: StoreMerge["events"];
  rejected: StoreMerge["rejected"];
  /** Writes whose clock is ahead of ours: not taken. The caller offers them again later and must not count the sender's progress past the first of them. */
  deferred: StoreMerge["deferred"];
  /** How many units were written to the database. */
  stored: number;
};

/**
 * Merge units received from another node into this database, one unit at a time (`mergeUnit`), and write back the ones that changed.
 * PRECONDITION: the stamp triggers stand aside and the event lock is held: call it through `mergeUnitsIntoWorkspace` (spine/stampedImport.ts,
 * the one entry that makes them stand aside). Writes that are malformed or reuse a (origin, seq) with other content are refused, writes with a
 * clock too far ahead are deferred (the report names them), the rest is taken. A merge never makes a stamp of its own.
 */
export async function storeMergedUnits(workspaceId: string, incoming: readonly IncomingUnit[], gate: SkewGate = { nowWall: Date.now(), maxSkewMs: DEFAULT_MAX_SKEW_MS }): Promise<UnitMergeReport> {
  const report: UnitMergeReport = { events: [], rejected: [], deferred: [], stored: 0 };
  for (const { address, unit } of incoming) {
    const local = await readUnit(workspaceId, address);
    const r: MergeResult = mergeUnit(local, unit, gate);
    if (r.outcome === "rejected") { report.rejected.push({ address, reason: r.reason! }); continue; }
    if (r.deferred.length) report.deferred.push({ address, cells: r.deferred });
    if (r.outcome === "deferred") continue;
    const changed = !local || canonical(local) !== canonical(r.unit);
    if (changed) { await storeUnit(workspaceId, address, r.unit); report.stored++; }
    if (r.outcome !== "same" || r.write || r.losers.length) report.events.push({ address, result: r });
  }
  return report;
}
