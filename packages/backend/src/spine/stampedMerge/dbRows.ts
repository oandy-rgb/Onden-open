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

import { bumpMembershipEpoch, withSavepoint } from "../../db.js";
import { sha256Hex } from "../../utils.js";
import { isUuid } from "@onden/markdown";
import { bundleRefused } from "../bundleRefusal.js";
import { liveNodeSql, tagNodeSql } from "../nodeSql.js";
import { settleSlugs, slugFor } from "../noteSlugs.js";
import { followCarriedColumns, insertCarriedRow, overwriteCarriedColumns, snapshotRows, type BundleItem, type WireStamp } from "../snapshotSql.js";
import { type Deletion, type FieldWrite, type Hanging, type HangingRow, type Notice, type RecoveryCopy, type TrashFix, type TreeNote, noticesForEditedDeletes, recoverLateEdits, rowsOnDeletedNotes, trashOrphanedChildren } from "./rules/trash.js";
import { type RowState, mergeRow } from "./rows.js";
import type { ParentLink } from "./rules/moveCycle.js";
import { type SpaceTreeRow, cutParents, notesOnLoops, spacesOfTree } from "./rules/space.js";
import { type MergedRef, mergeDuplicateRefs } from "./rules/functionRefs.js";
import { type Cell, type Json, type Rejection, type Stamp, type Unit, GENESIS_STAMP_ORIGIN, canonical, compareStamps, inWinnerOrder, isGenesis, isResent, maximalHeads, stampKey } from "./unit.js";
import {
  NOT_AN_EDIT_FIELDS, STAMP_COLS, STAR_PRESENT, UNIT_SOURCES, UPDATED_AT_OF_STAMPS, addressOfUnit, cellMetaOf, jsonSourceOf, jsonSourcesOf, labelsOf, quote, replicatedColumnsOf, rowMatchOf, sourceOf, stampOf, storeUnit, unitName, unitTextsSql,
  clearMissingRefs, clearedOf, headValue, readUnit, stampValue, type HeadRow, type KeptValue, type RowSource, type StampRow,
} from "./dbUnits.js";
import { STAR, seenByDelete, type StoreEvent } from "./store.js";
import { allocateMergeStamp } from "../stamps.js";

const NOTES = "content_nodes";
// A note's slug follows the write that set it (a title); a restore wants the one its title gives, a move the one it had; two live notes of a space that want one
// are settled by one rule on every node (spine/noteSlugs.ts settleSlugs: the later claim gives way). Batch 4a, own-node-transport §2.12.6.
/** Columns the write path sets from a unit (a note's slug from its title) follow that unit's winner. `updated_at` of a note is a function of the counting stamps (migration 206), or the carried value of a creation. */
const DERIVED_WITH: Readonly<Record<string, Readonly<Record<string, string[]>>>> = { content_nodes: { title: ["slug"], deleted: ["deleted_at"] }, spaces: { deleted: ["written_deleted_at"] } };
/** How many rows a bundle makes in one table before the table's statistics are brought up to date (`ANALYZE`, storeTable). */
const ANALYZE_AFTER_ROWS = 100;
// the fields the stamp trigger of content_nodes logs (migration 190), from their units; `space` is logged as the space the note is in, which the merge derives
// last (deriveNoteSpaces, below), not as the space written for it
const STRUCTURE_FIELDS = ["parent", "deleted"];

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
  /** Notes whose space changed because their tree did (an ancestor moved to another space, or the note was put under a note of another space): nobody wrote a
   *  space for them. Derived on every node alike (deriveNoteSpaces), REPORTED; whom to tell is for the transport batch. */
  followedSpaces: FollowedSpace[];
  /** Spaces whose deletion is written and that are shown all the same, because a live note is in them that came by a write the deleter had not seen (4.9 for a
   *  space): the deletion stays written, a head its author can see, and takes effect once the space is empty. A view, REPORTED. */
  keptSpaces: string[];
  /** Notes this node held alive that a bundle wrote over with a creation made over a permanent delete this node had not seen (`meta.seen`, not a re-send): what
   *  hangs on them here is sent again once the bundle is in (`resendRowsOnRemadeNotes`, called by applyChangeBundle). */
  remade: string[];
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
  return { row: rowKey, values: rowItem?.values, state: { star: inWinnerOrder(star), own, creation } };
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
    out.set(row, { exists: !!t, state: star.length ? { star: inWinnerOrder(star), own, creation } : undefined });
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

/** `went`: a row that goes with its note although the note is here, because the note was made again over a delete that had seen all of it (goneWithTheDelete).
 *  `cascaded`: a row of another table that hangs on such a note, all of it seen by the delete: removed as the deleter's cascade removed it (`carried`: the bundle
 *  carries it, and what it brings is merged as for a row that is not here; else its stamps stay as they are). */
type Merged = { i: Incoming; l: LocalRow; m: Extract<ReturnType<typeof mergeRow>, { exists: boolean }>; went?: true; cascaded?: { carried: boolean } };

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
const emptyReport = (): RowsReport => ({ events: [], rejected: [], lateEdits: [], orphaned: [], hanging: [], duplicateRefs: [], duplicateRows: [], notices: [], followedSpaces: [], keptSpaces: [], remade: [], created: 0, removed: 0, stored: 0, structureLines: 0 });
/** What the notes' table hands to the step after every table is in: the notes whose space is derived again, those made here, and the slug each must end with. */
type TreeWork = { seeds: string[]; made: Set<string>; slugs: Map<string, string> };

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
  const tree: TreeWork = { seeds: [], made: new Set(), slugs: new Map() };
  let taken = false;
  for (const src of UNIT_SOURCES) {
    // what the delete of a note made again takes here (goneWithTheDelete), written as rows of the bundle, once: the notes come first in UNIT_SOURCES (report.remade is
    // known once they are in), what goes with them after
    if (!taken && report.remade.length) {
      taken = true;
      for (const [s, extra] of await goneWithTheDelete(workspaceId, report.remade, plans)) {
        const plan = plans.find((p) => p.src === s) ?? (plans.push({ src: s, merged: [] }), plans[plans.length - 1]!);
        plan.merged = [...plan.merged.filter((x) => !extra.some((y) => y.i.row === x.i.row)), ...extra];
      }
    }
    const plan = plans.find((p) => p.src === src);
    if (!plan) continue;
    const { merged } = plan;
    // a unit written into an existing row can still clash on a unique key (a task line's task, a paragraph's anchor): the bundle is refused with a code, not a database error
    const r = await storeTable(workspaceId, src, merged, tree).catch((e: unknown) => {
      const code = (e as { code?: string })?.code;
      if (code === "23505") throw bundleRefused("bundle_unique_clash", `a write of ${src.label} clashes with a row this node holds on a unique key (${String((e as { constraint?: string }).constraint ?? "?")})`);
      // a value the database will not hold (a CHECK, a NOT NULL, a text that is not of the column's type, a number out of range, a column it does not have): the bundle is malformed
      if (code && MALFORMED_CODES.has(code)) throw bundleRefused("bundle_malformed", `a row of ${src.label} has a value this database does not hold`, 422);
      throw e;
    });
    for (const k of ["events", "lateEdits", "orphaned", "hanging", "duplicateRefs", "duplicateRows", "notices", "remade"] as const) (report[k] as unknown[]).push(...r[k]);
    for (const k of ["created", "removed", "stored", "structureLines"] as const) report[k] += r[k];
  }
  // LAST: the space each note is in follows its tree (rules/space.ts), for every note the bundle bears on and every note under them, so the deferred
  // content_nodes_check_space holds; then every note of the bundle, and every note whose space changed, takes its slug (unique among a space's live notes)
  const derived = await deriveNoteSpaces(workspaceId, tree.seeds, tree.made, tree.slugs).catch((e: unknown) => {
    if ((e as { code?: string })?.code === "23505") throw bundleRefused("bundle_unique_clash", `a note's space follows its tree and clashes with a row this node holds on a unique key (${String((e as { constraint?: string }).constraint ?? "?")})`);
    // a value the tree reads that is not of its type (a `meta.from` that is not a note id: the door refuses it, stampedImport.ts isMeta; this is the second line)
    if ((e as { code?: string })?.code === "22P02") throw bundleRefused("bundle_malformed", "a note's space follows its tree, and a value the tree reads is not of its type", 422);
    throw e;
  });
  await writeStructureLines(workspaceId, derived.lines);
  report.structureLines += derived.lines.length;
  report.followedSpaces = derived.followed;
  await settleSlugs(workspaceId, [...tree.slugs].map(([id, slug]) => ({ id, slug })));
  // and then whether each space whose deletion is written is shown deleted (no live note in it) or kept (migration 218 spaces_show_deleted: one definition)
  report.keptSpaces = await showSpaceDeletions(workspaceId, plans.some((p) => p.src.label === NOTES || p.src.label === "spaces"));
  // what a source's rows are written into, after every table is in: for every row the bundle bears on (a note's anchors unit writes its anchor rows, for every note whose
  // body, unit or anchor rows came in), from replicated state only. A value it cannot write refuses the bundle with a code, as a table's write does.
  await expandTouched(workspaceId, plans).catch((e: unknown) => {
    const code = (e as { code?: string })?.code;
    if (code && (MALFORMED_CODES.has(code) || code === "OD215")) throw bundleRefused("bundle_malformed", `a row of the bundle cannot be written into what follows from it (${code})`, 422);
    throw e;
  });
  report.notices.sort((a, b) => (a.note + a.to + a.kind < b.note + b.to + b.kind ? -1 : 1));
  await checkDeferredNow();
  return report;
}
/**
 * A head of a note's `*` that came in a bundle and says the note was made again over a permanent delete: a creation (not a re-send) carrying `meta.seen` (migration
 * 206 and createRow put what the deleter had seen there), that this node did not hold before. The caller asks it only of a note this node holds alive: it may hold
 * rows the nodes that took the delete dropped (README 「筆記以同一個 id 重建時」). It does NOT ask whether this node had seen that delete: a node that took the delete
 * and made the note again itself also sends its rows again when another node's creation comes (nothing wrong, one more batch of heads with the same content;
 * review of PR #2024, round 2).
 */
function remadeOverUnseenDelete(local: RowState | undefined, star: Unit): boolean {
  const held = new Set((local?.star ?? []).map((h) => stampKey(h.stamp)));
  return star.some((h) => !h.deleted && !isResent(h) && !held.has(stampKey(h.stamp))
    && typeof (h.meta as { seen?: unknown } | undefined)?.seen === "object" && (h.meta as { seen?: unknown }).seen !== null);
}

/** A cascading foreign key between two carried tables: a row of `src` hangs on the row of `on` its `column` names (by `onColumn`), and goes when that row goes. */
type HangEdge = { src: RowSource; column: string; type: string; on: string; onColumn: string };
let hangEdgesCache: HangEdge[] | undefined;
/** The carried tables whose rows hang on a note, and on each other, read from the database's own catalog (ON DELETE CASCADE, one column): not a list kept by hand,
 *  so a new carried table that hangs on a note is sent again with the others. A note's own children are not among them: a note is a row of its own (its parent is
 *  emptied, not deleted, when its parent goes). */
async function hangEdges(): Promise<HangEdge[]> {
  if (hangEdgesCache) return hangEdgesCache;
  const sources = UNIT_SOURCES.filter((x) => x.rows && x.label !== NOTES);
  const r = await snapshotRows<{ t: string; col: string; type: string; ref: string; refcol: string }>(
    `SELECT c.conrelid::regclass::text AS t, a.attname::text AS col, format_type(b.atttypid, b.atttypmod) AS type, c.confrelid::regclass::text AS ref, b.attname::text AS refcol
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_attribute b ON b.attrelid = c.confrelid AND b.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND c.confdeltype = 'c' AND array_length(c.conkey, 1) = 1 AND c.conrelid = ANY($1::regclass[])
      ORDER BY 1, 2`, [sources.map((x) => quote(x.table))]);
  const tables = new Set([NOTES, ...sources.map((x) => x.table)]);
  hangEdgesCache = r.rows.filter((e) => tables.has(e.ref)).map((e) => ({ src: sources.find((x) => x.table === e.t)!, column: e.col, type: e.type, on: e.ref, onColumn: e.refcol }));
  return hangEdgesCache;
}

type HeldOnNote = { src: RowSource; row: string; parents: Set<string> };
const rowId = (table: string, row: string) => `${table}\u0000${row}`;
/** Every row of a carried table that hangs on one of `notes` here, directly or through rows that hang on them (a paragraph's tags hang on its paragraph row, which hangs
 *  on its note), with the rows it hangs on (`parents`, by `rowId`). */
async function rowsHangingOn(workspaceId: string, notes: readonly string[]): Promise<Map<string, HeldOnNote>> {
  const edges = await hangEdges();
  const found = new Map<string, HeldOnNote>();
  // (table, column) → value → the row (rowId) that holds it: what the next step looks rows up by
  const values = new Map<string, Map<string, string>>([[`${NOTES}.id`, new Map(notes.map((n) => [n, rowId(NOTES, n)]))]]);
  for (let fresh = true, depth = 0; fresh && depth < UNIT_SOURCES.length; depth++) {
    fresh = false;
    for (const e of edges) {
      const on = values.get(`${e.on}.${e.onColumn}`);
      if (!on?.size) continue;
      const wanted = [...new Set(edges.filter((x) => x.on === e.src.table).map((x) => x.onColumn))];
      const match = rowMatchOf(e.src, []);
      const params: unknown[] = [workspaceId, [...on.keys()]];
      const hits = (await snapshotRows<{ row: string; parent: string; refs: Record<string, string | null> }>(
        `SELECT ${match.idSql("t")} AS row, t.${quote(e.column)}::text AS parent, jsonb_build_object(${wanted.map((c) => `'${c}', t.${quote(c)}::text`).join(", ") || "'_', NULL"}) AS refs
           FROM ${quote(e.src.table)} t WHERE t.${quote(e.column)} = ANY($2::${e.type}[]) AND ${match.workspace("t", "$1")}${e.src.where ? ` AND ${e.src.where}` : ""}`, params)).rows;
      for (const h of hits) {
        const id = rowId(e.src.table, h.row);
        const was = found.get(id);
        if (was) { was.parents.add(on.get(h.parent)!); continue; }
        found.set(id, { src: e.src, row: h.row, parents: new Set([on.get(h.parent)!]) });
        fresh = true;
        for (const c of wanted) if (h.refs[c] !== null && h.refs[c] !== undefined) (values.get(`${e.src.table}.${c}`) ?? values.set(`${e.src.table}.${c}`, new Map()).get(`${e.src.table}.${c}`)!).set(h.refs[c]!, id);
      }
    }
  }
  return found;
}

/**
 * What the delete of a note made again over a delete this node had not seen takes here, as it took it on every node that took the delete (README 「筆記以同一個 id
 * 重建時」): rows of the bundle for `storeTable`, the one place a merge removes rows. ONE rule for every row that hangs on one of `notes` (rowsHangingOn: every carried
 * table with a cascading key to the note, through rows that hang on rows), judged by what the deleter had SEEN: the `meta.seen` of the note's creation, which carries
 * the tombstone's, and which since migration 240 covers this node's progress of every origin when it deleted, so the writes of the rows that hang on the note,
 * made in transactions of their own (an anchor recovery, a module setting), are in it (store.ts seenByDelete). A row in a chain is judged by the note at its root.
 *   - a row all of whose writes the delete had seen (every head of every unit, this node's and the bundle's) goes with it, as the cascade took it on the deleter:
 *     a row that goes with its note (anchors, paragraph rows, the anchors unit: RowSource.goesWithNote) is `went` (rowsThatGo removes it and its stamps, as for a row
 *     whose note is not here); a row of any other table is `cascaded` (removed; its stamps stay as the deleter's cascade left them, or, when the bundle carries the row,
 *     are merged as for a row that is not here). What hangs on a row that goes, goes with it (the database's cascade), judged as for a row that is not here;
 *   - of a row that goes with its note and stays (a write of it the delete had not seen), the field writes the delete had seen go, as `droppedBySeen` drops them from the
 *     note's own fields (the deleter cleared every stamp of it, so no node keeps them);
 *   - a row the bundle removes anyway (a tombstone it carries: a table whose cascade writes one) is left to the bundle.
 * So a delete the deleter had seen is never sent back to life by `resendRowsOnRemadeNotes`, which runs after this and sends only the rows still here.
 */
async function goneWithTheDelete(workspaceId: string, notes: readonly string[], plans: readonly { src: RowSource; merged: Merged[] }[]): Promise<Map<RowSource, Merged[]>> {
  const out = new Map<RowSource, Merged[]>();
  if (notes.length === 0) return out;
  const seenOf = new Map<string, Record<string, number>>();
  for (const n of notes) seenOf.set(rowId(NOTES, n), seenByDelete(await readUnit(workspaceId, { table: NOTES, row: n, field: STAR })));
  const hanging = await rowsHangingOn(workspaceId, notes);
  const bySource = new Map<RowSource, HeldOnNote[]>();
  for (const h of hanging.values()) (bySource.get(h.src) ?? bySource.set(h.src, []).get(h.src)!).push(h);
  const local = new Map<string, LocalRow>();
  for (const [src, hs] of bySource) for (const [row, l] of await loadLocal(workspaceId, src, hs.map((h) => h.row))) local.set(rowId(src.table, row), l);
  const inBundle = (src: RowSource, row: string) => plans.find((p) => p.src === src)?.merged.find((x) => x.i.row === row);
  const add = (src: RowSource, x: Merged) => (out.get(src) ?? out.set(src, []).get(src)!).push(x);
  // the delete a row is judged by: its note's, or, in a chain, the note's at its root (`parents` are rows found before it)
  const seenAt = (id: string, depth = 0): Record<string, number> | undefined => {
    for (const p of hanging.get(id)?.parents ?? []) { const s = seenOf.get(p) ?? (depth < UNIT_SOURCES.length ? seenAt(p, depth + 1) : undefined); if (s) return s; }
    return undefined;
  };
  const went = new Set<string>();
  for (const [id, h] of hanging) {
    // a row hanging on one that goes goes with it (below; a row that goes with its note is judged by its note)
    if (!h.src.goesWithNote && [...h.parents].some((p) => went.has(p))) continue;
    const l = local.get(id), seen = seenAt(id);
    if (!seen || !l?.state?.star?.length) continue;
    const covered = (c: Cell) => isGenesis(c) || c.stamp.seq <= (seen[c.stamp.origin] ?? -1);
    const carried = inBundle(h.src, h.row);
    if (carried && !carried.m.exists) continue;
    const own = (s: RowState) => [s.star ?? [], ...s.own.values()];
    if ([...own(l.state), ...(carried ? own(carried.i.state) : [])].every((u) => u.every(covered))) {
      went.add(id);
      const m = carried?.m ?? mergeRow(l.state, l.state, clearedOf(h.src));
      if ("rejected" in m) continue;
      const i = carried?.i ?? { row: h.row, values: undefined, state: l.state };
      add(h.src, h.src.goesWithNote ? { i, l, m, went: true } : { i, l, m, cascaded: { carried: !!carried } });
      continue;
    }
    if (!h.src.goesWithNote || ![...l.state.own.values()].some((u) => u.some(covered))) continue;
    const kept: RowState = { ...l.state, own: new Map([...l.state.own].map(([f, u]) => [f, u.filter((c) => !covered(c))] as const).filter(([, u]) => u.length > 0)) };
    const m = mergeRow(kept, carried?.i.state ?? kept, clearedOf(h.src)), before = mergeRow(l.state, l.state, clearedOf(h.src));
    if ("rejected" in m || "rejected" in before) continue;
    add(h.src, { i: carried?.i ?? { row: h.row, values: undefined, state: kept }, l, m: { ...m, before: before.before } });
  }
  for (const [id, h] of hanging) {
    if (went.has(id) || h.src.goesWithNote || ![...h.parents].some((p) => went.has(p))) continue;
    const l = local.get(id);
    if (!l?.state) continue;
    // gone by the cascade before its table is written: what the bundle brings of it (a delete its deleter wrote, say) is merged as for any row that is not here
    const carried = inBundle(h.src, h.row);
    if (carried) { add(h.src, { ...carried, l: { exists: false, state: carried.l.state } }); continue; }
    const m = mergeRow(l.state, l.state, clearedOf(h.src));
    if (!("rejected" in m)) add(h.src, { i: { row: h.row, values: undefined, state: l.state }, l: { exists: false, state: l.state }, m });
  }
  return out;
}

/**
 * The holder's half of a note made again over a permanent delete it had not seen (README 「筆記以同一個 id 重建時，握有掛在它上面的列的節點把它們再送出」).
 * PRECONDITION: inside `applyChangeBundle`, after the bundle's rows are in (what the delete took here is gone: `goneWithTheDelete`) and its clock readings taken.
 * The note itself and every row that hangs on it here (rowsHangingOn: the catalog's cascading keys, through rows that hang on rows) is SENT AGAIN: one new stamp of
 * this node beside the heads of its `*` (unit.ts isResent: it covers nothing, ranks below every other head, nothing follows it). The stamp is above what any node
 * holds of this one, so the next exchange carries the whole row (its units, their heads and values), and a node that dropped those values (it had no note when they
 * came) makes the row, or keeps the heads of the note's own fields it dropped. Nothing of the row changes here or anywhere: what is shown, what a field follows, who
 * made the row are the other heads'. A re-send makes no node send anything: only a creation that is not a re-send says a note was made again, so two holders do not
 * answer each other. Writes only through `storeUnit`.
 */
export async function resendRowsOnRemadeNotes(workspaceId: string, notes: readonly string[]): Promise<{ resent: number }> {
  if (notes.length === 0) return { resent: 0 };
  const hanging = [...(await rowsHangingOn(workspaceId, notes)).values()];
  // the clock reading of the re-send: the latest creation it answers (a function of the replicated state, the same on every node that takes the same bundles)
  const stars = await Promise.all(notes.map((n) => readUnit(workspaceId, { table: NOTES, row: n, field: STAR })));
  const answered = stars.flatMap((u) => (u ?? []).filter((c) => !c.deleted && !isResent(c) && typeof (c.meta as { seen?: unknown } | undefined)?.seen === "object"));
  const latest = answered.reduce<Stamp | null>((a, c) => (!a || compareStamps(c.stamp, a) > 0 ? c.stamp : a), null);
  const stamp = await allocateMergeStamp(workspaceId, latest ?? { wall: 0, counter: 0 });
  const copy: Cell = { stamp, saw: {}, deleted: false, value: STAR_PRESENT, meta: { resent: true } };
  let resent = 0;
  const again = async (src: RowSource, row: string, star: Unit | undefined) => {
    if (!star?.length || star[0]!.deleted) return;
    await storeUnit(workspaceId, addressOfUnit(src, row, STAR), maximalHeads([...star, copy]));
    resent++;
  };
  // the note itself: the writes to its own fields a node dropped while it had no note come back with the row (README, the item of seed 977753)
  for (const n of notes) await again(sourceOf(NOTES), n, await readUnit(workspaceId, { table: NOTES, row: n, field: STAR }));
  const bySource = new Map<RowSource, string[]>();
  for (const h of hanging) (bySource.get(h.src) ?? bySource.set(h.src, []).get(h.src)!).push(h.row);
  for (const [src, rows] of bySource) for (const [row, l] of await loadLocal(workspaceId, src, rows)) await again(src, row, l.state?.star);
  return { resent };
}

/**
 * The checks the database runs at COMMIT (DEFERRED constraint triggers: a note in its parent's space, an anchors unit that is its rows), run NOW, so that a
 * bundle they refuse is refused with a code and a plain reason like every other refusal, and nothing of it is written (the caller's transaction rolls back).
 * Before this, such a bundle failed at COMMIT with the database's own error (23514 and its raw text), and every later bundle carried the same stamps: two nodes
 * stalled for good (mergeSpaceParent.integration.test.ts, PR "fix/merge-space-follows-parent"). The refusal reuses the codes the receiving screen already words
 * (lib/serverSentences.ts): a unique key is `bundle_unique_clash`, any other check `bundle_malformed`.
 */
async function checkDeferredNow(): Promise<void> {
  await snapshotRows(`SET CONSTRAINTS ALL IMMEDIATE`).catch((e: unknown) => {
    const code = (e as { code?: string })?.code, constraint = (e as { constraint?: string })?.constraint;
    if (code === "23505") throw bundleRefused("bundle_unique_clash", `taking the bundle would give two rows one unique key${constraint ? ` (${constraint})` : ""}: nothing was taken`);
    if (code && (MALFORMED_CODES.has(code) || code === "23503" || code === "OD215")) {
      throw bundleRefused("bundle_malformed", `taking the bundle would leave rows that do not hold together${constraint ? ` (${constraint})` : ""}: nothing was taken`, 422);
    }
    throw e;
  });
}


/** The database errors that say a received value is not one the table can hold: check_violation, not_null_violation, invalid_text_representation, numeric_value_out_of_range,
 *  invalid_datetime_format, datetime_field_overflow (a date of the right form that is no day: 2026-02-30), datatype_mismatch, undefined_column, invalid_parameter_value,
 *  string_data_right_truncation, untranslatable_character (a \u0000 in JSON), program_limit_exceeded (a value too large for an index row). Review of PR #1940, round 1, point 3. */
const MALFORMED_CODES: ReadonlySet<string> = new Set(["23514", "23502", "22P02", "22003", "22007", "22008", "42804", "42703", "22023", "22001", "22P05", "54000"]);

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
 * The checks of the received rows (`RowSource.check`, every table), before anything is written: for each row, every value a unit may take (the winner, the row's text or
 * what the stamp of a row the sender does not hold kept, and every other head, each in its unit's place: review of PR #1853, round 7, point 2) is one its column can hold
 * (`columnProblems`) and keeps the table's own rules (`check.row`); a row this node does not hold must have carried values that give the texts the bundle says. Positions
 * are bounded by the length of the body they name when the bundle or this node has that body. A copy that says no value (unit.ts `valueless`) is no value: nothing is
 * checked, shown or written from it (round 8). The database's part is one statement per table and per part of at most CHECK_PART_BYTES (inParts), so a few for a large table.
 */
async function checkReceived(workspaceId: string, items: readonly BundleItem[], plans: readonly { src: RowSource; merged: Merged[] }[]): Promise<RowsReport["rejected"]> {
  const out: RowsReport["rejected"] = [];
  if (!plans.some((p) => p.merged.length)) return out;
  const lengths = new Map<string, number>();
  const known = (text: unknown) => { if (typeof text === "string") lengths.set(sha256Hex(text), text.length); };
  for (const item of items) {
    if (item.kind !== "row" || item.table !== NOTES) continue;
    known(item.texts.body);
    for (const s of item.stamps) if (s.label === NOTES && s.field === "body") for (const h of s.heads) known(h.value);
  }
  const notes = new Set<string>();
  for (const { src, merged } of plans) {
    if (src.check.bodiesOf === "row") for (const { i } of merged) if (isUuid(i.row)) notes.add(i.row);
  }
  if (notes.size) {
    for (const r of (await snapshotRows<{ markdown: string | null }>(`SELECT markdown FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, [...notes]])).rows) known(r.markdown ?? "");
  }
  const bodyLength = (h: string) => lengths.get(h);
  // each row item by its table and row key, once (a search of the whole bundle per new row was quadratic: review of PR #1940, round 1, point 1)
  const rowItems = new Map<string, Extract<BundleItem, { kind: "row" }>>();
  for (const x of items) if (x.kind === "row") for (const st of x.stamps) if (st.label === x.table) rowItems.set(`${x.table}\u0000${st.rowKey}`, x);
  for (const { src, merged } of plans) {
    const values: { row: string; name: string; value: string | null }[] = [];
    const carried: { row: string; values: Record<string, unknown>; wire: Record<string, string | null> }[] = [];
    for (const { i, l } of merged) {
      const texts: Record<string, string | null> = {};
      const heads: { name: string; value: string | null }[] = [];
      for (const [name, cells] of i.state.own) {
        const [win, ...rest] = cells;
        if (win && !win.deleted && !win.valueless) texts[name] = (win.value ?? null) as string | null;
        for (const c of rest) if (!c.deleted && !c.valueless) heads.push({ name, value: (c.value ?? null) as string | null });
      }
      if (i.values) for (const [name, v] of i.state.creation) if (!(name in texts)) texts[name] = v;
      let reason = src.check.row({ texts, values: i.values, bodyLength });
      for (const h of heads) if (!reason) reason = src.check.row({ texts: { [h.name]: h.value }, values: undefined, bodyLength });
      if (reason) { out.push({ row: i.row, reason: "malformed", table: src.label, unit: reason }); continue; }
      for (const [name, value] of Object.entries(texts)) values.push({ row: i.row, name, value });
      for (const h of heads) values.push({ row: i.row, ...h });
      if (i.values && !l.exists) {
        const rowItem = rowItems.get(`${src.table}\u0000${i.row}`);
        carried.push({ row: i.row, values: i.values, wire: rowItem?.texts ?? {} });
      }
    }
    const problem = await columnProblems(src, values);
    if (problem) { out.push({ row: problem.row, reason: "malformed", table: src.label, unit: problem.why }); continue; }
    const differs = await carriedValuesDiffer(src, carried);
    if (differs) out.push({ row: differs, reason: "malformed", table: src.label, unit: "the row's values are not the units the bundle says" });
  }
  return out;
}

/** A new row's carried values give the texts the bundle says, unit by unit (sync_logged_value over the row they make): the row that does not, or null. One statement per part (inParts). */
async function carriedValuesDiffer(src: RowSource, carried: readonly { row: string; values: Record<string, unknown>; wire: Record<string, string | null> }[]): Promise<string | null> {
  for (const part of inParts(carried, (c) => c.values)) {
    // in a savepoint: a value that fails its cast must not leave the bundle's transaction aborted (the next statement would fail with 25P02, a raw error: review of PR #1940, round 1, point 3)
    const said = await withSavepoint(() => snapshotRows<{ n: number; t: Record<string, string | null> }>(
      `SELECT e.n::int AS n, ${unitTextsSql(src, "r")} AS t FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS e(v, n), LATERAL jsonb_populate_record(NULL::${quote(src.table)}, e.v) r`,
      [part.json])).catch((e: unknown) => { if (MALFORMED_CODES.has((e as { code?: string })?.code ?? "")) return null; throw e; });
    // values the table cannot hold (a text that is not of its column's type): the first row is named, the whole bundle is refused either way
    if (!said) return part.items[0]!.row;
    const byN = new Map(said.rows.map((r) => [r.n, r.t] as const));
    for (const [k, c] of part.items.entries()) {
      const t = byN.get(k + 1);
      if (!t || Object.keys(src.fields).some((f) => Object.hasOwn(c.wire, f) && (t[f] ?? null) !== (c.wire[f] ?? null))) return c.row;
    }
  }
  return null;
}

/** How many bytes of JSON (UTF-8, as the statement sends it) one statement of the checks takes at most: a large honest bundle (an offline import of thousands of notes with
 *  their bodies) is checked in parts, so no statement comes near the statement timeout, jsonb's size limit or a PGlite's memory (review of PR #1940, round 1, point 1).
 *  One item larger than this is a part of its own. */
const CHECK_PART_BYTES = 4_000_000;
/** `xs` in consecutive parts of at most CHECK_PART_BYTES of UTF-8 JSON each (by `json(x)`), each with the JSON array of its items: the order is kept, so a part's ordinal
 *  names its item. Made one at a time, as the caller asks for the next, so only one part's JSON is held beside the bundle (review of PR #1940, round 2: the count was in
 *  UTF-16 units, 4 M of them up to 12 MB of Chinese, and every part was built before the first was sent). */
function* inParts<T>(xs: readonly T[], json: (x: T) => unknown): Generator<{ items: T[]; json: string }> {
  let items: T[] = [], texts: string[] = [], bytes = 0;
  for (const x of xs) {
    const t = JSON.stringify(json(x));
    const size = Buffer.byteLength(t, "utf8");
    if (items.length && bytes + size > CHECK_PART_BYTES) { yield { items, json: `[${texts.join(",")}]` }; items = []; texts = []; bytes = 0; }
    items.push(x); texts.push(t); bytes += size + 1;
  }
  if (items.length) yield { items, json: `[${texts.join(",")}]` };
}

type ColumnRules = { notNull: ReadonlySet<string>; jsonb: ReadonlySet<string>; checks: readonly { columns: readonly string[]; expr: string }[] };
const columnRulesCache = new Map<string, ColumnRules>();
/** What the database itself requires of the columns of `table`: which are NOT NULL, which are jsonb, and each CHECK constraint with the columns it reads. */
async function columnRulesOf(table: string): Promise<ColumnRules> {
  const hit = columnRulesCache.get(table);
  if (hit) return hit;
  const cols = (await snapshotRows<{ name: string; not_null: boolean; jsonb: boolean }>(
    `SELECT attname::text AS name, attnotnull AS not_null, atttypid = 'jsonb'::regtype AS jsonb FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`, [quote(table)])).rows;
  const checks = (await snapshotRows<{ columns: string[]; def: string }>(
    `SELECT array(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)) AS columns, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'c' ORDER BY c.conname`, [quote(table)])).rows;
  const rules: ColumnRules = {
    notNull: new Set(cols.filter((c) => c.not_null).map((c) => c.name)), jsonb: new Set(cols.filter((c) => c.jsonb).map((c) => c.name)),
    checks: checks.map((c) => ({ columns: c.columns, expr: c.def.replace(/^CHECK /, "").replace(/ NOT VALID$/, "") })),
  };
  columnRulesCache.set(table, rules);
  return rules;
}

/**
 * Whether each value is one its unit's column can hold, as THIS database says (so the rule cannot drift from the schema): of the column's type, not NULL where the column
 * is NOT NULL, and true (or unknown) for each CHECK of the table that reads only that unit's columns (a CHECK over other columns too, such as a reference's one holder, is
 * the row's, which the write itself meets). A `deleted` unit is the text 'true' or 'false' (its column is the time, set by the merge); a composite's text is the JSON object
 * of its columns, no other key; a JSON key's value is JSON, an element of a set the JSON string of the element. One statement per part (inParts).
 * The values a winner of an existing row brings were checked by the database at its write; a head's never were, until it won.
 */
async function columnProblems(src: RowSource, values: readonly { row: string; name: string; value: string | null }[]): Promise<{ row: string; why: string } | null> {
  if (!values.length) return null;
  const rules = await columnRulesOf(src.table);
  const records: { row: string; record: Record<string, unknown>; columns: string[] }[] = [];
  for (const { row, name, value } of values) {
    const json = jsonSourcesOf(src).find((j) => name.startsWith(`${j.label}:`));
    if (json) {
      if (value === null) continue; // a key that is not there
      let v: unknown;
      try { v = JSON.parse(value); } catch { return { row, why: `a key of ${json.label} whose value is not JSON` }; }
      if (json.shape === "set" && v !== name.slice(json.label.length + 1 + json.prefix.length)) return { row, why: `an element of ${json.label} that is not the element it names` };
      continue;
    }
    const column = src.fields[name];
    if (!column) continue;
    if (name === "deleted") {
      if (value !== "true" && value !== "false") return { row, why: `a ${src.label} deleted state that is neither true nor false` };
      continue;
    }
    const columns = column.split("+");
    let record: Record<string, unknown>;
    if (columns.length > 1) {
      if (value === null) return { row, why: `a ${src.label} ${name} that is not an object of its columns` };
      let o: unknown;
      try { o = JSON.parse(value); } catch { return { row, why: `a ${src.label} ${name} that is not JSON` }; }
      if (typeof o !== "object" || o === null || Array.isArray(o) || Object.keys(o).some((k) => !columns.includes(k))) return { row, why: `a ${src.label} ${name} that is not an object of its columns` };
      record = o as Record<string, unknown>;
    } else if (value === null) record = { [column]: null };
    else if (rules.jsonb.has(column)) {
      try { record = { [column]: JSON.parse(value) as unknown }; } catch { return { row, why: `a ${src.label} ${name} that is not JSON` }; }
    } else record = { [column]: value };
    for (const c of columns) if (rules.notNull.has(c) && (record[c] === null || record[c] === undefined)) return { row, why: `a ${src.label} ${name} that is empty where its column is never empty` };
    records.push({ row, record, columns });
  }
  if (!records.length) return null;
  // each CHECK whose columns are all among the record's: evaluated over the record, the alias the table's own name so that the constraint's bare columns name its fields
  const alias = quote(src.table);
  // (the item's own names are ones no table has, so a CHECK's bare column always names the record's field)
  const columnsOf = (c: { columns: readonly string[] }) => `ARRAY[${c.columns.map((x) => `'${x.replaceAll("'", "''")}'`).join(", ")}]::text[]`;
  const tests = rules.checks.map((c) => `(NOT ($2::jsonb -> (onden_item.onden_n::int - 1)) ?& ${columnsOf(c)} OR (${c.expr}) IS NOT FALSE)`);
  for (const part of inParts(records, (r) => r.record)) {
    const failed = await withSavepoint(() => snapshotRows<{ n: number }>(
      `SELECT onden_item.onden_n::int AS n FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS onden_item(onden_v, onden_n), LATERAL jsonb_populate_record(NULL::${alias}, onden_item.onden_v) AS ${alias}
        WHERE NOT (${tests.length ? tests.join(" AND ") : "true"}) ORDER BY onden_item.onden_n LIMIT 1`,
      [part.json, JSON.stringify(part.items.map((r) => r.columns))])).catch((e: unknown) => {
      if (MALFORMED_CODES.has((e as { code?: string })?.code ?? "")) return "cast" as const;
      throw e;
    });
    if (failed === "cast") return { row: part.items[0]!.row, why: `a value of ${src.label} that is not of its column's type` };
    const n = failed.rows[0]?.n;
    if (n !== undefined) return { row: part.items[n - 1]!.row, why: `a value of ${src.label} that a check of the table refuses` };
  }
  return null;
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
  return live.filter((x) => { const note = noteOf(x); return x.went || note === null || !held.has(note); }).map((x) => {
    const { i, l, m } = x;
    // a row this node already holds only as its stamps, and the merge changes none of them: nothing to write (a bundle sent again changes nothing, round 9, point 5 d)
    const changed = l.exists || !l.state || m.starChanged || ![...new Set([...m.fields.keys(), ...m.before.keys()])].every((f) => canonical(m.fields.get(f) ?? null) === canonical(m.before.get(f) ?? null));
    return { x, changed, moved: !!src.fields.note && (i.state.own.has("note") || !!l.state?.own.has("note")) };
  });
}

/** A failure of the database that says a row names a row this node does not hold (a foreign key). */
const isMissingReference = (e: unknown): boolean => (e as { code?: string })?.code === "23503";

async function storeTable(workspaceId: string, src: RowSource, given: readonly Merged[], tree: TreeWork): Promise<RowsReport> {
  const report = emptyReport();
  const notes = src.label === NOTES;
  const address = (row: string, name: string) => addressOfUnit(src, row, name);
  const match = (row: string) => rowMatchOf(src, [row]);
  // a row the delete of a note made again had seen all of (goneWithTheDelete `cascaded`) is removed as the deleter's cascade removed it, before anything else; what the
  // bundle carries of it is then merged as for a row that is not here, and a row it does not carry keeps its stamps as they are (as on the deleter)
  const cascaded = new Set(given.filter((x) => x.cascaded).map((x) => x.i.row));
  for (const { i, l } of given.filter((x) => x.cascaded && x.l.exists)) {
    const params: unknown[] = [workspaceId];
    await snapshotRows(`DELETE FROM ${quote(src.table)} t WHERE ${match(i.row).match("t", params)} AND ${match(i.row).workspace("t", "$1")}`, params);
    report.removed++;
  }
  const merged = given.filter((x) => !x.cascaded || x.cascaded.carried).map((x) => (x.cascaded ? { ...x, l: { exists: false, state: x.l.state } } : x));
  const isJson = (name: string) => address("x", name).table !== src.label;
  const lines: StructureLine[] = [];
  /** The units of a row's own table other than its `*` (not the keys of its JSON columns: other labels), gone: what a row that is not on this node keeps of its
   *  fields (nothing; they follow `*`). The delete trigger does the same on the node that removes the row (sync_stamp_trigger, migration 205). */
  const dropFieldUnits = async (row: string): Promise<void> => {
    for (const t of ["sync_stamps", "sync_stamp_heads"]) await snapshotRows(`DELETE FROM ${t} WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field <> '*'`, [workspaceId, src.label, row]);
  };
  // Removals first: a note that goes frees its slug for a note that comes (see below), and a parent that goes empties its children's parent column the way the database does
  // (each unit it empties keeps the id on its stamp: migration 215 sync_keep_emptied_id)
  for (const { i, l, m } of merged) {
    if (m.exists || !l.exists || !src.rows) continue;
    const win = m.star[0]!;
    // the row is gone for good: its units go with it (the delete trigger does the same; the keys of its JSON columns stay as stamps, below), and the log says what became of a note
    const gone = textOf(m.before.get("deleted")) ?? "false";
    await dropFieldUnits(i.row);
    const params: unknown[] = [workspaceId];
    // a note that goes leaves the notes under it at the top here (the foreign key empties their parent): their space is derived again
    if (notes) tree.seeds.push(...(await snapshotRows<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND parent_id = $2::uuid`, [workspaceId, i.row])).rows.map((r) => r.id));
    // and so do the notes a cut of a loop put back under it (their parent after the cut is something else now: review of PR #1907, round 2, point 3)
    if (notes) tree.seeds.push(...await cutBackUnder(workspaceId, [i.row]));
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
    if (went.has(i.row) || cascaded.has(i.row)) continue;
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
  // SKIP_LOCKED: the lock is held until the transaction ends, and a table another transaction is analyzing is about to have new statistics (db.ts large writes).
  if (report.created >= ANALYZE_AFTER_ROWS) await snapshotRows(`ANALYZE (SKIP_LOCKED) ${quote(src.table)}`);
  for (const { i, l, m } of merged) {
    if (went.has(i.row)) continue;
    const win = m.star[0]!;
    const creation = new Set(m.star.map((h) => stampKey(h.stamp)));
    const here = l.exists || madeHere.has(i.row) || !src.rows;
    // what the merge says changed is said of a row that is here (round 9, point 5 b: not of a row that went with its note, nor of one this node does not make)
    if (here) for (const e of m.events) report.events.push({ address: address(i.row, e.field), result: { ...e.result, deferred: [] } });
    // a row this node does not hold keeps its writes' values only where they go with a note (ids; round 9, point 2): another table's row hanging on a note or space
    // deleted for good here keeps no value, and of its own table's units only its `*`: every field follows the creation, as on a node that removed the row (the
    // delete trigger and the removals above, `dropFieldUnits`). A node without the row cannot tell which field units a node with it keeps (storeUnit drops a creation
    // value equal to the winner's, and a copy without values equals nothing), so "none" is the one shape every node can reach (README 「沒有那一列的欄位跟著 `*`」).
    // The keys of its JSON columns are units of their own and stay, as copies without their values.
    const keeps = !here && !!src.goesWithNote;
    const followsStar = (f: string) => !here && !keeps && !isJson(f);
    const shape = (u: Unit | undefined): Unit | undefined => (u && !here && !keeps ? withoutValues(u) : u);
    const fresh = madeHere.has(i.row) && !l.state; // made here from the carried values, nothing of it held before: only stamps to write (storeUnit)
    if (m.exists) {
      // a unit that counts as an edit was written to a row that was here: only then can `updated_at` change (a row made here carries the sender's `updated_at`, which is
      // the same function of the same stamps). It counts when it brings a write this node did not hold that is no housekeeping (`meta.quiet`, migrations 206 and 232)
      let counted = false;
      const touches = Object.hasOwn(UPDATED_AT_OF_STAMPS, src.table);
      const counts = (f: string, after: Unit, prior: Unit | undefined) =>
        touches && l.exists && (!isJson(f) || f.startsWith(`${UPDATED_AT_OF_STAMPS[src.table]}:`)) && !NOT_AN_EDIT_FIELDS.includes(f)
        && after.some((c) => (c.meta as { quiet?: boolean } | undefined)?.quiet !== true && c.stamp.origin !== GENESIS_STAMP_ORIGIN
          && !(prior ?? []).some((p) => stampKey(p.stamp) === stampKey(c.stamp)));
      if (!l.state || m.starChanged) { await storeUnit(workspaceId, address(i.row, STAR), m.star, undefined, fresh); report.stored++; }
      if (notes && l.exists && remadeOverUnseenDelete(l.state, m.star)) report.remade.push(i.row);
      // the same row made twice (two nodes made the same id, or this node still holds a row that another deleted and made again): the creation that wins is the row, on every node
      const from = carriedFrom(src, { i, l, m });
      if (from.overwrite) await overwriteCarriedColumns(src.table, workspaceId, match(i.row), i.values!, [...replicatedColumnsOf(src), ...(notes ? ["order_stamp", "slug"] : [])]);
      // what this node stored of such a row before (a field unit written by an older version of this rule) goes, with no unit written in its place
      if (l.state && [...l.state.own.keys()].some(followsStar)) await dropFieldUnits(i.row);
      for (const f of new Set([...m.fields.keys(), ...m.before.keys()])) {
        if (followsStar(f)) continue;
        const after = m.fields.get(f), prior = m.before.get(f);
        const a = address(i.row, f);
        if (!after) { // no cell is left for it (cannot happen while a creation gives every field a value): nothing of its own is kept
          await snapshotRows(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, [workspaceId, a.table, i.row, a.field]);
          await snapshotRows(`DELETE FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, [workspaceId, a.table, i.row, a.field]);
          continue;
        }
        if ((here && !l.exists) || m.starChanged || !prior || canonical(shape(after)) !== canonical(prior)) {
          await storeUnit(workspaceId, a, shape(after)!, creation, fresh, keeps); report.stored++;
          if (counts(f, after, prior)) counted = true;
        }
      }
      // What the write path derives from a unit travels with the unit that won: the slug of a title, the time a note was deleted; `updated_at` of a note that is only touched is a function of the stamps (sync_touch_updated_at); a creation that wins brings its own
      if (l.exists && i.values) await followCarriedColumns(src.table, workspaceId, match(i.row), i.values, from.copy.filter((c) => c !== "slug"), []);
      if (counted) await snapshotRows(`SELECT sync_touch_row_updated_at($1::uuid, $2, $3)`, [workspaceId, src.table, i.row]); // updated_at is a function of the stamps now written
      if (notes && here) {
        for (const f of STRUCTURE_FIELDS) {
          const before = l.exists ? textOf(m.before.get(f)) : null, now = textOf(m.fields.get(f));
          if (!l.exists || before !== now) { lines.push({ row: i.row, field: f, from: before, to: now, stamp: (m.fields.get(f)?.[0] ?? win).stamp }); report.structureLines++; }
        }
      }
    } else {
      if (!l.state || m.starChanged) { await storeUnit(workspaceId, address(i.row, STAR), m.star); report.stored++; }
      // a row deleted for good keeps only its `*` of its own table here too (the removals above did it for a row that was here; this is one that was not)
      if (!l.exists && l.state && [...l.state.own.keys()].some((f) => !isJson(f))) await dropFieldUnits(i.row);
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
    const restoredNames = new Map((await snapshotRows<{ id: string; title: string; node_type: string; slug: string; reserved_key: string | null }>(
      `SELECT id::text, title, node_type, slug, reserved_key FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, slugRows.filter((x) => x.l.exists).map((x) => x.i.row)])).rows
      .map((r) => [r.id, { ...r, slug: originalSlug.get(r.id) ?? r.slug }] as const));
    const views = await orphansOf(workspaceId, merged);
    report.orphaned = views.fixes; report.notices = views.notices;
    // the slugs are given after the notes' spaces are derived (storeMergedRows): a slug is unique among the live notes of a space
    for (const x of slugRows) {
      const c = carriedFrom(src, x);
      if (!x.l.exists || c.overwrite || c.copy.includes("slug")) { tree.slugs.set(x.i.row, String(x.i.values?.slug)); continue; }
      // a restore wants the slug its title gives (services/nodeTrash.ts markLive), as where it was written; settleSlugs gives way where that is taken (batch 4a)
      const wrote = (f: string) => x.m.events.some((e) => e.field === f && e.result.write);
      const restored = wrote("deleted") && textOf(x.m.before.get("deleted")) === "true" && textOf(x.m.fields.get("deleted")) === "false";
      const named = restored ? restoredNames.get(x.i.row) : undefined;
      tree.slugs.set(x.i.row, named ? slugFor(named, named.title) : originalSlug.get(x.i.row)!);
    }
    for (const x of merged) if (x.m.exists && !went.has(x.i.row) && (x.l.exists || madeHere.has(x.i.row))) tree.seeds.push(x.i.row);
    for (const id of madeHere) tree.made.add(id);
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
    // its creation, and the write that put it under that parent (the creation, or a move)
    notes.push({ id: x.i.row, parent: parent && dead.has(parent) ? parent : null, created: x.m.star.find((c) => !c.deleted)?.stamp ?? x.m.fields.get("parent")![0]!.stamp, placed: x.m.fields.get("parent")![0]!.stamp, deleted: null });
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

// ── the space a note is in, after a merge ─────────────────────────────────────────────────────────────────────────────
// The database half of ./rules/space.ts (migration 218). The `space` unit is the space a person WROTE for a note
// (content_nodes.written_space_id); the space a note IS in (content_nodes.space_id) is derived: the written space of its top ancestor, over the merged parents with
// the 4.10 cut of loops (./rules/moveCycle.ts). Called by `storeMergedRows` LAST, after every table of the bundle is in, for every note the bundle bears
// on and every note under them (rows that are not in the bundle included), so the deferred content_nodes_check_space holds on the stored columns at COMMIT.
//
// What is written, and what is not:
//   space_id      the derived space, for every note whose derived space differs from what is stored. Never a unit, never stamped: a merge makes no stamp.
//   slug          a note whose space changes holds a name no note has (~ and its id) until the caller gives every note of the bundle its slug (assignSlugs):
//                 a slug is unique among the live notes of a space.
//   structure_log a line per note whose space changed (for a note made here: the space it is made in), with the stamp of the write that decided it (the top
//                 note's `space` write, else its creation). This node's own history: the log never leaves a device.
//   the epoch     bumped once when a note this node held changed space (who can read it changed): this node's own; workspaces.membership_epoch is no unit.
//   the cut       nowhere: parent_id keeps the parent as merged (a loop included). README "合併從不重新編號": a merge never writes a repair back as data.

type Loaded = SpaceTreeRow & { space: string | null; slug: string };
type SpaceLine = { row: string; field: string; from: string | null; to: string | null; stamp: Stamp };
/** A note whose space a merge changed because of where its tree is (it was not written for it). */
type FollowedSpace = { note: string; from: string | null; to: string | null };

/** The stamp a placement about to be written (NoteTree `placed`) counts with: later than every stamp already held, as the write will be. */
const PLACED_NOW: Stamp = { origin: "~placed", seq: Number.MAX_SAFE_INTEGER, wall: Number.MAX_SAFE_INTEGER, counter: 0, author: null, device: null };
const GENESIS: Stamp = { origin: GENESIS_STAMP_ORIGIN, seq: 0, wall: 0, counter: 0, author: null, device: null };

async function loadRows(workspaceId: string, ids: readonly string[], into: Map<string, Loaded>, absent: Set<string>): Promise<string[]> {
  const want = [...new Set(ids)].filter((id) => !into.has(id) && !absent.has(id));
  if (!want.length) return [];
  const r = await snapshotRows<{ id: string; parent: string | null; written: string | null; tag: boolean; space: string | null; slug: string }>(
    `SELECT id::text, parent_id::text AS parent, written_space_id::text AS written, ${tagNodeSql()} AS tag, space_id::text AS space, slug
       FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, want]);
  for (const x of r.rows) into.set(x.id, x);
  for (const id of want) if (!into.has(id)) absent.add(id);
  return r.rows.map((x) => x.id);
}

/** Every ancestor of the rows loaded so far, one level per statement (a tree is shallow; a loop ends because a loaded row is not loaded again). */
async function loadAncestors(workspaceId: string, rows: Map<string, Loaded>, absent: Set<string>): Promise<void> {
  for (let next = [...rows.values()].map((r) => r.parent).filter((p): p is string => p !== null); next.length;) {
    const got = await loadRows(workspaceId, next, rows, absent);
    next = got.map((id) => rows.get(id)!.parent).filter((p): p is string => p !== null);
  }
}

/** The winning parent write of each note: its stamp and where the note was before (`meta.from`); a parent that follows the creation is the creation's (no `from`). */
async function parentLinks(workspaceId: string, ids: readonly string[]): Promise<Map<string, ParentLink>> {
  const out = new Map<string, ParentLink>();
  if (!ids.length) return out;
  const r = (await snapshotRows<StampRow & { row_key: string; field: string }>(
    `SELECT row_key, field, ${STAMP_COLS} FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND field IN ('parent', '*') AND row_key = ANY($2::text[])`,
    [workspaceId, [...ids]])).rows;
  const byKey = new Map(r.map((x) => [`${x.row_key} ${x.field}`, x] as const));
  for (const id of ids) {
    const own = byKey.get(`${id} parent`), star = byKey.get(`${id} *`);
    const from = (own?.meta as { from?: string | null } | null | undefined)?.from;
    out.set(id, { note: id, parent: null, ...(own && from !== undefined ? { from } : {}), stamp: own ? stampOf(own) : star ? stampOf(star) : GENESIS });
  }
  return out;
}

/**
 * Notes as the tree sees them, loaded with every ancestor; when a loop is among them, every loaded note's winning parent write (a cut can close another loop), and
 * every former parent a cut puts a note back under, with ITS ancestors, until nothing a cut names is missing (rules/space.ts cutParents `missing`). `parents` is then
 * a function of the replicated rows alone, whatever was loaded first (review of PR #1907, round 1, point 2).
 */
class NoteTree {
  readonly rows = new Map<string, Loaded>();
  private readonly absent = new Set<string>();
  private readonly links = new Map<string, ParentLink>();
  parents = new Map<string, string | null>();
  private readonly storedParent = new Map<string, string | null>();
  /** `placed`: notes whose parent is taken as given, not as stored: a local write about to put them there (a move to another space detaches its root, and the
   *  notes it takes are the ones under the root AFTER that write; review of PR #1907, round 2, point 1). Such a placement is the newest write of its `parent`. */
  constructor(readonly workspaceId: string, private readonly placed: ReadonlyMap<string, string | null> = new Map()) {}
  private place(): void {
    for (const [id, parent] of this.placed) {
      const r = this.rows.get(id);
      if (r && !this.storedParent.has(id)) { this.storedParent.set(id, r.parent); this.rows.set(id, { ...r, parent }); }
    }
  }
  async add(ids: readonly string[]): Promise<void> {
    await loadRows(this.workspaceId, ids, this.rows, this.absent);
    this.place();
    await loadAncestors(this.workspaceId, this.rows, this.absent);
    for (let round = 0; ; round++) {
      if (!notesOnLoops(this.rows).length) { this.parents = cutParents(this.rows, () => { throw new Error("no loop: no parent write is asked for"); }).parents; return; }
      const lacking = [...this.rows.keys()].filter((id) => !this.links.has(id));
      for (const [id, l] of await parentLinks(this.workspaceId, lacking)) {
        this.links.set(id, this.storedParent.has(id) ? { note: id, parent: null, from: this.storedParent.get(id) ?? null, stamp: PLACED_NOW } : l);
      }
      const cut = cutParents(this.rows, (id) => this.links.get(id)!);
      const more = cut.missing.filter((id) => !this.rows.has(id) && !this.absent.has(id));
      if (!more.length || round > this.rows.size) { this.parents = cut.parents; return; }
      await loadRows(this.workspaceId, more, this.rows, this.absent);
      this.place();
      await loadAncestors(this.workspaceId, this.rows, this.absent);
    }
  }
  loopMembers(): string[] { return notesOnLoops(this.rows); }
  /** The note a cut put `id` back under when that note is not here (gone for good): the cut leaves `id` with no parent. */
  cutBackToAbsent(id: string): string | null {
    const from = this.rows.get(id)?.parent !== null && this.parents.get(id) === null ? this.links.get(id)?.from ?? null : null;
    return from !== null && !this.rows.has(from) ? from : null;
  }
}

/**
 * `roots` and every note whose parent, as the space follows it (the merged parent after the 4.10 cut), leads to one of them: the ONE definition of "the notes under
 * a note", used by the merge's derivation and by a move to another space (services/spaces.ts moveToSpace; review of PR #1907, round 1, point 1: both followed the
 * stored parent_id, so a note a cut puts back under a moved note stayed behind, and the next bundle that touched it was refused at COMMIT for good). A note can have
 * a root as that parent by its stored parent, or because a cut puts it back under its former parent (its winning parent write's `meta.from`). `withLoops`: every note
 * on a loop among the notes looked at counts as a root too (a bundle that closes or opens a loop changes the parent of a note it did not write).
 */
async function effectiveSubtree(tree: NoteTree, roots: readonly string[], withLoops: boolean): Promise<Set<string>> {
  await tree.add(roots);
  const inSet = new Set(roots.filter((id) => tree.rows.has(id)));
  const grow = (): string[] => {
    const added: string[] = [];
    if (withLoops) for (const id of tree.loopMembers()) if (!inSet.has(id)) { inSet.add(id); added.push(id); }
    for (let more = true; more;) {
      more = false;
      for (const id of tree.rows.keys()) if (!inSet.has(id) && inSet.has(tree.parents.get(id) ?? "")) { inSet.add(id); added.push(id); more = true; }
    }
    return added;
  };
  for (let frontier = [...inSet, ...grow()]; frontier.length;) {
    const candidates = (await snapshotRows<{ id: string }>(
      `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND parent_id = ANY($2::uuid[])
       UNION SELECT row_key FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND field = 'parent' AND meta ? 'from' AND meta->>'from' = ANY($3::text[])`,
      [tree.workspaceId, frontier, frontier])).rows.map((r) => r.id).filter((id) => !inSet.has(id));
    if (!candidates.length) break;
    await tree.add(candidates);
    frontier = grow();
  }
  return inSet;
}

/**
 * The notes a move of `rootId` to another space takes with it: the note and every note under it as its space follows it (`effectiveSubtree`), root first, tags left
 * out (a tag definition has no space). `parentAfter`: the root's parent after the move (it is detached, or re-attached by an undo): the notes under it are counted
 * in the tree as it will be, not as it is (a loop the root is on is opened by the move itself). services/spaces.ts moveToSpace and its preview call this, so the
 * move and every node that takes it agree (I2).
 */
export async function notesMovedWith(workspaceId: string, rootId: string, parentAfter: string | null): Promise<string[]> {
  const tree = new NoteTree(workspaceId, new Map([[rootId, parentAfter]]));
  const set = await effectiveSubtree(tree, [rootId], false);
  if (!set.has(rootId)) return [];
  return [rootId, ...[...set].filter((id) => id !== rootId && !tree.rows.get(id)!.tag).sort()];
}

/**
 * Derive content_nodes.space_id for `seeds` (the notes of the bundle that are here after it, and the notes that lost their parent row to it), the notes of any loop
 * among them, and every note under them (`effectiveSubtree`). `made`: the notes this bundle made here (their line says the space they are made in). `slugs`: the slug
 * each note must end with, by id; a note whose space changes here and has no entry gets its own slug back (the caller assigns them all). PRECONDITION: inside
 * `storeMergedRows`, triggers standing aside.
 */
/**
 * The notes left without their parent because it went for good, and the space that parent was shown in when it went (its tombstone's `meta.space`, migration 218
 * section 8; review of PR #1907, round 3, point 1). Such a note is at the top, and it is in THAT space: the space once written for it is old (it was under a
 * parent, and an ancestor's move does not rewrite it), so a purge of another note does not move it to a space it was not in. Left without its parent: its parent
 * column was emptied by the foreign key (its `parent` stamp keeps the id, migration 215), or a cut of a loop puts it back under the note that went. A parent
 * with no such tombstone (a tag, a note this node never held) leaves the note with its own written space.
 */
async function orphanedInto(workspaceId: string, nodeTree: NoteTree): Promise<Map<string, string>> {
  const rows = nodeTree.rows;
  const formerParent = new Map<string, string>();
  for (const id of rows.keys()) { const p = nodeTree.cutBackToAbsent(id); if (p) formerParent.set(id, p); }
  const emptied = [...rows].filter(([id, r]) => r.parent === null && !r.tag && !formerParent.has(id)).map(([id]) => id);
  if (emptied.length) {
    for (const r of (await snapshotRows<{ id: string; p: string }>(
      `SELECT row_key AS id, kept_value->>'text' AS p FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND field = 'parent' AND row_key = ANY($2::text[]) AND kept_value ? 'text'`,
      [workspaceId, emptied])).rows) if (r.p && !rows.has(r.p)) formerParent.set(r.id, r.p);
  }
  if (!formerParent.size) return new Map();
  const shown = new Map((await snapshotRows<{ id: string; space: string }>(
    `SELECT row_key AS id, meta->>'space' AS space FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND field = '*' AND deleted AND row_key = ANY($2::text[]) AND meta ? 'space'`,
    [workspaceId, [...new Set(formerParent.values())]])).rows.map((r) => [r.id, r.space] as const));
  const out = new Map<string, string>();
  for (const [id, p] of formerParent) { const sp = shown.get(p); if (sp) out.set(id, sp); }
  return out;
}

/** The space of every note of `affected` (rules/space.ts spacesOfTree over the tree after the cut), and the ones whose stored space_id differs, sorted. */
async function derivedSpaces(workspaceId: string, nodeTree: NoteTree, affected: ReadonlySet<string>): Promise<{ spaces: Map<string, string | null>; changed: string[] }> {
  const orphans = await orphanedInto(workspaceId, nodeTree);
  const rows = new Map([...nodeTree.rows].map(([id, r]) => [id, orphans.has(id) ? { ...r, written: orphans.get(id)! } : r] as const));
  const fallback = (await snapshotRows<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default LIMIT 1`, [workspaceId])).rows[0]?.id ?? null;
  // a written space this node does not hold counts as none written (the default space): the same answer on every node that holds the same rows
  const named = [...new Set([...rows.values()].map((r) => r.written).filter((w): w is string => w !== null))];
  const held = new Set((await snapshotRows<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, named])).rows.map((r) => r.id));
  const tree = new Map([...rows].map(([id, r]) => [id, { ...r, written: r.written !== null && held.has(r.written) ? r.written : null }] as const));
  const spaces = spacesOfTree(tree, nodeTree.parents, fallback);
  return { spaces, changed: [...affected].filter((id) => (spaces.get(id) ?? null) !== rows.get(id)!.space).sort() };
}

/** The notes whose winning `parent` write was made FROM one of `ids` (`meta.from`): the notes a cut of a loop puts back under one of them. When such a note goes
 *  for good, they are under something else after the cut (review of PR #1907, round 2, point 3). */
async function cutBackUnder(workspaceId: string, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  return (await snapshotRows<{ id: string }>(
    `SELECT row_key AS id FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND field = 'parent' AND meta ? 'from' AND meta->>'from' = ANY($2::text[])`,
    [workspaceId, [...ids]])).rows.map((r) => r.id);
}

async function deriveNoteSpaces(workspaceId: string, seeds: readonly string[], made: ReadonlySet<string>, slugs: Map<string, string>): Promise<{ lines: SpaceLine[]; followed: FollowedSpace[] }> {
  if (!seeds.length) return { lines: [], followed: [] };
  const nodeTree = new NoteTree(workspaceId);
  const affected = await effectiveSubtree(nodeTree, [...new Set(seeds)], true);
  const rows = nodeTree.rows;
  const parents = nodeTree.parents;
  const { spaces, changed } = await derivedSpaces(workspaceId, nodeTree, affected);
  if (changed.length) {
    for (const id of changed) if (!slugs.has(id)) slugs.set(id, rows.get(id)!.slug);
    await snapshotRows(
      `UPDATE content_nodes c SET space_id = v.space, slug = '~' || c.id::text FROM unnest($2::uuid[], $3::uuid[]) AS v(id, space) WHERE c.workspace_id = $1 AND c.id = v.id`,
      [workspaceId, changed, changed.map((id) => spaces.get(id) ?? null)]);
  }
  // the line of each note whose space changed or that was made here, with the stamp of the write that decided it: the top note's `space` write, else its creation
  const logged = [...new Set([...changed, ...[...made].filter((id) => affected.has(id) && !rows.get(id)!.tag)])].sort();
  const topOf = (id: string): string => { let n = id; for (let i = 0; i <= rows.size; i++) { const p = parents.get(n) ?? null; if (p === null || rows.get(p)?.tag) return n; n = p; } return n; };
  const tops = [...new Set(logged.map(topOf))];
  const deciding = new Map<string, Stamp>();
  if (tops.length) {
    const r = (await snapshotRows<StampRow & { row_key: string; field: string }>(
      `SELECT row_key, field, ${STAMP_COLS} FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND field IN ('space', '*') AND row_key = ANY($2::text[])`, [workspaceId, tops])).rows;
    const byKey = new Map(r.map((x) => [`${x.row_key} ${x.field}`, x] as const));
    for (const t of tops) { const s = byKey.get(`${t} space`) ?? byKey.get(`${t} *`); deciding.set(t, s ? stampOf(s) : GENESIS); }
  }
  const lines = logged.map((id) => ({ row: id, field: "space", from: made.has(id) ? null : rows.get(id)!.space, to: spaces.get(id) ?? null, stamp: deciding.get(topOf(id))! }));
  // (a top note's space is the one written for it: a note "followed" its tree when its top is another note)
  const followed = changed.filter((id) => !made.has(id) && topOf(id) !== id).map((id) => ({ note: id, from: rows.get(id)!.space, to: spaces.get(id) ?? null }));
  // who can read those notes changed: clients check their readable set again (this node's own counter)
  if (changed.some((id) => !made.has(id))) await bumpMembershipEpoch(workspaceId);
  return { lines, followed };
}

/** The view of a space's deletion after a merge, for every space of the workspace whose deletion is written or shown (spaces_show_deleted, migration 218). A deleted
 *  space is rare, so all of them, not only the bundle's: a note the bundle moved in or out decides too. Who can read what changed when a space's shown state did: the
 *  epoch moves (this node's own). Returns the spaces kept: deletion written, shown otherwise (the view gives `deleted_at` the written time or nothing). */
async function showSpaceDeletions(workspaceId: string, touched: boolean): Promise<string[]> {
  if (!touched) return [];
  const changed = (await snapshotRows<{ n: number }>(
    `SELECT spaces_show_deleted($1::uuid, ARRAY(SELECT id FROM spaces WHERE workspace_id = $1 AND (written_deleted_at IS NOT NULL OR deleted_at IS NOT NULL))) AS n`, [workspaceId])).rows[0]?.n ?? 0;
  if (changed > 0) await bumpMembershipEpoch(workspaceId);
  return (await snapshotRows<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND written_deleted_at IS NOT NULL AND deleted_at IS DISTINCT FROM written_deleted_at ORDER BY id`, [workspaceId])).rows.map((r) => r.id);
}
