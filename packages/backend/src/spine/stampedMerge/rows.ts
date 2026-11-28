// One ROW of a stamped table, merged with the copy another node holds of it: its creation or permanent delete (`*`), the units it wrote on their own,
// and what every other field shows because it follows the creation (store.ts has the same rules over a whole map of units; this is the database's form of
// them: the creation's values are not stored, so each side says what its followers show). Pure; the database half is ./dbRows.ts.
//
//   star       the heads of `*`: a creation (value `{}`) or a permanent delete (a tombstone). A row exists when the winner is a creation.
//   own        the units written on their own: the winner's cell and the other heads. A head that is only a creation value that lost (a node wrote the field
//              without having seen that creation) is kept here too, WITH its value: the creation's values are not stored, so this is the only place it can be.
//   creation   field → text, for each field that has no own unit: what it shows is what the creation(s) gave it.
// Same result as store.ts `mergeStore` for one row (stampedRows.test.ts compares them), including a row made again over a delete: the writes the deleter had
// seen are gone (`droppedBySeen`), the others stay beside the new value.

import { droppedBySeen } from "./store.js";
import { placedSort } from "./rules/place.js";
import { type Cell, type Json, type Rejection, type Unit, type MergeResult, GENESIS_STAMP_ORIGIN, canonical, describeUnitChange, isResent, mergeUnit, maximalHeads, stampKey, rejectReason } from "./unit.js";

/** The units whose column (or columns of a composite) a foreign key empties when the row it names is deleted (dbUnits.ts `clearedOnDelete`). */
export type Cleared = ReadonlyMap<string, { composite: boolean; columns: readonly string[] }>;
/** What a value says once the cleared columns are emptied, and whether it names anything there (an id, not NULL). */
function emptiedOf(value: Json | null, how: { composite: boolean; columns: readonly string[] }): { rest: string; names: boolean } | null {
  if (!how.composite) return { rest: "", names: value !== null };
  if (typeof value !== "string") return null;
  let o: unknown;
  try { o = JSON.parse(value); } catch { return null; }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const r = { ...(o as Record<string, unknown>) };
  let names = false;
  for (const c of how.columns) { if (r[c] !== null && r[c] !== undefined) names = true; r[c] = null; }
  return { rest: canonical(r), names };
}
/**
 * Two copies of ONE write of a unit a foreign key empties: the same but for the cleared columns, which one of them holds and the other has NULL (the database emptied
 * them on one node when the row they name was deleted: no write, no stamp). The copy that names it is the write; the other is the same write emptied. Null: they are
 * not that (two different values are a clash as always).
 */
function writtenCopy(a: Cell, b: Cell, how: { composite: boolean; columns: readonly string[] }): Cell | null {
  if (a.deleted || b.deleted || a.valueless || b.valueless || canonical(a.value) === canonical(b.value)) return null;
  const x = emptiedOf(a.value, how), y = emptiedOf(b.value, how);
  if (!x || !y || x.rest !== y.rest || x.names === y.names) return null;
  return x.names ? a : b;
}

/** A unit name of a key of a JSON column (dbUnits.ts unitName: `<label>:<field>`). A field of a row is a value, never a tombstone; a key can be removed. */
const isJsonKey = (name: string): boolean => name.includes(":");

/** What one node holds of a row. A copy of a write that does not say its value is marked on the cell (unit.ts `valueless`), not on the side. `creation` is empty on a node
 *  that does not hold the row: the values a creation gave are in the row, nowhere else. */
export type RowState = { star: Unit | undefined; own: ReadonlyMap<string, Unit>; creation: ReadonlyMap<string, string | null> };

type RowMerge =
  | { rejected: Rejection; /** which unit of the row */ unit?: string }
  | {
    /** The row exists after the merge (the winner of `*` is a creation). */
    exists: boolean;
    star: Unit;
    /** Each field as it stands (the winning cell first), for a row that exists. Empty when it does not. */
    fields: Map<string, Unit>;
    /** What this node held of each field before (the same derivation over the local state alone), for what changed. */
    before: Map<string, Unit>;
    /** The `*` heads differ from what this node held. */
    starChanged: boolean;
    /** The row did not exist here and now does / existed and no longer does. */
    created: boolean;
    removed: boolean;
    /** What the merge says per unit that changed or now holds a conflict (`*` has the field name `*`). */
    events: { field: string; result: Omit<MergeResult, "deferred"> }[];
    /** A row that no longer exists: the units written to it by someone, with the stamp of the write (rules/trash.ts `recoverLateEdits` tells who had not seen the delete). */
    leftOver: { field: string; cells: Cell[] }[];
  };

const creationKeyOf = (star: Unit | undefined) => new Set((star ?? []).map((h) => stampKey(h.stamp)));

/** The fields of a row as the state shows them: the creation's value for a field that has none of its own, and the own units beside it. */
function fieldsOf(star: Unit | undefined, own: ReadonlyMap<string, Unit>, valueOf: (head: Cell, field: string) => string | null | undefined, names: Iterable<string>): Map<string, Unit> {
  const out = new Map<string, Unit>();
  // (a re-send of `*` is no creation: nothing follows it, unit.ts isResent)
  const alive = (star ?? []).filter((h) => !h.deleted && !isResent(h));
  const row = star && !star[0]!.deleted;
  if (!row) return out;
  const aliveKeys = new Set(alive.map((h) => stampKey(h.stamp)));
  // a creation value that lost to an own write is kept as a head of the field with its value; once its creation is no longer a head of `*` (a creation that covers it
  // replaced it) it is not a value of anyone any more. A real write over a row always says what it saw (migration 205), so an empty `saw` marks exactly these.
  // A key of a JSON column (a name `<label>:<field>`, dbUnits.ts unitName) never follows a creation: its first write has an empty saw and is a write like any other.
  const staleCreation = (c: Cell, field: string) => !isJsonKey(field) && c.stamp.origin !== GENESIS_STAMP_ORIGIN && Object.keys(c.saw).length === 0 && c.meta === undefined && !aliveKeys.has(stampKey(c.stamp));
  for (const field of names) {
    const derived: Cell[] = [];
    for (const h of alive) { const v = valueOf(h, field); if (v !== undefined) derived.push({ stamp: h.stamp, saw: {}, deleted: false, value: v }); }
    const cells = [...derived, ...droppedBySeen(star, (own.get(field) ?? []).filter((c) => !staleCreation(c, field)))];
    if (cells.length) out.set(field, maximalHeads(cells));
  }
  // a row's parent and order key are one place (rules/place.ts): the key shown is one the parent's write set or had seen
  if (out.has("parent") && out.has("sort")) out.set("sort", placedSort(out.get("parent"), out.get("sort")!));
  return out;
}

const SORT = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Both sides with each copy of a write of a `cleared` unit replaced by the written copy (the one that names the row), wherever the other side holds that copy. */
function takeWrittenCopies(local: RowState | undefined, incoming: RowState, cleared: Cleared): { local: RowState | undefined; incoming: RowState } {
  if (!local || cleared.size === 0) return { local, incoming };
  const lo = new Map(local.own), inc = new Map(incoming.own);
  for (const [f, how] of cleared) {
    const a = lo.get(f), b = inc.get(f);
    if (!a || !b) continue;
    const pick = (c: Cell, other: Unit) => { const o = other.find((d) => stampKey(d.stamp) === stampKey(c.stamp)); return (o && writtenCopy(c, o, how)) ?? c; };
    lo.set(f, a.map((c) => pick(c, b)));
    inc.set(f, b.map((c) => pick(c, a)));
  }
  return { local: { ...local, own: lo }, incoming: { ...incoming, own: inc } };
}

/**
 * Merge `incoming` (what another node holds of the row) into `local` (undefined: this node has nothing of the row, not even a delete). A copy of a write without its value
 * (unit.ts `valueless`) merges as a stamp: two copies of one write agree when one of them has no value, the copy with the value is the one kept, and a field whose
 * winner has none shows nothing new (no event; dbRows.ts writes no column from it). Review of PR #1853, round 8: P1 a write says the same on every node that holds it,
 * P2 what a field shows is a function of its heads, P3 two nodes that exchanged to the end exchange nothing more and are never refused.
 */
export function mergeRow(rawLocal: RowState | undefined, rawIncoming: RowState, cleared: Cleared = new Map()): RowMerge {
  for (const c of [...(rawIncoming.star ?? []), ...[...rawIncoming.own.values()].flat()]) { const r = rejectReason(c); if (r) return { rejected: r }; }
  // A unit a foreign key empties (`cleared`): the copy of one write that names the row is the write; both sides take it before anything is compared (review of
  // PR #1853, round 9, point 1: frozen at the moment the row went, one node held the id and another NULL under one stamp, refused for ever). What this node held
  // before (`before`, for what changed) is its own copy.
  const { local, incoming } = takeWrittenCopies(rawLocal, rawIncoming, cleared);
  // a field's write is a value: a tombstone of a field is no write any node makes (storeUnit could not store it), so it is refused here, before anything is written
  for (const [f, u] of incoming.own) if (!isJsonKey(f) && u.some((c) => c.deleted)) return { rejected: "malformed", unit: f };
  // the same write in both with other content is refused (what mergeUnit does for one unit, a copy without a value agreeing with any); `*` by its stamp only (its
  // creation text is each side's own)
  const clash = (a: Unit | undefined, b: Unit | undefined, loose: boolean): boolean => {
    if (!a || !b) return false;
    const [x, y] = loose ? [a.map((c) => ({ ...c, value: null })), b.map((c) => ({ ...c, value: null }))] : [a, b];
    return mergeUnit(x, y).outcome === "rejected";
  };
  if (local) {
    if (clash(local.star, incoming.star, true)) return { rejected: "same-stamp-different-content", unit: "*" };
    for (const [f, u] of incoming.own) if (clash(local.own.get(f), u, false)) return { rejected: "same-stamp-different-content", unit: f };
  }
  const star = local?.star && incoming.star ? maximalHeads([...local.star, ...incoming.star]) : (local?.star ?? incoming.star)!;
  const incomingStar = creationKeyOf(incoming.star);
  const valueOf = (head: Cell, field: string): string | null | undefined => {
    const key = stampKey(head.stamp);
    const theirs = incomingStar.has(key) && incoming.creation.has(field) ? incoming.creation.get(field) : undefined;
    const ours = creationKeyOf(local?.star).has(key) && local?.creation.has(field) ? local.creation.get(field) : undefined;
    // what one creation gave a unit a foreign key empties: the copy that names the row (the other side's column was emptied)
    const how = cleared.get(field);
    if (how && theirs !== undefined && ours !== undefined) {
      const w = writtenCopy({ stamp: head.stamp, saw: {}, deleted: false, value: theirs }, { stamp: head.stamp, saw: {}, deleted: false, value: ours }, how);
      if (w) return w.value as string | null;
    }
    return theirs !== undefined ? theirs : ours;
  };
  const names = new Set<string>([...(local?.own.keys() ?? []), ...incoming.own.keys(), ...(local?.creation.keys() ?? []), ...incoming.creation.keys()]);
  const mergedOwn = new Map<string, Unit>();
  for (const f of names) {
    // the same write twice: this node's copy of it is kept (put last), unless it has no value and the other has (maximalHeads)
    const cells = [...(incoming.own.get(f) ?? []), ...(local?.own.get(f) ?? [])];
    if (cells.length) mergedOwn.set(f, maximalHeads(cells));
  }
  const exists = !star[0]!.deleted;
  const localValueOf = (head: Cell, field: string): string | null | undefined => (creationKeyOf(rawLocal?.star).has(stampKey(head.stamp)) ? rawLocal?.creation.get(field) : undefined);
  const before = rawLocal ? fieldsOf(rawLocal.star, rawLocal.own, localValueOf, names) : new Map<string, Unit>();
  const fields = fieldsOf(star, mergedOwn, valueOf, [...names].sort(SORT));
  const events: { field: string; result: Omit<MergeResult, "deferred"> }[] = [];
  const starResult = describeUnitChange(local?.star, star, incoming.star ?? []);
  const starChanged = !local?.star || JSON.stringify(local.star.map((c) => [c.stamp, c.deleted])) !== JSON.stringify(star.map((c) => [c.stamp, c.deleted]));
  if (starResult.outcome !== "same" || starResult.write || starChanged) events.push({ field: "*", result: starResult });
  for (const [f, unit] of fields) {
    // a winner without a value changes nothing anyone sees (round 8, point 3): no event says it was taken; nor does taking the written copy of what this node held emptied
    if (unit[0]!.valueless) continue;
    const was = before.get(f)?.[0], how = cleared.get(f);
    if (was && how && stampKey(was.stamp) === stampKey(unit[0]!.stamp) && writtenCopy(was, unit[0]!, how)) continue;
    const r = describeUnitChange(before.get(f), unit, [...(incoming.own.get(f) ?? [])]);
    if (r.outcome !== "same" || r.write || r.losers.length) events.push({ field: f, result: r });
  }
  const existedBefore = !!local?.star && !local.star[0]!.deleted;
  const leftOver = exists ? [] : [...mergedOwn].map(([field, cells]) => ({ field, cells: [...cells] }));
  return { exists, star, fields, before, starChanged, created: exists && !existedBefore, removed: !exists && existedBefore, events, leftOver };
}
