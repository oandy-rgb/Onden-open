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
import { liveNodeSql } from "../nodeSql.js";
import { followCarriedColumns, insertCarriedRow, overwriteCarriedColumns, snapshotRows, type BundleItem, type WireStamp } from "../snapshotSql.js";
import { type Deletion, type FieldWrite, type Hanging, type HangingRow, type Notice, type RecoveryCopy, type TrashFix, type TreeNote, noticesForEditedDeletes, recoverLateEdits, rowsOnDeletedNotes, trashOrphanedChildren } from "./rules/trash.js";
import { type RowState, mergeRow } from "./rows.js";
import { type MergedRef, mergeDuplicateRefs } from "./rules/functionRefs.js";
import { type Cell, type Json, type Rejection, type Stamp, type Unit, canonical, compareStamps, stampKey } from "./unit.js";
import {
  NOT_AN_EDIT_FIELDS, STAMP_COLS, STAR_PRESENT, UNIT_SOURCES, addressOfUnit, cellMetaOf, jsonSourceOf, jsonSourcesOf, labelsOf, quote, rowMatchOf, sourceOf, stampOf, storeUnit, unitName, unitTextsSql,
  type HeadRow, type RowSource, type StampRow,
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
  /** Who is to be told: the creators of those notes and rows, and the editors of a trashed note whose edit its deleter had not seen. */
  notices: Notice[];
  created: number;
  removed: number;
  /** How many units were written. */
  stored: number;
  structureLines: number;
};

type Incoming = { row: string; values: Record<string, unknown> | undefined; state: RowState };

const wireCell = (s: Pick<WireStamp, "origin" | "seq" | "wall" | "counter" | "author" | "device" | "deleted" | "saw" | "meta">, value: Json | null): Cell => ({
  stamp: { origin: s.origin, seq: s.seq, wall: s.wall, counter: s.counter, author: s.author, device: s.device },
  saw: s.saw ?? {}, deleted: s.deleted, value: s.deleted ? null : value, ...(s.meta === null || s.meta === undefined ? {} : { meta: s.meta as Json }),
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
      own.set(name, [wireCell(s, texts[name] ?? null), ...s.heads.map((h) => wireCell({ ...h, meta: h.meta }, h.value))]);
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
  const stamps = (await snapshotRows<StampRow & { label: string; row_key: string; field: string }>(
    `SELECT table_name AS label, row_key, field, ${STAMP_COLS} FROM sync_stamps WHERE workspace_id = $1 AND table_name = ANY($2::text[]) AND row_key = ANY($3::text[])`, [workspaceId, labels, rows])).rows;
  const heads = (await snapshotRows<HeadRow & { label: string; row_key: string; field: string }>(
    `SELECT table_name AS label, row_key, field, ${STAMP_COLS}, content_hash, value FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = ANY($2::text[]) AND row_key = ANY($3::text[])`, [workspaceId, labels, rows])).rows;
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
      else if (isUnit(s.label, s.field)) { hasOwn.add(name); (own.get(name) ?? own.set(name, []).get(name)!).push({ stamp: stampOf(s), saw: s.saw, deleted: s.deleted, value: s.deleted ? null : (t?.[name] ?? null), ...cellMetaOf(s) }); }
    }
    for (const h of headsOf.get(row) ?? []) {
      const name = unitName(src, h.label, h.field);
      const isStar = h.label === src.label && h.field === STAR;
      const cell: Cell = { stamp: stampOf(h), saw: h.saw, deleted: h.deleted, value: h.deleted ? null : isStar ? STAR_PRESENT : h.value, ...cellMetaOf(h) };
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
const emptyReport = (): RowsReport => ({ events: [], rejected: [], lateEdits: [], orphaned: [], hanging: [], duplicateRefs: [], notices: [], created: 0, removed: 0, stored: 0, structureLines: 0 });

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
    const local = await loadLocal(workspaceId, src, incoming.map((i) => i.row));
    const merged: Merged[] = [];
    for (const i of incoming) {
      const l = local.get(i.row)!;
      const m = mergeRow(l.state, i.state);
      if ("rejected" in m) { report.rejected.push({ row: i.row, reason: m.rejected, table: src.label, ...(m.unit ? { unit: m.unit } : {}) }); continue; }
      merged.push({ i, l, m });
    }
    plans.push({ src, merged });
  }
  if (report.rejected.length) return report;
  for (const { src, merged } of plans) {
    const r = await storeTable(workspaceId, src, merged);
    for (const k of ["events", "lateEdits", "orphaned", "hanging", "duplicateRefs", "notices"] as const) (report[k] as unknown[]).push(...r[k]);
    for (const k of ["created", "removed", "stored", "structureLines"] as const) report[k] += r[k];
  }
  report.notices.sort((a, b) => (a.note + a.to + a.kind < b.note + b.to + b.kind ? -1 : 1));
  return report;
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
  for (const { i, l, m } of merged) {
    for (const e of m.events) report.events.push({ address: address(i.row, e.field), result: { ...e.result, deferred: [] } });
    if (m.exists && !l.exists && src.rows) {
      // the sender does not hold the row either (it hangs on a note deleted for good there): only its stamps travelled, and only they are kept
      if (!i.values) continue;
      const values = notes ? { ...i.values, slug: `~${i.row}` } : i.values;
      // a row that names a row this node does not hold (its note was deleted for good here) is not made: the database refuses it. Its stamps stay, and the view of 4.9 names it.
      const made = await withSavepoint(async () => { await insertCarriedRow(src.table, workspaceId, values); return true; }).catch((e) => { if (isMissingReference(e)) return false; throw e; })
        && await keepEarlierReference(workspaceId, src, i, m.star[0]!.stamp, report);
      if (made) { madeHere.add(i.row); report.created++; }
      else hangingCandidates.push(...await notesNamed(src, i.values).then((on) => on.map((n) => ({ table: src.label, row: i.row, on: n, created: m.star[0]!.stamp }))));
    }
  }
  // A bundle that made many rows of a table leaves the planner's statistics describing the table as it was (no autovacuum runs inside a transaction, and PGlite has none):
  // the writes that follow, which look one row up by its key, were planned on the workspace's index and read every row of the workspace (quadratic in the rows read,
  // stampedBundleScale.integration.test.ts counts them). So the table is analyzed once here, inside the transaction. This node's own bookkeeping: it writes no row.
  if (report.created >= ANALYZE_AFTER_ROWS) await snapshotRows(`ANALYZE ${quote(src.table)}`);
  for (const { i, l, m } of merged) {
    const win = m.star[0]!;
    const creation = new Set(m.star.map((h) => stampKey(h.stamp)));
    const here = l.exists || madeHere.has(i.row) || !src.rows;
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
        if (!l.exists || m.starChanged || !prior || canonical(after) !== canonical(prior)) {
          await storeUnit(workspaceId, a, after, creation, fresh); report.stored++;
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
      for (const x of m.leftOver.filter((x) => isJson(x.field))) {
        const unit = [...x.cells];
        const prior = l.state?.own.get(x.field);
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
 * Two nodes each made the same function reference (same holder, function and instance) with different ids: the table holds one (a unique index). The row that stays is the one
 * made first (rules/functionRefs.ts mergeDuplicateRefs, by its creation stamp, then id), on every node: when the incoming row is that one, the row this node made goes (its stamps
 * stay, like every row that is not held) and the incoming row is made; otherwise the incoming row is not made. The other row's config keys are merged into the kept one as a VIEW
 * (`duplicateRefs`), not written. Returns whether the incoming row is in the table now. Only function_refs has a natural key besides its id.
 */
async function keepEarlierReference(workspaceId: string, src: RowSource, i: Incoming, created: Stamp, report: RowsReport): Promise<boolean> {
  if (src.label !== "function_refs") return true;
  const there = (await snapshotRows<{ id: string }>(`SELECT id::text FROM function_refs WHERE workspace_id = $1 AND id = $2::uuid`, [workspaceId, i.row])).rows.length > 0;
  if (there) return true;
  const v = i.values!;
  const other = (await snapshotRows<{ id: string } & StampRow>(
    `SELECT f.id::text, ${STAMP_COLS.split(", ").map((c) => `s.${c}`).join(", ")} FROM function_refs f JOIN sync_stamps s ON s.workspace_id = f.workspace_id AND s.table_name = 'function_refs' AND s.row_key = f.id::text AND s.field = '*'
      WHERE f.workspace_id = $1 AND COALESCE(f.holder_node_id, f.holder_space_id, f.holder_block_id) = COALESCE($2::uuid, $3::uuid, $4::uuid) AND f.function_id = $5 AND f.instance = $6`,
    [workspaceId, v.holder_node_id ?? null, v.holder_space_id ?? null, v.holder_block_id ?? null, v.function_id, v.instance ?? ""])).rows[0];
  if (!other) return false;
  const kept = mergeDuplicateRefs([
    { id: other.id, holder: "", fn: "", instance: "", created: stampOf(other), config: {} },
    { id: i.row, holder: "", fn: "", instance: "", created, config: {} },
  ])[0]!;
  report.duplicateRefs.push(kept);
  if (kept.keepId !== i.row) return false;
  await snapshotRows(`DELETE FROM function_refs WHERE workspace_id = $1 AND id = $2::uuid`, [workspaceId, other.id]);
  await insertCarriedRow(src.table, workspaceId, v);
  return true;
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
