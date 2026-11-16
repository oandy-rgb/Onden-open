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

import { snapshotRows } from "../snapshotSql.js";
import { type Cell, type Json, type MergeResult, type SkewGate, type Stamp, type Unit, DEFAULT_MAX_SKEW_MS, GENESIS_STAMP_ORIGIN, canonical, genesisName, isGenesis, maximalHeads, mergeUnit } from "./unit.js";
import { type StoreMerge, type UnitAddress, STAR } from "./store.js";

type UnitSource = {
  /** The stamp table name (`sync_stamps.table_name`). */
  label: string;
  table: string;
  keyColumn: string;
  workspaceColumn: string;
  /** stamp field → column. The field `deleted` is the row's deleted state, not the timestamp: `'true'` / `'false'`. */
  fields: Readonly<Record<string, string>>;
};

/** The tables whose units this file reads and writes. A guard test compares each with the arguments of its stamp trigger in the database, so it cannot drift. */
export const UNIT_SOURCES: readonly UnitSource[] = [
  { label: "content_nodes", table: "content_nodes", keyColumn: "id", workspaceColumn: "workspace_id",
    fields: { title: "title", body: "markdown", parent: "parent_id", sort: "order_key", hidden: "hidden", space: "space_id", deleted: "deleted_at" } },
];

const sourceOf = (label: string): UnitSource => {
  const s = UNIT_SOURCES.find((u) => u.label === label);
  if (!s) throw new Error(`units of ${label} are not read from the database here`);
  return s;
};
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const STAR_PRESENT: Json = {};

type StampRow = {
  origin: string; seq: string; hlc_wall: string; hlc_counter: number; author: string | null; device: string | null; deleted: boolean;
  saw: Record<string, number>; meta: Json | null;
};
type HeadRow = StampRow & { content_hash: string; value: string | null };

const stampOf = (r: StampRow): Stamp => ({ origin: r.origin, seq: Number(r.seq), wall: Number(r.hlc_wall), counter: r.hlc_counter, author: r.author, device: r.device });
const metaOf = (r: StampRow): { meta?: Json } => (r.meta === null || r.meta === undefined ? {} : { meta: r.meta });
const STAMP_COLS = `origin, seq::text, hlc_wall::text, hlc_counter, author, device::text, deleted, saw, meta`;

/** The unit as the database holds it, or undefined when it holds nothing of it (no stamp of its own and no creation stamp it follows). */
export async function readUnit(workspaceId: string, a: UnitAddress): Promise<Unit | undefined> {
  const own = (await snapshotRows<StampRow>(
    `SELECT ${STAMP_COLS} FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, [workspaceId, a.table, a.row, a.field])).rows[0];
  const heads = (await snapshotRows<HeadRow>(
    `SELECT ${STAMP_COLS}, content_hash, value FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4 ORDER BY origin, seq, content_hash`,
    [workspaceId, a.table, a.row, a.field])).rows;
  const cells: Cell[] = [];
  if (a.field === STAR) {
    if (own) cells.push({ stamp: stampOf(own), saw: own.saw, deleted: own.deleted, value: own.deleted ? null : STAR_PRESENT, ...metaOf(own) });
    for (const h of heads) cells.push({ stamp: stampOf(h), saw: h.saw, deleted: h.deleted, value: h.deleted ? null : STAR_PRESENT, ...metaOf(h) });
  } else {
    const src = sourceOf(a.table);
    const column = src.fields[a.field];
    if (!column) throw new Error(`${a.table} has no unit named ${a.field}`);
    const value = (await snapshotRows<{ v: string | null }>(
      `SELECT sync_logged_value(t, $1, $2) AS v FROM ${quote(src.table)} t WHERE t.${quote(src.keyColumn)}::text = $3 AND t.${quote(src.workspaceColumn)} = $4`,
      [a.field, column, a.row, workspaceId])).rows[0];
    if (value) {
      if (own) cells.push({ stamp: stampOf(own), saw: own.saw, deleted: own.deleted, value: own.deleted ? null : value.v, ...metaOf(own) });
      else {
        const star = (await snapshotRows<StampRow>(`SELECT ${STAMP_COLS} FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = '*'`, [workspaceId, a.table, a.row])).rows[0];
        if (star) cells.push({ stamp: stampOf(star), saw: {}, deleted: false, value: value.v });
      }
      // the field follows EVERY head of its row's creation (two nodes made the same derived id), as store.ts `derived` does
      for (const h of (await snapshotRows<StampRow>(`SELECT ${STAMP_COLS} FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = '*' AND NOT deleted`, [workspaceId, a.table, a.row])).rows) {
        if (!own) cells.push({ stamp: stampOf(h), saw: {}, deleted: false, value: value.v });
      }
    }
    for (const h of heads) cells.push({ stamp: stampOf(h), saw: h.saw, deleted: h.deleted, value: h.deleted ? null : h.value, ...metaOf(h) });
  }
  return cells.length ? maximalHeads(cells) : undefined;
}

/** The hash a genesis head is stored under (sync_stamp_heads.content_hash): the part of unit.ts `genesisName` after `genesis:`, which migration 205's `sync_genesis_hash` makes in SQL. */
const genesisHashOf = (c: Cell): string => genesisName(c).slice(GENESIS_STAMP_ORIGIN.length + 1);

const sameStampRow = (a: Cell, b: Cell | undefined): boolean => !!b && a.stamp.origin === b.stamp.origin && a.stamp.seq === b.stamp.seq && a.stamp.wall === b.stamp.wall && a.stamp.counter === b.stamp.counter;

/** Write one merged unit's state: the winner's value into its column and its stamp row, the other heads into sync_stamp_heads. Only inside `storeMergedUnits`. */
async function storeUnit(workspaceId: string, a: UnitAddress, unit: Unit): Promise<void> {
  let win = unit[0]!;
  let others = unit.slice(1);
  if (a.field !== STAR) {
    // what the field only follows from its row's creation heads (their stamp, an empty saw) is read from the row, never stored beside the field
    const creation = new Set((await snapshotRows<StampRow>(
      `SELECT origin, seq::text FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = '*'
       UNION ALL SELECT origin, seq::text FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = '*'`, [workspaceId, a.table, a.row])).rows.map((r) => `${r.origin}:${r.seq}`));
    const derived = (c: Cell) => !isGenesis(c) && Object.keys(c.saw).length === 0 && c.meta === undefined && creation.has(`${c.stamp.origin}:${c.stamp.seq}`);
    const own = unit.filter((c) => !derived(c));
    if (own.length === 0) others = [];
    else if (own.length < unit.length) { win = own[0]!; others = own.slice(1); }
  }
  if (a.field !== STAR) {
    const src = sourceOf(a.table), column = src.fields[a.field]!;
    if (win.deleted) throw new Error("a field of a row is never a tombstone here");
    // `deleted` is the row's deleted state; any other column takes the text the core was given (a null is a null)
    if (a.field === "deleted") {
      const gone = win.value === "true";
      await snapshotRows(`UPDATE ${quote(src.table)} t SET ${quote(column)} = ${gone ? `COALESCE(t.${quote(column)}, now())` : "NULL"}
        WHERE t.${quote(src.keyColumn)}::text = $1 AND t.${quote(src.workspaceColumn)} = $2 AND (t.${quote(column)} IS NOT NULL) IS DISTINCT FROM ${gone}`, [a.row, workspaceId]);
    } else {
      await snapshotRows(
        `UPDATE ${quote(src.table)} t SET ${quote(column)} = (jsonb_populate_record(NULL::${quote(src.table)}, jsonb_build_object($3::text, $4::text))).${quote(column)}
          WHERE t.${quote(src.keyColumn)}::text = $1 AND t.${quote(src.workspaceColumn)} = $2 AND t.${quote(column)}::text IS DISTINCT FROM $4::text`, [a.row, workspaceId, column, win.value as string | null]);
    }
  }
  // The order key travels with the stamp of the write that set it (migration 200 order_stamp): the tie rule of the sibling order reads it.
  if (a.table === "content_nodes" && a.field === "sort" && !isGenesis(win)) {
    await snapshotRows(`UPDATE content_nodes SET order_stamp = $3 WHERE id::text = $1 AND workspace_id = $2`, [a.row, workspaceId, String(win.stamp.wall).padStart(15, "0") + String(win.stamp.counter).padStart(6, "0")]);
  }
  // A field with no stamp of its own that still shows exactly its row's creation stamp is stored as nothing: the same writes give the same rows on every node.
  let followsStar = false;
  if (a.field !== STAR && others.length === 0 && Object.keys(win.saw).length === 0 && win.meta === undefined) {
    const star = (await snapshotRows<StampRow>(`SELECT ${STAMP_COLS} FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = '*'`, [workspaceId, a.table, a.row])).rows[0];
    followsStar = !!star && sameStampRow(win, { stamp: stampOf(star) } as Cell);
  }
  const key = [workspaceId, a.table, a.row, a.field];
  if (followsStar) {
    await snapshotRows(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, key);
  } else {
    await snapshotRows(
      `INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12::jsonb, $13::jsonb)
       ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
         origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter, author = EXCLUDED.author,
         device = EXCLUDED.device, deleted = EXCLUDED.deleted, saw = EXCLUDED.saw, meta = EXCLUDED.meta`,
      [...key, isGenesis(win) ? GENESIS_STAMP_ORIGIN : win.stamp.origin, win.stamp.seq, win.stamp.wall, win.stamp.counter, win.stamp.author, win.stamp.device, win.deleted, JSON.stringify(win.saw), win.meta === undefined ? null : JSON.stringify(win.meta)]);
  }
  await snapshotRows(`DELETE FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, key);
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
