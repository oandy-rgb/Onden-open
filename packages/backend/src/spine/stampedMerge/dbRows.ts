// The database end of the merge core at the level of a ROW, for every table a change bundle carries (UNIT_SOURCES): what a bundle says about a row (its creation or permanent
// delete, the units it wrote on its own, what its other fields follow, the keys of its JSON columns) merged with what this database holds, written back, with the row made or removed
// when that is what the merge decides. The pure part is ./rows.ts; the unit-level write-back it shares with `storeMergedUnits` is `storeUnit` in ./dbUnits.ts. Contract: ./README.md
// "Changes of other nodes".
//
// Only inside `applyChangeBundle` (spine/stampedImport.ts): the stamp triggers stand aside, the event lock is held, the sender and the shape were checked. What this does
// that the unit-level write-back does not:
//   - a row that does not exist here is made from the values the bundle carries (the tables in the order of UNIT_SOURCES, a note's parent last: every row of the bundle is in first),
//     and a permanent delete removes the row and its units' stamps, the way the delete trigger does. A row that hangs on a row this node does not hold (its note was deleted for good)
//     is not made: its stamps are kept, and rule 4.9's view names it (`hanging`);
//   - a key of a JSON column (`key:…`) is one unit: written into the column one key at a time, and kept as stamps when the row is gone (the delete trigger leaves the keys' tombstones);
//   - what arrives from another device for a note is logged in structure_log the way a local move or delete is, with the stamp of the write (origin, sequence number, author and
//     device kept): this device's history can show it. The log itself is never read into a bundle (stampedBundle.guard.test.ts). The other tables' log lines are not written (PR);
//   - writes to a row that is gone are not stored (there is nothing to hold them): they are returned in `lateEdits`, for the caller to give back to their authors (rules/trash.ts).
// What it does not do (named in the PR and pinned in stampedBundle.integration.test.ts): what is derived from a row's text (links, anchors, search index, events: batch 2b-2b).

import { withSavepoint } from "../../db.js";
import { sha256Hex } from "../../utils.js";
import { isUuid } from "@onden/markdown";
import { bundleRefused } from "../bundleRefusal.js";
import { liveNodeSql } from "../nodeSql.js";
import { followCarriedColumns, insertCarriedRow, overwriteCarriedColumns, snapshotRows, type BundleItem, type WireStamp } from "../snapshotSql.js";
import { type Deletion, type FieldWrite, type Hanging, type HangingRow, type Notice, type RecoveryCopy, type TrashFix, type TreeNote, noticesForEditedDeletes, recoverLateEdits, rowsOnDeletedNotes, trashOrphanedChildren } from "./rules/trash.js";
import { type RowState, mergeRow } from "./rows.js";
import { type MergedRef, mergeDuplicateRefs } from "./rules/functionRefs.js";
import { type Cell, type Json, type Rejection, type Stamp, type Unit, GENESIS_STAMP_ORIGIN, canonical, compareStamps, stampKey } from "./unit.js";
import {
  NOT_AN_EDIT_FIELDS, STAMP_COLS, STAR_PRESENT, UNIT_SOURCES, addressOfUnit, cellMetaOf, jsonSourceOf, jsonSourcesOf, labelsOf, quote, rowMatchOf, sourceOf, stampOf, storeUnit, unitName, unitTextsSql,
  clearMissingRefs, clearedOf, headValue, stampValue, type HeadRow, type KeptValue, type RowSource, type StampRow,
} from "./dbUnits.js";
import { STAR, type StoreEvent } from "./store.js";

const NOTES = "content_nodes";
/** The space a note without one counts as in the unique slug index (migration 099 content_nodes_space_slug_uq). */
const NO_SPACE = "00000000-0000-0000-0000-000000000000";
/** Columns the write path sets from a unit (a note's slug from its title) follow that unit's winner. `updated_at` of a note is a function of the counting stamps (migration 206), or the carried value of a creation. */
const DERIVED_WITH: Readonly<Record<string, Readonly<Record<string, string[]>>>> = { content_nodes: { title: ["slug"], deleted: ["deleted_at"] }, spaces: { deleted: ["deleted_at"] } };
/** How many rows a bundle makes in one table before the table's statistics are brought up to date (`ANALYZE`, storeTable). */
const ANALYZE_AFTER_ROWS = 100;
const STRUCTURE_FIELDS = ["parent", "space", "deleted"]; // the fields the stamp trigger of content_nodes logs (migration 190)

export type RowsReport = {
  events: StoreEvent[];
  rejected: { row: string; reason: Rejection; unit?: string; table?: string }[];
  /** Writes made to a row that no longer exists, for the people who had not seen the delete (the rows stay gone). */
  lateEdits: RecoveryCopy[];
  /** Notes (of this bundle) made under a parent that was deleted for good before its deleter saw them (4.9), and whom to tell. REPORTED, not written: see `orphansOf`. */
  orphaned: TrashFix[];
  /** Rows of the other tables (of this bundle) that hang on a note deleted for good by someone who had not seen them (4.9 for attributes, tags, pointers, positions, references): not made, REPORTED. */
  hanging: Hanging[];
  /** The same function reference made on two nodes under two ids: which one the table keeps (the earlier), and its config merged key by key, as a view (rules/functionRefs.ts). */
  duplicateRefs: MergedRef[];
  /** Two rows with one natural key (a unique index besides the row key, `RowSource.naturalKeys`), made under two ids on two nodes: the one made first is in the table on every node,
   *  the other is not (its stamps stay). What hangs on the one left out (a paragraph row's tags, its review card, its task link) goes with it: REPORTED, not written. */
  duplicateRows: DuplicateRow[];
  /** Who is to be told: the creators of those notes and rows, and the editors of a trashed note whose edit its deleter had not seen. */
  notices: Notice[];
  created: number;
  removed: number;
  /** How many units were written. */
  stored: number;
  structureLines: number;
};

type DuplicateRow = { table: string; key: string; kept: string; lost: string };
type Incoming = { row: string; values: Record<string, unknown> | undefined; state: RowState };

/** What a copy of a write says it wrote: a value, or nothing (`NO_VALUE`: the sender kept the stamp without its value, unit.ts `valueless`). */
const NO_VALUE = Symbol("no value");
const wireCell = (s: Pick<WireStamp, "origin" | "seq" | "wall" | "counter" | "author" | "device" | "deleted" | "saw" | "meta">, value: Json | null | typeof NO_VALUE): Cell => ({
  stamp: { origin: s.origin, seq: s.seq, wall: s.wall, counter: s.counter, author: s.author, device: s.device },
  saw: s.saw ?? {}, deleted: s.deleted, ...(s.deleted ? { value: null } : value === NO_VALUE ? { value: null, valueless: true as const } : { value }),
  ...(s.meta === null || s.meta === undefined ? {} : { meta: s.meta as Json }),
});

/** The row source an item of a bundle belongs to (a JSON key's tombstone travels on its own: it belongs to the row that holds the column). */
function sourceOfItem(item: BundleItem): RowSource {
  const j = jsonSourceOf(item.table);
  return sourceOf(j ? j.of : item.table);
}

/** The state a bundle says of ONE row (its row item, or the tombstones of a row that is gone): its `*`, its own units with the values the bundle gives as text, and what each field that has no unit of its own shows. */
function incomingOf(src: RowSource, rowKey: string, items: readonly BundleItem[]): Incoming | null {
  const fields = Object.keys(src.fields), labels = labelsOf(src);
  const own = new Map<string, Cell[]>();
  const star: Cell[] = [];
  const rowItem = items.find((i): i is Extract<BundleItem, { kind: "row" }> => i.kind === "row");
  const stamps = items.flatMap((i) => (i.kind === "row" ? i.stamps : [i.stamp]));
  const texts = rowItem?.texts ?? {};
  const hasOwn = new Set<string>();
  for (const s of stamps) {
    if (!labels.includes(s.label) || s.rowKey !== rowKey) continue;
    const name = unitName(src, s.label, s.field);
    if (s.label === src.label && s.field === STAR) {
      star.push(wireCell(s, STAR_PRESENT), ...s.heads.map((h) => wireCell({ ...h, meta: h.meta }, STAR_PRESENT)));
    } else if (s.label !== src.label || fields.includes(s.field)) {
      hasOwn.add(name);
      // the winner's value: what its stamp kept when the sender says so (a mark of no value; a kept value only where one may be kept: a row that goes with its note, a
      // column a foreign key empties; review of PR #1853, round 9, point 2: another table's row the sender does not hold keeps no value), else the row's text, else none
      const kept = s.kept && "none" in s.kept ? NO_VALUE : s.kept && "text" in s.kept && (src.goesWithNote || src.clearedOnDelete?.[s.field]) ? s.kept.text : undefined;
      const said = kept !== undefined ? kept : rowItem ? (texts[name] ?? null) : NO_VALUE;
      own.set(name, [wireCell(s, said), ...s.heads.map((h) => wireCell({ ...h, meta: h.meta }, h.valueless ? NO_VALUE : h.value))]);
    }
  }
  if (star.length === 0) return null;
  const creation = new Map<string, string | null>();
  if (rowItem) for (const f of fields) if (!hasOwn.has(f) && Object.hasOwn(texts, f)) creation.set(f, texts[f] ?? null);
  return { row: rowKey, values: rowItem?.values, state: { star: [...star].sort((a, b) => compareStamps(b.stamp, a.stamp)), own, creation } };
}

type LocalRow = { exists: boolean; state: RowState | undefined };

/** What this database holds of each of `rows` of `src`: the stamps (own and heads, the JSON keys' too), and the text of each unit. */
async function loadLocal(workspaceId: string, src: RowSource, rows: string[]): Promise<Map<string, LocalRow>> {
  const labels = labelsOf(src), fields = Object.keys(src.fields);
  const stamps = (await snapshotRows<StampRow & { label: string; row_key: string; field: string; kept: KeptValue }>(
    `SELECT table_name AS label, row_key, field, ${STAMP_COLS}, kept_value AS kept FROM sync_stamps WHERE workspace_id = $1 AND table_name = ANY($2::text[]) AND row_key = ANY($3::text[])`, [workspaceId, labels, rows])).rows;
  const heads = (await snapshotRows<HeadRow & { label: string; row_key: string; field: string }>(
    `SELECT table_name AS label, row_key, field, ${STAMP_COLS}, content_hash, value, valueless FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = ANY($2::text[]) AND row_key = ANY($3::text[])`, [workspaceId, labels, rows])).rows;
  const match = rowMatchOf(src, rows);
  const params: unknown[] = [workspaceId];
  const texts = new Map((await snapshotRows<{ id: string; texts: Record<string, string | null> }>(
    `SELECT ${match.idSql("t")} AS id, ${unitTextsSql(src)} AS texts FROM ${quote(src.table)} t WHERE ${match.match("t", params)} AND ${match.workspace("t", "$1")}`, params)).rows.map((r) => [r.id, r.texts] as const));
  const out = new Map<string, LocalRow>();
  // grouped once: a filter over every stamp for every row was quadratic in the size of the bundle (10,000 rows took 438 s)
  const stampsOf = new Map<string, typeof stamps>(), headsOf = new Map<string, typeof heads>();
  for (const s of stamps) (stampsOf.get(s.row_key) ?? stampsOf.set(s.row_key, []).get(s.row_key)!).push(s);
  for (const h of heads) (headsOf.get(h.row_key) ?? headsOf.set(h.row_key, []).get(h.row_key)!).push(h);
  const isUnit = (label: string, field: string) => label !== src.label || fields.includes(field);
  for (const row of rows) {
    const t = texts.get(row);
    const star: Cell[] = [], own = new Map<string, Cell[]>(), hasOwn = new Set<string>();
    for (const s of stampsOf.get(row) ?? []) {
      const name = unitName(src, s.label, s.field);
      if (s.label === src.label && s.field === STAR) star.push({ stamp: stampOf(s), saw: s.saw, deleted: s.deleted, value: s.deleted ? null : STAR_PRESENT, ...cellMetaOf(s) });
      else if (isUnit(s.label, s.field)) {
        hasOwn.add(name);
        // the value is the row's column where the row is here, else what the stamp kept, else none (a stamp kept by a cascade that no one told the value)
        const said = s.deleted ? { value: null } : stampValue(s.kept, t ? (t[name] ?? null) : undefined);
        (own.get(name) ?? own.set(name, []).get(name)!).push({ stamp: stampOf(s), saw: s.saw, deleted: s.deleted, ...said, ...cellMetaOf(s) });
      }
    }
    for (const h of headsOf.get(row) ?? []) {
      const name = unitName(src, h.label, h.field);
      const isStar = h.label === src.label && h.field === STAR;
      const cell: Cell = { stamp: stampOf(h), saw: h.saw, deleted: h.deleted, ...(isStar ? { value: h.deleted ? null : STAR_PRESENT } : headValue(h)), ...cellMetaOf(h) };
      if (isStar) star.push(cell);
      else if (isUnit(h.label, h.field)) (own.get(name) ?? own.set(name, []).get(name)!).push(cell);
    }
    const creation = new Map<string, string | null>();
    if (t) for (const f of fields) if (!hasOwn.has(f)) creation.set(f, t[f] ?? null);
    out.set(row, { exists: !!t, state: star.length ? { star: [...star].sort((a, b) => compareStamps(b.stamp, a.stamp)), own, creation } : undefined });
  }
  return out;
}

type StructureLine = { row: string; field: string; from: string | null; to: string | null; stamp: Stamp };
/** Write the structure-log lines of what came from another device, all of a table's in one statement (one per line cost three statements each: thousands for a large bundle). */
async function writeStructureLines(workspaceId: string, lines: readonly StructureLine[]): Promise<void> {
  if (lines.length === 0) return;
  // the log's own guard (migration 206 structure_log_import_skip) lets exactly these inserts through while a merge is written
  await snapshotRows(`SELECT set_config('onden.merge_structure_line', 'on', true)`);
  await snapshotRows(
    `INSERT INTO structure_log (workspace_id, table_name, row_key, field, old_value, new_value, origin, seq, hlc_wall, hlc_counter, author, device)
     SELECT $1::uuid, $2, l.row, l.field, l."from", l."to", l.origin, l.seq, l.wall, l.counter, l.author, l.device
       FROM jsonb_to_recordset($3::jsonb) AS l("row" text, field text, "from" text, "to" text, origin text, seq bigint, wall bigint, counter int, author text, device uuid, n int)
      ORDER BY l.n`,
    [workspaceId, NOTES, JSON.stringify(lines.map((x, n) => ({ row: x.row, field: x.field, from: x.from, to: x.to, origin: x.stamp.origin, seq: x.stamp.seq, wall: x.stamp.wall, counter: x.stamp.counter, author: x.stamp.author, device: x.stamp.device, n })))]);
  await snapshotRows(`SELECT set_config('onden.merge_structure_line', '', true)`);
}

type Merged = { i: Incoming; l: LocalRow; m: Extract<ReturnType<typeof mergeRow>, { exists: boolean }> };

/** What of a row that exists here is taken from the bundle's copy besides the units: the creation columns (the creation that won is another than ours) and the columns that follow a unit that came from the bundle. */
function carriedFrom(src: RowSource, { i, l, m }: Merged): { overwrite: boolean; copy: string[] } {
  if (!m.exists || !l.exists || !i.values) return { overwrite: false, copy: [] };
  const win = m.star[0]!;
  const overwrite = !!l.state?.star && m.starChanged && stampKey(win.stamp) !== stampKey(l.state.star[0]!.stamp) && !!i.state.star?.some((h) => stampKey(h.stamp) === stampKey(win.stamp));
  const incomingWon = (f: string) => { const w = m.fields.get(f)?.[0], theirs = i.state.own.get(f)?.[0]; return !!w && !!theirs && stampKey(w.stamp) === stampKey(theirs.stamp) && stampKey(w.stamp) !== stampKey(m.before.get(f)?.[0]?.stamp ?? { origin: "", seq: -1 }); };
  return { overwrite, copy: Object.entries(DERIVED_WITH[src.label] ?? {}).filter(([f]) => incomingWon(f)).flatMap(([, cols]) => cols) };
}

const textOf = (u: Unit | undefined): string | null => (u ? (u[0]!.value as string | null) : null);
/** The unit's writes as copies without their values (a tombstone stays a tombstone): what a node keeps of a row it does not hold, outside the tables that go with a note. */
const withoutValues = (u: Unit): Unit => u.map((c) => (c.deleted ? c : { ...c, value: null, valueless: true as const }));
const emptyReport = (): RowsReport => ({ events: [], rejected: [], lateEdits: [], orphaned: [], hanging: [], duplicateRefs: [], duplicateRows: [], notices: [], created: 0, removed: 0, stored: 0, structureLines: 0 });

/**
 * Merge the rows of a change bundle into this workspace, table by table in the order of UNIT_SOURCES (a row's parents first), row by row, and write back what changed.
 * PRECONDITION: inside `applyChangeBundle` (stand-aside switch on, event lock held). Throws nothing for a refused row: `rejected` names it and the caller refuses the bundle
 * (nothing of it stays: the transaction is rolled back). Every table's merge is worked out before anything is written, so a refusal in a later table writes nothing either.
 */
export async function storeMergedRows(workspaceId: string, items: readonly BundleItem[]): Promise<RowsReport> {
  const report = emptyReport();
  const byTable = new Map<string, Map<string, BundleItem[]>>();
  for (const item of items) {
    const src = sourceOfItem(item);
    const key = item.kind === "row" ? String(item.stamps.find((s) => s.label === src.label)?.rowKey ?? "") : item.stamp.rowKey;
    const rows = byTable.get(src.label) ?? byTable.set(src.label, new Map()).get(src.label)!;
    (rows.get(key) ?? rows.set(key, []).get(key)!).push(item);
  }
  const plans: { src: RowSource; merged: Merged[] }[] = [];
  for (const src of UNIT_SOURCES) {
    const rows = byTable.get(src.label);
    if (!rows) continue;
    const incoming = [...rows].map(([key, its]) => incomingOf(src, key, its)).filter((i): i is Incoming => i !== null);
    // a key the table cannot hold (not a uuid for a uuid key) fails the read here, before anything is written: refused with a code as a write's would be (round 8, point 4)
    const local = await loadLocal(workspaceId, src, incoming.map((i) => i.row)).catch((e: unknown) => {
      if (MALFORMED_CODES.has((e as { code?: string })?.code ?? "")) throw bundleRefused("bundle_malformed", `a row key of ${src.label} is not one this table holds`, 422);
      throw e;
    });
    const merged: Merged[] = [];
    for (const i of incoming) {
      const l = local.get(i.row)!;
      const m = mergeRow(l.state, i.state, clearedOf(src));
      if ("rejected" in m) { report.rejected.push({ row: i.row, reason: m.rejected, table: src.label, ...(m.unit ? { unit: m.unit } : {}) }); continue; }
      merged.push({ i, l, m });
    }
    plans.push({ src, merged });
  }
  if (!report.rejected.length) report.rejected.push(...await checkReceived(workspaceId, items, plans));
  if (report.rejected.length) return report;
  for (const { src, merged } of plans) {
    // a unit written into an existing row can still clash on a unique key (a task line's task, a paragraph's anchor): the bundle is refused with a code, not a database error
    const r = await storeTable(workspaceId, src, merged).catch((e: unknown) => {
      const code = (e as { code?: string })?.code;
      if (code === "23505") throw bundleRefused("bundle_unique_clash", `a write of ${src.label} clashes with a row this node holds on a unique key (${String((e as { constraint?: string }).constraint ?? "?")})`);
      // a value the database will not hold (a CHECK, a NOT NULL, a text that is not of the column's type, a number out of range, a column it does not have): the bundle is malformed
      if (code && MALFORMED_CODES.has(code)) throw bundleRefused("bundle_malformed", `a row of ${src.label} has a value this database does not hold`, 422);
      throw e;
    });
    for (const k of ["events", "lateEdits", "orphaned", "hanging", "duplicateRefs", "duplicateRows", "notices"] as const) (report[k] as unknown[]).push(...r[k]);
    for (const k of ["created", "removed", "stored", "structureLines"] as const) report[k] += r[k];
  }
  // what a source's rows are written into, after every table is in: for every row the bundle bears on (a note's anchors unit writes its anchor rows, for every note whose
  // body, unit or anchor rows came in), from replicated state only. A value it cannot write refuses the bundle with a code, as a table's write does.
  await expandTouched(workspaceId, plans).catch((e: unknown) => {
    const code = (e as { code?: string })?.code;
    if (code && (MALFORMED_CODES.has(code) || code === "OD215")) throw bundleRefused("bundle_malformed", `a row of the bundle cannot be written into what follows from it (${code})`, 422);
    throw e;
  });
  report.notices.sort((a, b) => (a.note + a.to + a.kind < b.note + b.to + b.kind ? -1 : 1));
  return report;
}

/** The database errors that say a received value is not one the table can hold: check_violation, not_null_violation, invalid_text_representation, numeric_value_out_of_range,
 *  invalid_datetime_format, datatype_mismatch, undefined_column, invalid_parameter_value, string_data_right_truncation, untranslatable_character (a \u0000 in JSON). */
const MALFORMED_CODES: ReadonlySet<string> = new Set(["23514", "23502", "22P02", "22003", "22007", "42804", "42703", "22023", "22001", "22P05"]);

/** Each field's unit of a row as this node holds it: its own stamps and heads, or, for a field that has none, the value it was made with under the row's creation stamp
 *  (a field follows its row's creation until a write of its own: dbUnits.ts readUnit reads it the same way). */
function fieldUnitsOf(src: RowSource, state: RowState | undefined): ReadonlyMap<string, Unit> | undefined {
  if (!state?.star) return undefined;
  const created = state.star.find((c) => !c.deleted);
  const out = new Map<string, Unit>();
  for (const f of Object.keys(src.fields)) {
    const own = state.own.get(f);
    if (own?.length) out.set(f, own);
    else if (created && state.creation.has(f)) out.set(f, [{ ...created, value: state.creation.get(f) ?? null }]);
  }
  return out;
}

/** Every row of a source with `expand` that this bundle bears on (its own rows, and the rows other sources name by `bearsOn`), handed to `expand` once with its units and
 *  its note's stored body. Rows that do not exist after the merge name nothing. */
async function expandTouched(workspaceId: string, plans: readonly { src: RowSource; merged: Merged[] }[]): Promise<void> {
  const touched = new Map<string, Set<string>>();
  const add = (label: string, row: unknown) => { if (typeof row === "string" && isUuid(row)) (touched.get(label) ?? touched.set(label, new Set()).get(label)!).add(row); };
  for (const { src, merged } of plans) {
    if (src.expand) for (const { i } of merged) add(src.label, i.row);
    if (src.bearsOn) for (const { i, m } of merged) if (m.exists) add(src.bearsOn.on, src.bearsOn.field ? m.fields.get(src.bearsOn.field)?.[0]?.value : i.row);
  }
  for (const [label, set] of touched) {
    const src = sourceOf(label);
    if (!src.expand) continue;
    const rows = [...set].sort();
    const local = await loadLocal(workspaceId, src, rows);
    const withUnits = rows.filter((r) => local.get(r)?.exists);
    const bodies = new Map((await snapshotRows<{ id: string; markdown: string | null }>(
      `SELECT id::text, markdown FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, withUnits])).rows.map((r) => [r.id, r.markdown ?? ""] as const));
    await src.expand(workspaceId, withUnits.map((row) => ({ row, units: fieldUnitsOf(src, local.get(row)?.state), body: bodies.get(row) ?? null })));
  }
}

/**
 * The declared checks of the received rows (`RowSource.check`), before anything is written: each row's unit texts and every head's value, and for a row this node does not
 * hold, that its carried values give the texts the bundle says. Positions are bounded by the length of the body they name when the bundle or this node has that body.
 */
async function checkReceived(workspaceId: string, items: readonly BundleItem[], plans: readonly { src: RowSource; merged: Merged[] }[]): Promise<RowsReport["rejected"]> {
  const out: RowsReport["rejected"] = [];
  if (!plans.some((p) => p.src.check && p.merged.length)) return out;
  const lengths = new Map<string, number>();
  const known = (text: unknown) => { if (typeof text === "string") lengths.set(sha256Hex(text), text.length); };
  for (const item of items) {
    if (item.kind !== "row" || item.table !== NOTES) continue;
    known(item.texts.body);
    for (const s of item.stamps) if (s.label === NOTES && s.field === "body") for (const h of s.heads) known(h.value);
  }
  const notes = new Set<string>();
  for (const { src, merged } of plans) {
    if (src.check?.bodiesOf === "row") for (const { i } of merged) if (isUuid(i.row)) notes.add(i.row);
  }
  if (notes.size) {
    for (const r of (await snapshotRows<{ markdown: string | null }>(`SELECT markdown FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, [...notes]])).rows) known(r.markdown ?? "");
  }
  for (const { src, merged } of plans) {
    if (!src.check) continue;
    for (const { i, l } of merged) {
      const texts: Record<string, string | null> = {};
      // EVERY value the bundle gives may end up shown and sent on: each unit's winner (the row's text, or what the stamp of a row the sender does not hold kept) and every
      // other head, each checked in its unit's place (review of PR #1853, round 7, point 2). A copy that says no value (unit.ts `valueless`) is no value: nothing is checked,
      // shown or written from it (round 8).
      const heads: { name: string; value: string | null }[] = [];
      for (const [name, cells] of i.state.own) {
        const [win, ...rest] = cells;
        if (win && !win.deleted && !win.valueless) texts[name] = (win.value ?? null) as string | null;
        for (const c of rest) if (!c.deleted && !c.valueless) heads.push({ name, value: (c.value ?? null) as string | null });
      }
      if (i.values) for (const [name, v] of i.state.creation) if (!(name in texts)) texts[name] = v;
      const bodyLength = (h: string) => lengths.get(h);
      let reason = src.check.row({ texts, values: i.values, bodyLength });
      for (const h of heads) if (!reason) reason = src.check.row({ texts: { [h.name]: h.value }, values: undefined, bodyLength });
      if (reason) { out.push({ row: i.row, reason: "malformed", table: src.label, unit: reason }); continue; }
      if (src.check.values && i.values && !l.exists) {
        const said = (await snapshotRows<{ t: Record<string, string | null> }>(`SELECT ${unitTextsSql(src, "r")} AS t FROM jsonb_populate_record(NULL::${quote(src.table)}, $1::jsonb) r`, [JSON.stringify(i.values)])
          .catch(() => ({ rows: [] as { t: Record<string, string | null> }[] }))).rows[0]?.t;
        const rowItem = items.find((x): x is Extract<BundleItem, { kind: "row" }> => x.kind === "row" && x.table === src.table && x.stamps.some((s) => s.label === src.label && s.rowKey === i.row));
        const wire = rowItem?.texts ?? {};
        const differs = !said || Object.keys(src.fields).some((f) => Object.hasOwn(wire, f) && (said[f] ?? null) !== (wire[f] ?? null));
        if (differs) out.push({ row: i.row, reason: "malformed", table: src.label, unit: "the row's values are not the units the bundle says" });
      }
    }
  }
  return out;
}

/**
 * The rule of the tables whose rows go with their note (`RowSource.goesWithNote`; migration 215 section 2c is the same rule on the node that writes): after the bundle's
 * notes are in (UNIT_SOURCES writes content_nodes first), a row that exists after the merge and whose note, as the merge decided it, is not on this node went with that
 * note. The note's cell has no value (the sender holds only the row's stamps: it went with a note there) or names a note this node does not hold (deleted for good here, or
 * there and its tombstone is in this bundle: a bundle carries every write above this node's `have`, so a note the sender holds that this node lacks comes with it; one it
 * lacks is one it deleted). Never written as a NULL note (the column is NOT NULL). The row is removed here; its stamps stay if it had been moved into that note (its `note`
 * has a stamp of its own: the record that it went, for a node that still holds it where it was) and go otherwise (every node that held it held it in that note).
 * Returns those rows (`changed`: the merge changes what this node holds of it); storeTable removes them and writes what is kept, and leaves them alone otherwise.
 */
async function rowsThatGo(workspaceId: string, src: RowSource, merged: readonly Merged[]): Promise<{ x: Merged; changed: boolean; moved: boolean }[]> {
  if (!src.goesWithNote || !src.rows) return [];
  const noteOf = (x: Merged): string | null => (src.fields.note ? (x.m.fields.get("note")?.[0]?.value as string | null | undefined) ?? null : x.i.row);
  const live = merged.filter((x) => x.m.exists);
  const named = [...new Set(live.map(noteOf).filter((n): n is string => n !== null && isUuid(n)))];
  const held = new Set((await snapshotRows<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, named])).rows.map((r) => r.id));
  return live.filter((x) => { const note = noteOf(x); return note === null || !held.has(note); }).map((x) => {
    const { i, l, m } = x;
    // a row this node already holds only as its stamps, and the merge changes none of them: nothing to write (a bundle sent again changes nothing, round 9, point 5 d)
    const changed = l.exists || !l.state || m.starChanged || ![...new Set([...m.fields.keys(), ...m.before.keys()])].every((f) => canonical(m.fields.get(f) ?? null) === canonical(m.before.get(f) ?? null));
    return { x, changed, moved: !!src.fields.note && (i.state.own.has("note") || !!l.state?.own.has("note")) };
  });
}

/** A failure of the database that says a row names a row this node does not hold (a foreign key). */
const isMissingReference = (e: unknown): boolean => (e as { code?: string })?.code === "23503";

async function storeTable(workspaceId: string, src: RowSource, merged: readonly Merged[]): Promise<RowsReport> {
  const report = emptyReport();
  const notes = src.label === NOTES;
  const address = (row: string, name: string) => addressOfUnit(src, row, name);
  const match = (row: string) => rowMatchOf(src, [row]);
  const json = jsonSourcesOf(src);
  const jsonColumns = json.map((j) => j.column);
  const isJson = (name: string) => address("x", name).table !== src.label;
  const lines: StructureLine[] = [];
  // Removals first: a note that goes frees its slug for a note that comes (see below), and a parent that goes empties its children's parent column the way the database does
  // (each unit it empties keeps the id on its stamp: migration 215 sync_keep_emptied_id)
  for (const { i, l, m } of merged) {
    if (m.exists || !l.exists || !src.rows) continue;
    const win = m.star[0]!;
    // the row is gone for good: its units go with it (the delete trigger does the same; the keys of its JSON columns stay as stamps, below), and the log says what became of a note
    const gone = textOf(m.before.get("deleted")) ?? "false";
    await snapshotRows(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field <> '*'`, [workspaceId, src.label, i.row]);
    await snapshotRows(`DELETE FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field <> '*'`, [workspaceId, src.label, i.row]);
    const params: unknown[] = [workspaceId];
    await snapshotRows(`DELETE FROM ${quote(src.table)} t WHERE ${match(i.row).match("t", params)} AND ${match(i.row).workspace("t", "$1")}`, params);
    if (notes) { lines.push({ row: i.row, field: "deleted", from: gone, to: null, stamp: win.stamp }); report.structureLines++; }
    report.removed++;
  }
  // A slug is unique among the LIVE notes of a space, and a bundle can move one slug from a note to another (a title changed, a note trashed or moved to another space, a new note given the name
  // it left). So the notes whose slug, trash state or space is to change, and the notes that are made, hold a name no note has (~ and the id) while the bundle is written, and take their slug
  // last, when every other change is in (`assignSlugs`).
  const slugRows = notes ? merged.filter((x) => {
    const c = carriedFrom(src, x);
    return (x.m.exists && !x.l.exists) || c.overwrite || c.copy.includes("slug") || (x.m.exists && x.m.events.some((e) => (e.field === "deleted" || e.field === "space") && e.result.write));
  }) : [];
  const originalSlug = new Map((await snapshotRows<{ id: string; slug: string }>(
    `SELECT id::text, slug FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, slugRows.filter((x) => x.l.exists).map((x) => x.i.row)])).rows.map((r) => [r.id, r.slug] as const));
  if (originalSlug.size) await snapshotRows(`UPDATE content_nodes SET slug = '~' || id::text WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, [...originalSlug.keys()]]);
  const madeHere = new Set<string>();
  const hangingCandidates: HangingRow[] = [];
  // the rows that went with their note (rowsThatGo): removed here, their stamps written back onto nothing
  const going = await rowsThatGo(workspaceId, src, merged);
  const went = new Set(going.map(({ x }) => x.i.row));
  for (const { x: { i, l, m }, changed, moved } of going) {
    if (!changed) continue;
    if (l.exists) {
      const params: unknown[] = [workspaceId];
      await snapshotRows(`DELETE FROM ${quote(src.table)} t WHERE ${match(i.row).match("t", params)} AND ${match(i.row).workspace("t", "$1")}`, params);
      report.removed++;
    }
    // what this node held of the row goes first (its stamps and heads, every label): the units the merge decided are written onto nothing (review of PR #1853, round 7,
    // point 1: written as `fresh` onto heads this node already held, a head was inserted twice and the bundle refused for ever)
    for (const t of ["sync_stamps", "sync_stamp_heads"]) await snapshotRows(`DELETE FROM ${t} WHERE workspace_id = $1 AND table_name = ANY($2::text[]) AND row_key = $3`, [workspaceId, labelsOf(src), i.row]);
    if (moved) {
      // the record that it went: every unit as the merge decided it, each write WITH the value it wrote (`kept`: there is no row to hold the winners; review of PR #1853,
      // round 8: stored without them, a write said a value on one node and nothing, or a NULL, on another). storeUnit's own rules otherwise: a field that follows its
      // creation keeps no stamp row.
      const creation = new Set(m.star.map((h) => stampKey(h.stamp)));
      await storeUnit(workspaceId, address(i.row, STAR), m.star, undefined, false, true); report.stored++;
      for (const [f, unit] of m.fields) { await storeUnit(workspaceId, address(i.row, f), unit, creation, false, true); report.stored++; }
    }
  }
  for (const { i, l, m } of merged) {
    if (went.has(i.row)) continue;
    if (m.exists && !l.exists && src.rows) {
      // the sender does not hold the row either (it hangs on a note deleted for good there): only its stamps travelled, and only they are kept
      if (!i.values) continue;
      const values = notes ? { ...i.values, slug: `~${i.row}` } : i.values;
      // a row that names a row this node does not hold (its note was deleted for good here) is not made: the database refuses it. Its stamps stay, and the view of 4.9 names it.
      const outcome = await makeCarriedRow(workspaceId, src, i.row, values, m.star[0]!.stamp, report, async (row) => {
        // the row of this node that lost its natural key to the carried one (made later): removed, as every removal of a merge, here
        const params: unknown[] = [workspaceId];
        await snapshotRows(`DELETE FROM ${quote(src.table)} t WHERE ${match(row).match("t", params)} AND ${match(row).workspace("t", "$1")}`, params);
      });
      if (outcome === "made") { madeHere.add(i.row); report.created++; }
      else if (outcome === "missing-ref") hangingCandidates.push(...await notesNamed(src, i.values).then((on) => on.map((n) => ({ table: src.label, row: i.row, on: n, created: m.star[0]!.stamp }))));
    }
  }
  // A bundle that made many rows of a table leaves the planner's statistics describing the table as it was (no autovacuum runs inside a transaction, and PGlite has none):
  // the writes that follow, which look one row up by its key, were planned on the workspace's index and read every row of the workspace (quadratic in the rows read,
  // stampedBundleScale.integration.test.ts counts them). So the table is analyzed once here, inside the transaction. This node's own bookkeeping: it writes no row.
  if (report.created >= ANALYZE_AFTER_ROWS) await snapshotRows(`ANALYZE ${quote(src.table)}`);
  for (const { i, l, m } of merged) {
    if (went.has(i.row)) continue;
    const win = m.star[0]!;
    const creation = new Set(m.star.map((h) => stampKey(h.stamp)));
    const here = l.exists || madeHere.has(i.row) || !src.rows;
    // what the merge says changed is said of a row that is here (round 9, point 5 b: not of a row that went with its note, nor of one this node does not make)
    if (here) for (const e of m.events) report.events.push({ address: address(i.row, e.field), result: { ...e.result, deferred: [] } });
    // a row this node does not hold keeps its writes' values only where they go with a note (ids; round 9, point 2): another table's row hanging on a note or space
    // deleted for good here keeps its stamps, each a copy without its value, never the text it carried
    const keeps = !here && !!src.goesWithNote;
    const shape = (u: Unit | undefined): Unit | undefined => (u && !here && !keeps ? withoutValues(u) : u);
    const fresh = madeHere.has(i.row) && !l.state; // made here from the carried values, nothing of it held before: only stamps to write (storeUnit)
    if (m.exists) {
      let counted = false; // a unit that counts as an edit was written to a note that was here: only then can `updated_at` change (a row made here carries the sender's `updated_at`, which is the same function of the same stamps)
      if (!l.state || m.starChanged) { await storeUnit(workspaceId, address(i.row, STAR), m.star, undefined, fresh); report.stored++; }
      // the same row made twice (two nodes made the same id, or this node still holds a row that another deleted and made again): the creation that wins is the row, on every node
      const from = carriedFrom(src, { i, l, m });
      if (from.overwrite) await overwriteCarriedColumns(src.table, workspaceId, match(i.row), i.values!, [...Object.values(src.fields).flatMap((c) => c.split("+")), ...src.key.map((k) => k.column), ...jsonColumns, ...(notes ? ["order_stamp", "slug"] : [])]);
      for (const f of new Set([...m.fields.keys(), ...m.before.keys()])) {
        const after = m.fields.get(f), prior = m.before.get(f);
        const a = address(i.row, f);
        if (!after) { // no cell is left for it (cannot happen while a creation gives every field a value): nothing of its own is kept
          await snapshotRows(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, [workspaceId, a.table, i.row, a.field]);
          await snapshotRows(`DELETE FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, [workspaceId, a.table, i.row, a.field]);
          continue;
        }
        if ((here && !l.exists) || m.starChanged || !prior || canonical(shape(after)) !== canonical(prior)) {
          await storeUnit(workspaceId, a, shape(after)!, creation, fresh, keeps); report.stored++;
          if (notes && l.exists && (!isJson(f) || f.startsWith("content_nodes.tag_schema:")) && !NOT_AN_EDIT_FIELDS.includes(f)) counted = true;
        }
      }
      // What the write path derives from a unit travels with the unit that won: the slug of a title, the time a note was deleted; `updated_at` of a note that is only touched is a function of the stamps (sync_touch_updated_at); a creation that wins brings its own
      if (l.exists && i.values) await followCarriedColumns(src.table, workspaceId, match(i.row), i.values, from.copy.filter((c) => c !== "slug"), []);
      if (counted) await snapshotRows(`SELECT sync_touch_updated_at($1::uuid, $2)`, [workspaceId, i.row]); // updated_at is a function of the stamps now written
      if (notes && here) {
        for (const f of STRUCTURE_FIELDS) {
          const before = l.exists ? textOf(m.before.get(f)) : null, now = textOf(m.fields.get(f));
          if (!l.exists || before !== now) { lines.push({ row: i.row, field: f, from: before, to: now, stamp: (m.fields.get(f)?.[0] ?? win).stamp }); report.structureLines++; }
        }
      }
    } else {
      if (!l.state || m.starChanged) { await storeUnit(workspaceId, address(i.row, STAR), m.star); report.stored++; }
      // the keys of a JSON column are units of their own and are kept when the row is gone (the delete trigger leaves their tombstones on the node that removed it)
      // ... as their stamps only: a removed row's keys keep no value (round 9, point 2)
      for (const x of m.leftOver.filter((x) => isJson(x.field))) {
        const unit = withoutValues(x.cells);
        const prior = l.state?.own.get(x.field);
        // compared with what is stored, values and all: a head this node held WITH its text is written again without it (round 10, point 3: compared without values, it
        // was never rewritten, and the text of a key of a note deleted for good stayed on the node that had not deleted it, and was sent on)
        if (!prior || canonical(prior) !== canonical(unit)) { await storeUnit(workspaceId, address(i.row, x.field), unit, creation); report.stored++; }
      }
      const late = m.leftOver.map((x) => ({ ...x, cells: x.cells.filter((c) => !c.deleted) })).filter((x) => x.cells.length);
      if (late.length) {
        const seen = (win.meta as { seen?: Record<string, number> } | undefined)?.seen ?? {};
        report.lateEdits.push(...recoverLateEdits([{ id: i.row, purged: { stamp: win.stamp, seen }, writes: late.flatMap((x) => x.cells.map((c): FieldWrite => ({ field: x.field, stamp: c.stamp, value: c.value }))) }]));
      }
    }
  }
  await writeStructureLines(workspaceId, lines);
  if (notes) {
    const views = await orphansOf(workspaceId, merged);
    report.orphaned = views.fixes; report.notices = views.notices;
    await assignSlugs(workspaceId, slugRows.map((x) => {
      const c = carriedFrom(src, x);
      return { id: x.i.row, slug: !x.l.exists || c.overwrite || c.copy.includes("slug") ? String(x.i.values?.slug) : originalSlug.get(x.i.row)! };
    }));
  } else if (hangingCandidates.length) {
    const views = rowsOnDeletedNotes(hangingCandidates, await deletionsOf(workspaceId, [...new Set(hangingCandidates.map((h) => h.on))]));
    report.hanging = views.hanging; report.notices = views.notices;
  }
  return report;
}

/**
 * A row of the bundle this node does not hold, made from the values the bundle carried. `made`: it is in the table. `missing-ref`: it names a row this node does not hold
 * (a foreign key; the view of 4.9 names it). `duplicate`: another row of this node has one of its natural keys (`RowSource.naturalKeys`) and was made first (creation stamp,
 * then row key, the same on every node): the incoming row is not made. When the incoming row was made first, the row this node holds goes (its stamps stay, like every row
 * that is not held; what hangs on it goes with it, as the database's own cascade does) and the incoming one is made. Both cases are in `duplicateRows`; for a function
 * reference also in `duplicateRefs`, whose config is merged key by key as a view (rules/functionRefs.ts). A clash on a unique key the source does not declare refuses the
 * bundle (`bundle_unique_clash`): nothing is left out quietly.
 */
async function makeCarriedRow(workspaceId: string, src: RowSource, row: string, carried: Record<string, unknown>, created: Stamp, report: RowsReport, removeLater: (row: string) => Promise<void>): Promise<"made" | "missing-ref" | "duplicate"> {
  // a column a foreign key empties is NULL where the row it names is not here, as the database leaves it when that row goes (clearedOnDelete; round 9, point 1)
  const values = await clearMissingRefs(src, carried);
  const attempt = () => withSavepoint(async () => insertCarriedRow(src.table, workspaceId, values)).catch((e) => { if (isMissingReference(e)) return -1; throw e; });
  for (let round = 0; round <= (src.naturalKeys?.length ?? 0); round++) {
    const made = await attempt();
    if (made < 0) return "missing-ref";
    if (made === 1) return "made";
    const clash = await rowWithSameKey(workspaceId, src, values);
    if (!clash) throw bundleRefused("bundle_unique_clash", `a row of ${src.label} clashes with a row this node holds on a unique key that is not declared (dbUnits.ts naturalKeys)`);
    const order = compareStamps(created, clash.created) || (row < clash.row ? -1 : 1);
    const keep = order < 0 ? row : clash.row, lose = order < 0 ? clash.row : row;
    report.duplicateRows.push({ table: src.label, key: clash.key, kept: keep, lost: lose });
    if (src.label === "function_refs") {
      report.duplicateRefs.push(mergeDuplicateRefs([
        { id: clash.row, holder: "", fn: "", instance: "", created: clash.created, config: {} },
        { id: row, holder: "", fn: "", instance: "", created, config: {} },
      ])[0]!);
    }
    if (keep !== row) return "duplicate";
    await removeLater(clash.row);
  }
  throw bundleRefused("bundle_unique_clash", `a row of ${src.label} still clashes after every declared natural key was settled`);
}

/** The row of this node that holds one of `values`' natural keys, with the key's name and the row's creation stamp (genesis when it has none). */
async function rowWithSameKey(workspaceId: string, src: RowSource, values: Record<string, unknown>): Promise<{ row: string; key: string; created: Stamp } | null> {
  const over = (sql: string, alias: string) => sql.replaceAll("{t}", alias);
  const match = rowMatchOf(src, []);
  for (const k of src.naturalKeys ?? []) {
    const params: unknown[] = [JSON.stringify(values), workspaceId];
    const hit = (await snapshotRows<{ row: string }>(
      `SELECT ${match.idSql("t")} AS row FROM ${quote(src.table)} t, jsonb_populate_record(NULL::${quote(src.table)}, $1::jsonb) r
        WHERE (${k.columns.map((c) => over(c, "t")).join(", ")}) = (${k.columns.map((c) => over(c, "r")).join(", ")})
          ${k.where ? `AND ${over(k.where, "t")} AND ${over(k.where, "r")}` : ""} AND ${match.workspace("t", "$2")} LIMIT 1`, params)).rows[0];
    if (!hit) continue;
    const star = (await snapshotRows<StampRow>(`SELECT ${STAMP_COLS} FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = '*'`, [workspaceId, src.label, hit.row])).rows[0];
    return { row: hit.row, key: k.name, created: star ? stampOf(star) : { origin: GENESIS_STAMP_ORIGIN, seq: 0, wall: 0, counter: 0, author: null, device: null } };
  }
  return null;
}

/** The notes a row of `src` names (its key columns and fields that point at content_nodes), from the values the bundle carries: what it hangs on. */
async function notesNamed(src: RowSource, values: Record<string, unknown>): Promise<string[]> {
  const r = await snapshotRows<{ col: string }>(
    `SELECT a.attname::text AS col FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.conrelid = $1::regclass AND c.confrelid = 'content_nodes'::regclass AND array_length(c.conkey, 1) = 1`, [quote(src.table)]);
  return [...new Set(r.rows.map((x) => values[x.col]).filter((v): v is string => typeof v === "string"))].sort();
}

/** The permanent deletes this node holds of `notes`: the tombstone of each note's `*` and what its deleter had seen. */
async function deletionsOf(workspaceId: string, notes: string[]): Promise<Map<string, Deletion>> {
  const dead = new Map<string, Deletion>();
  if (notes.length === 0) return dead;
  const rows = (await snapshotRows<StampRow & { row_key: string }>(
    `SELECT row_key, ${STAMP_COLS} FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND field = '*' AND deleted AND row_key = ANY($3::text[])`, [workspaceId, NOTES, notes])).rows;
  for (const r of rows) dead.set(r.row_key, { stamp: stampOf(r), seen: ((r.meta as { seen?: Record<string, number> } | null)?.seen) ?? {} });
  return dead;
}

/**
 * Give the notes of a bundle their slugs (they hold `~id` until now). Two live notes of a space cannot have one slug: when that would happen the note with the LARGER id takes
 * `slug-<first eight of its id>`, whichever of the two it is, the same on every node that sees both. (A slug is derived from a title by the write path of the node that wrote it; it is not a
 * unit. This keeps the database's index true without choosing between the two titles; PR "需要決定".)
 */
async function assignSlugs(workspaceId: string, wanted: { id: string; slug: string }[]): Promise<void> {
  for (const { id, slug } of [...wanted].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const row = (await snapshotRows<{ live: boolean; space: string | null }>(`SELECT (${liveNodeSql()}) AS live, space_id::text AS space FROM content_nodes WHERE workspace_id = $1 AND id = $2::uuid`, [workspaceId, id])).rows[0];
    if (!row) continue;
    let final = slug;
    if (row.live) {
      // in the exact form of the unique index content_nodes_space_slug_uq (workspace_id, COALESCE(space_id, zero uuid), slug) WHERE deleted_at IS NULL, so it is one index lookup.
      // Without the space term only the workspace prefix of the index applies: on a real Postgres with current statistics every lookup read the workspace's notes (one scan per note)
      const other = (await snapshotRows<{ id: string }>(
        `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND COALESCE(space_id, '${NO_SPACE}'::uuid) = $4::uuid AND slug = $2 AND ${liveNodeSql()} AND id <> $3::uuid`,
        [workspaceId, slug, id, row.space ?? NO_SPACE])).rows[0];
      if (other) {
        if (other.id < id) final = `${slug}-${id.split("-")[0]}`;
        else await snapshotRows(`UPDATE content_nodes SET slug = $3 WHERE workspace_id = $1 AND id = $2::uuid`, [workspaceId, other.id, `${slug}-${other.id.split("-")[0]}`]);
      }
    }
    await snapshotRows(`UPDATE content_nodes SET slug = $3 WHERE workspace_id = $1 AND id = $2::uuid`, [workspaceId, id, final]);
  }
}


/**
 * Rule 4.9 as a VIEW over the stamps (rules/trash.ts): which notes of this bundle sit under a parent that was deleted for good before its deleter had seen them, and who is to be told. It is a
 * function of stamps every node holds, so every node computes the same answer; it is NOT written. Putting the note in the trash would be a write, and a derived repair must be a pure function
 * of replicated state, not a stamped write each node makes on its own (docs/research/sync-design-vs-literature-2026-11-16.md item 6). The note keeps its place (parent column emptied by the
 * database's SET NULL) and the caller has the list; the reads that do not know this view yet are pinned in stampedBundle.integration.test.ts ("rule 4.9, the READ").
 * Being a view, it answers again for every later bundle that carries the note (its parent column is empty, its stamp keeps the parent: round 10, point 8): whoever
 * shows the notices dedupes them by (note, to, kind). Nothing shows them today.
 */
async function orphansOf(workspaceId: string, merged: readonly Merged[]): Promise<{ fixes: TrashFix[]; notices: Notice[] }> {
  const alive = merged.filter((x) => x.m.exists);
  const parents = [...new Set(alive.map((x) => textOf(x.m.fields.get("parent"))).filter((p): p is string => !!p))];
  const dead = await deletionsOf(workspaceId, parents);
  const notes: TreeNote[] = [];
  for (const x of alive) {
    const parent = textOf(x.m.fields.get("parent"));
    notes.push({ id: x.i.row, parent: parent && dead.has(parent) ? parent : null, created: x.m.fields.get("parent")![0]!.stamp, deleted: null }); // the write that put the note under that parent (its creation, or the move)
  }
  for (const [id, deleted] of dead) if (deleted) notes.push({ id, parent: null, created: deleted.stamp, deleted });
  const fixes = trashOrphanedChildren(notes);
  const trashed = alive.filter((x) => textOf(x.m.fields.get("deleted")) === "true").map((x) => {
    const d = x.m.fields.get("deleted")![0]!;
    return { id: x.i.row, deleted: { stamp: d.stamp, seen: d.saw }, edits: [...x.m.fields].filter(([f]) => f !== "deleted").flatMap(([, u]) => u.map((c) => c.stamp)) };
  });
  const edited = noticesForEditedDeletes(trashed);
  return { fixes: fixes.fixes, notices: [...fixes.notices, ...edited].sort((a, b) => (a.note + a.to + a.kind < b.note + b.to + b.kind ? -1 : 1)) };
}
