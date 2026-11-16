// The database end of the merge core at the level of a ROW: what a change bundle says about a note (its creation or permanent delete, the units it wrote on its own,
// what its other fields follow) merged with what this database holds, written back, with the row made or removed when that is what the merge decides.
// The pure part is ./rows.ts; the unit-level write-back it shares with `storeMergedUnits` is `storeUnit` in ./dbUnits.ts. Contract: ./README.md "Changes of other nodes".
//
// Only inside `applyChangeBundle` (spine/stampedImport.ts): the stamp triggers stand aside, the event lock is held, the sender and the shape were checked. What this does
// that the unit-level write-back does not:
//   - a row that does not exist here is made from the values the bundle carries (the parent last: every row of the bundle is in first), and a permanent delete removes the row
//     and its units' stamps, the way the delete trigger does. The database's own `ON DELETE SET NULL` empties the parent of a note whose parent is removed (no stamp, as on the node that deleted it);
//   - what arrives from another device is logged in structure_log the way a local move or delete is, with the stamp of the write (origin, sequence number, author and device kept):
//     this device's history can show it. The log itself is never read into a bundle (stampedBundle.guard.test.ts);
//   - writes to a row that is gone are not stored (there is nothing to hold them): they are returned in `lateEdits`, for the caller to give back to their authors (rules/trash.ts).
// What it does not do (named in the PR and pinned in stampedBundleDerived.integration.test.ts): the tables other than content_nodes, and what is derived from a row's text (links, anchors, search index).

import { liveNodeSql } from "../nodeSql.js";
import { followCarriedColumns, insertCarriedRow, overwriteCarriedColumns, snapshotRows, type BundleItem, type WireStamp } from "../snapshotSql.js";
import { type Deletion, type FieldWrite, type Notice, type RecoveryCopy, type TrashFix, type TreeNote, noticesForEditedDeletes, recoverLateEdits, trashOrphanedChildren } from "./rules/trash.js";
import { type RowState, mergeRow } from "./rows.js";
import { type Cell, type Json, type Rejection, type Stamp, type Unit, canonical, compareStamps, stampKey } from "./unit.js";
import { NOT_AN_EDIT_FIELDS, STAMP_COLS, STAR_PRESENT, quote, sourceOf, stampOf, storeUnit, cellMetaOf, type HeadRow, type StampRow } from "./dbUnits.js";
import { STAR, type StoreEvent } from "./store.js";

const TABLE = "content_nodes";
const SRC = sourceOf(TABLE);
const FIELDS = Object.keys(SRC.fields);
/** Columns the write path sets from a unit (a note's slug from its title) follow that unit's winner. `updated_at` is a function of the counting stamps (migration 206), or the carried value of a creation. */
const DERIVED_WITH: Record<string, string[]> = { title: ["slug"], deleted: ["deleted_at"] };
const STRUCTURE_FIELDS = ["parent", "space", "deleted"]; // the fields the stamp trigger logs (migration 190)

export type RowsReport = {
  events: StoreEvent[];
  rejected: { row: string; reason: Rejection; unit?: string }[];
  /** Writes made to a row that no longer exists, for the people who had not seen the delete (the rows stay gone). */
  lateEdits: RecoveryCopy[];
  /** Notes (of this bundle) made under a parent that was deleted for good before its deleter saw them (4.9), and whom to tell. REPORTED, not written: see `orphansOf`. */
  orphaned: TrashFix[];
  /** Who is to be told: the creators of those notes, and the editors of a trashed note whose edit its deleter had not seen. */
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

/** The state a bundle's row says: its `*`, its own units (with the values the bundle gives as text), and what each field that has no unit of its own shows. */
function incomingOf(item: BundleItem): Incoming | null {
  const own = new Map<string, Cell[]>();
  const star: Cell[] = [];
  const stamps = item.kind === "row" ? item.stamps : [item.stamp];
  const texts = item.kind === "row" ? item.texts : {};
  const hasOwn = new Set<string>();
  for (const s of stamps) {
    if (s.label !== TABLE) continue;
    if (s.field === STAR) {
      star.push(wireCell(s, STAR_PRESENT), ...s.heads.map((h) => wireCell({ ...h, meta: h.meta }, STAR_PRESENT)));
    } else if (FIELDS.includes(s.field)) {
      hasOwn.add(s.field);
      own.set(s.field, [wireCell(s, texts[s.field] ?? null), ...s.heads.map((h) => wireCell({ ...h, meta: h.meta }, h.value))]);
    }
  }
  if (star.length === 0) return null;
  const creation = new Map<string, string | null>();
  if (item.kind === "row") for (const f of FIELDS) if (!hasOwn.has(f) && Object.hasOwn(texts, f)) creation.set(f, texts[f] ?? null);
  const row = item.kind === "row" ? String(item.values.id) : stamps[0]!.rowKey;
  return { row, values: item.kind === "row" ? item.values : undefined, state: { star: [...star].sort((a, b) => compareStamps(b.stamp, a.stamp)), own, creation } };
}

type LocalRow = { exists: boolean; state: RowState | undefined };

/** What this database holds of each of `rows`: the stamps (own and heads), and the text of each unit's column. */
async function loadLocal(workspaceId: string, rows: string[]): Promise<Map<string, LocalRow>> {
  const stamps = (await snapshotRows<StampRow & { row_key: string; field: string }>(
    `SELECT row_key, field, ${STAMP_COLS} FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = ANY($3::text[])`, [workspaceId, TABLE, rows])).rows;
  const heads = (await snapshotRows<HeadRow & { row_key: string; field: string }>(
    `SELECT row_key, field, ${STAMP_COLS}, content_hash, value FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = ANY($3::text[])`, [workspaceId, TABLE, rows])).rows;
  const texts = new Map((await snapshotRows<Record<string, string | null>>(
    `SELECT t.id::text AS "$id", ${FIELDS.map((f) => `sync_logged_value(t, '${f}', '${SRC.fields[f]}') AS "${f}"`).join(", ")}
       FROM ${quote(SRC.table)} t WHERE t.workspace_id = $1 AND t.id = ANY($2::uuid[])`, [workspaceId, rows])).rows.map((r) => [r.$id!, r] as const));
  const out = new Map<string, LocalRow>();
  // grouped once: a filter over every stamp for every row was quadratic in the size of the bundle (10,000 rows took 438 s)
  const stampsOf = new Map<string, typeof stamps>(), headsOf = new Map<string, typeof heads>();
  for (const s of stamps) (stampsOf.get(s.row_key) ?? stampsOf.set(s.row_key, []).get(s.row_key)!).push(s);
  for (const h of heads) (headsOf.get(h.row_key) ?? headsOf.set(h.row_key, []).get(h.row_key)!).push(h);
  for (const row of rows) {
    const t = texts.get(row);
    const star: Cell[] = [], own = new Map<string, Cell[]>(), hasOwn = new Set<string>();
    for (const s of stampsOf.get(row) ?? []) {
      if (s.field === STAR) star.push({ stamp: stampOf(s), saw: s.saw, deleted: s.deleted, value: s.deleted ? null : STAR_PRESENT, ...cellMetaOf(s) });
      else if (FIELDS.includes(s.field)) { hasOwn.add(s.field); (own.get(s.field) ?? own.set(s.field, []).get(s.field)!).push({ stamp: stampOf(s), saw: s.saw, deleted: s.deleted, value: s.deleted ? null : (t?.[s.field] ?? null), ...cellMetaOf(s) }); }
    }
    for (const h of headsOf.get(row) ?? []) {
      const cell: Cell = { stamp: stampOf(h), saw: h.saw, deleted: h.deleted, value: h.deleted ? null : h.field === STAR ? STAR_PRESENT : h.value, ...cellMetaOf(h) };
      if (h.field === STAR) star.push(cell);
      else if (FIELDS.includes(h.field)) (own.get(h.field) ?? own.set(h.field, []).get(h.field)!).push(cell);
    }
    const creation = new Map<string, string | null>();
    if (t) for (const f of FIELDS) if (!hasOwn.has(f)) creation.set(f, t[f] ?? null);
    out.set(row, { exists: !!t, state: star.length ? { star: [...star].sort((a, b) => compareStamps(b.stamp, a.stamp)), own, creation } : undefined });
  }
  return out;
}

async function structureLine(workspaceId: string, row: string, field: string, from: string | null, to: string | null, stamp: Stamp): Promise<void> {
  // the log's own guard (migration 206 structure_log_import_skip) lets exactly this insert through while a merge is written
  await snapshotRows(`SELECT set_config('onden.merge_structure_line', 'on', true)`);
  await snapshotRows(
    `INSERT INTO structure_log (workspace_id, table_name, row_key, field, old_value, new_value, origin, seq, hlc_wall, hlc_counter, author, device)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid)`,
    [workspaceId, TABLE, row, field, from, to, stamp.origin, stamp.seq, stamp.wall, stamp.counter, stamp.author, stamp.device]);
  await snapshotRows(`SELECT set_config('onden.merge_structure_line', '', true)`);
}

type Merged = { i: Incoming; l: LocalRow; m: Extract<ReturnType<typeof mergeRow>, { exists: boolean }> };

/** What of a row that exists here is taken from the bundle's copy besides the units: the creation columns (the creation that won is another than ours) and the columns that follow a unit that came from the bundle. */
function carriedFrom({ i, l, m }: Merged): { overwrite: boolean; copy: string[] } {
  if (!m.exists || !l.exists || !i.values) return { overwrite: false, copy: [] };
  const win = m.star[0]!;
  const overwrite = !!l.state?.star && m.starChanged && stampKey(win.stamp) !== stampKey(l.state.star[0]!.stamp) && !!i.state.star?.some((h) => stampKey(h.stamp) === stampKey(win.stamp));
  const incomingWon = (f: string) => { const w = m.fields.get(f)?.[0], theirs = i.state.own.get(f)?.[0]; return !!w && !!theirs && stampKey(w.stamp) === stampKey(theirs.stamp) && stampKey(w.stamp) !== stampKey(m.before.get(f)?.[0]?.stamp ?? { origin: "", seq: -1 }); };
  return { overwrite, copy: Object.entries(DERIVED_WITH).filter(([f]) => incomingWon(f)).flatMap(([, cols]) => cols) };
}

const textOf = (u: Unit | undefined): string | null => (u ? (u[0]!.value as string | null) : null);

/**
 * Merge the rows of a change bundle into this workspace, row by row, and write back what changed. PRECONDITION: inside `applyChangeBundle` (stand-aside switch on, event lock held).
 * Rows are independent of each other except for one order: every row that is made is made before any other row is written to (a parent can come in the same bundle; a parent that
 * is not here is no row to point at, see `storeUnit`). Throws nothing for a refused row: `rejected` names it and the caller refuses the bundle (nothing of it stays: the transaction is rolled back).
 */
export async function storeMergedRows(workspaceId: string, items: readonly BundleItem[]): Promise<RowsReport> {
  const report: RowsReport = { events: [], rejected: [], lateEdits: [], orphaned: [], notices: [], created: 0, removed: 0, stored: 0, structureLines: 0 };
  const incoming = items.map(incomingOf).filter((i): i is Incoming => i !== null);
  const local = await loadLocal(workspaceId, incoming.map((i) => i.row));
  const merged: Merged[] = [];
  for (const i of incoming) {
    const l = local.get(i.row)!;
    const m = mergeRow(l.state, i.state);
    if ("rejected" in m) { report.rejected.push({ row: i.row, reason: m.rejected, ...(m.unit ? { unit: m.unit } : {}) }); continue; }
    merged.push({ i, l, m });
  }
  if (report.rejected.length) return report;
  const address = (row: string, field: string) => ({ table: TABLE, row, field });
  // Removals first: a note that goes frees its slug for a note that comes (see below), and a parent that goes empties its children's parent column the way the database does
  for (const { i, l, m } of merged) {
    if (m.exists || !l.exists) continue;
    const win = m.star[0]!;
    // the row is gone for good: its units go with it (the delete trigger does the same), and the log says what became of it
    const gone = textOf(m.before.get("deleted")) ?? "false";
    await snapshotRows(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field <> '*'`, [workspaceId, TABLE, i.row]);
    await snapshotRows(`DELETE FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field <> '*'`, [workspaceId, TABLE, i.row]);
    await snapshotRows(`DELETE FROM ${quote(SRC.table)} WHERE id = $1::uuid AND workspace_id = $2`, [i.row, workspaceId]);
    await structureLine(workspaceId, i.row, "deleted", gone, null, win.stamp);
    report.structureLines++;
    report.removed++;
  }
  // A slug is unique among the LIVE notes of a space, and a bundle can move one slug from a note to another (a title changed, a note trashed or moved to another space, a new note given the name
  // it left). So the notes whose slug, trash state or space is to change, and the notes that are made, hold a name no note has (~ and the id) while the bundle is written, and take their slug
  // last, when every other change is in (`assignSlugs`).
  const slugRows = merged.filter((x) => {
    const c = carriedFrom(x);
    return (x.m.exists && !x.l.exists) || c.overwrite || c.copy.includes("slug") || (x.m.exists && x.m.events.some((e) => (e.field === "deleted" || e.field === "space") && e.result.write));
  });
  const originalSlug = new Map((await snapshotRows<{ id: string; slug: string }>(
    `SELECT id::text, slug FROM ${quote(SRC.table)} WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, slugRows.filter((x) => x.l.exists).map((x) => x.i.row)])).rows.map((r) => [r.id, r.slug] as const));
  if (originalSlug.size) await snapshotRows(`UPDATE ${quote(SRC.table)} SET slug = '~' || id::text WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, [...originalSlug.keys()]]);
  for (const { i, l, m } of merged) {
    for (const e of m.events) report.events.push({ address: address(i.row, e.field), result: { ...e.result, deferred: [] } });
    if (m.exists && !l.exists) {
      if (!i.values) throw new Error(`the bundle makes row ${i.row} and does not carry its values`);
      await insertCarriedRow(TABLE, workspaceId, { ...i.values, slug: `~${i.row}` });
      report.created++;
    }
  }
  for (const { i, l, m } of merged) {
    const win = m.star[0]!;
    const creation = new Set(m.star.map((h) => stampKey(h.stamp)));
    if (m.exists) {
      let counted = false; // a unit that counts as an edit was written to a row that was here: only then can `updated_at` change (a row made here carries the sender's `updated_at`, which is the same function of the same stamps)
      if (!l.state || m.starChanged) { await storeUnit(workspaceId, address(i.row, STAR), m.star); report.stored++; }
      // the same row made twice (two nodes made the same id, or this node still holds a row that another deleted and made again): the creation that wins is the row, on every node
      const from = carriedFrom({ i, l, m });
      if (from.overwrite) await overwriteCarriedColumns(TABLE, workspaceId, i.row, i.values!, [...Object.values(SRC.fields), "order_stamp", "slug"]);
      for (const f of new Set([...m.fields.keys(), ...m.before.keys()])) {
        const after = m.fields.get(f), prior = m.before.get(f);
        if (!after) { // no cell is left for it (cannot happen while a creation gives every field a value): nothing of its own is kept
          await snapshotRows(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, [workspaceId, TABLE, i.row, f]);
          await snapshotRows(`DELETE FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, [workspaceId, TABLE, i.row, f]);
          continue;
        }
        if (!l.exists || m.starChanged || !prior || canonical(after) !== canonical(prior)) { await storeUnit(workspaceId, address(i.row, f), after, creation); report.stored++; if (l.exists && !NOT_AN_EDIT_FIELDS.includes(f)) counted = true; }
      }
      // What the write path derives from a unit travels with the unit that won: the slug of a title, the time a note was deleted; `updated_at` of a row that is only touched is a function of the stamps (sync_touch_updated_at); a creation that wins brings its own
      if (l.exists && i.values) await followCarriedColumns(TABLE, workspaceId, i.row, i.values, from.copy.filter((c) => c !== "slug"), []);
      if (counted) await snapshotRows(`SELECT sync_touch_updated_at($1::uuid, $2)`, [workspaceId, i.row]); // updated_at is a function of the stamps now written
      for (const f of STRUCTURE_FIELDS) {
        const before = l.exists ? textOf(m.before.get(f)) : null, now = textOf(m.fields.get(f));
        if (!l.exists || before !== now) { await structureLine(workspaceId, i.row, f, before, now, (m.fields.get(f)?.[0] ?? win).stamp); report.structureLines++; }
      }
    } else {
      if (!l.state || m.starChanged) { await storeUnit(workspaceId, address(i.row, STAR), m.star); report.stored++; }
      if (m.leftOver.length) {
        const seen = (win.meta as { seen?: Record<string, number> } | undefined)?.seen ?? {};
        report.lateEdits.push(...recoverLateEdits([{ id: i.row, purged: { stamp: win.stamp, seen }, writes: m.leftOver.flatMap((x) => x.cells.map((c): FieldWrite => ({ field: x.field, stamp: c.stamp, value: c.value }))) }]));
      }
    }
  }
  const views = await orphansOf(workspaceId, merged);
  report.orphaned = views.fixes; report.notices = views.notices;
  await assignSlugs(workspaceId, slugRows.map(({ i, l, m }) => {
    const c = carriedFrom({ i, l, m });
    return { id: i.row, slug: !l.exists || c.overwrite || c.copy.includes("slug") ? String(i.values?.slug) : originalSlug.get(i.row)! };
  }));
  return report;
}

/**
 * Give the notes of a bundle their slugs (they hold `~id` until now). Two live notes of a space cannot have one slug: when that would happen the note with the LARGER id takes
 * `slug-<first eight of its id>`, whichever of the two it is, the same on every node that sees both. (A slug is derived from a title by the write path of the node that wrote it; it is not a
 * unit. This keeps the database's index true without choosing between the two titles; PR "需要決定".)
 */
async function assignSlugs(workspaceId: string, wanted: { id: string; slug: string }[]): Promise<void> {
  for (const { id, slug } of [...wanted].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const row = (await snapshotRows<{ live: boolean; space: string | null }>(`SELECT (${liveNodeSql()}) AS live, space_id::text AS space FROM ${quote(SRC.table)} WHERE workspace_id = $1 AND id = $2::uuid`, [workspaceId, id])).rows[0];
    if (!row) continue;
    let final = slug;
    if (row.live) {
      const other = (await snapshotRows<{ id: string }>(
        `SELECT id::text FROM ${quote(SRC.table)} WHERE workspace_id = $1 AND COALESCE(space_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
            AND slug = $3 AND ${liveNodeSql()} AND id <> $4::uuid LIMIT 1`, [workspaceId, row.space, slug, id])).rows[0];
      if (other) {
        if (other.id < id) final = `${slug}-${id.split("-")[0]}`;
        else await snapshotRows(`UPDATE ${quote(SRC.table)} SET slug = $3 WHERE workspace_id = $1 AND id = $2::uuid`, [workspaceId, other.id, `${slug}-${other.id.split("-")[0]}`]);
      }
    }
    await snapshotRows(`UPDATE ${quote(SRC.table)} SET slug = $3 WHERE workspace_id = $1 AND id = $2::uuid`, [workspaceId, id, final]);
  }
}


/**
 * Rule 4.9 as a VIEW over the stamps (rules/trash.ts): which notes of this bundle sit under a parent that was deleted for good before its deleter had seen them, and who is to be told. It is a
 * function of stamps every node holds, so every node computes the same answer; it is NOT written. Putting the note in the trash is a write, and a write needs a stamp that every node makes the
 * same without talking (README: a cross-row rule stored as a write needs deterministic stamps computed from its inputs); that stamp is the open design item of this rule (the `it.fails` in
 * stampedBundle.integration.test.ts). Until then the note keeps its place (parent column emptied by the database's SET NULL) and the caller has the list.
 */
async function orphansOf(workspaceId: string, merged: readonly Merged[]): Promise<{ fixes: TrashFix[]; notices: Notice[] }> {
  const alive = merged.filter((x) => x.m.exists);
  const parents = [...new Set(alive.map((x) => textOf(x.m.fields.get("parent"))).filter((p): p is string => !!p))];
  const dead = new Map<string, Deletion>();
  if (parents.length) {
    const rows = (await snapshotRows<StampRow & { row_key: string }>(
      `SELECT row_key, ${STAMP_COLS} FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND field = '*' AND deleted AND row_key = ANY($3::text[])`, [workspaceId, TABLE, parents])).rows;
    for (const r of rows) dead.set(r.row_key, { stamp: stampOf(r), seen: ((r.meta as { seen?: Record<string, number> } | null)?.seen) ?? {} });
  }
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
