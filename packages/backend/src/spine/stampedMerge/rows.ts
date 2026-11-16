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
import { type Cell, type Rejection, type Unit, type MergeResult, GENESIS_STAMP_ORIGIN, describeUnitChange, mergeUnit, maximalHeads, stampKey, rejectReason } from "./unit.js";

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
  const alive = (star ?? []).filter((h) => !h.deleted);
  const row = star && !star[0]!.deleted;
  if (!row) return out;
  const aliveKeys = new Set(alive.map((h) => stampKey(h.stamp)));
  // a creation value that lost to an own write is kept as a head of the field with its value; once its creation is no longer a head of `*` (a creation that covers it
  // replaced it) it is not a value of anyone any more. A real write over a row always says what it saw (migration 205), so an empty `saw` marks exactly these.
  const staleCreation = (c: Cell) => c.stamp.origin !== GENESIS_STAMP_ORIGIN && Object.keys(c.saw).length === 0 && c.meta === undefined && !aliveKeys.has(stampKey(c.stamp));
  for (const field of names) {
    const derived: Cell[] = [];
    for (const h of alive) { const v = valueOf(h, field); if (v !== undefined) derived.push({ stamp: h.stamp, saw: {}, deleted: false, value: v }); }
    const cells = [...derived, ...droppedBySeen(star, (own.get(field) ?? []).filter((c) => !staleCreation(c)))];
    if (cells.length) out.set(field, maximalHeads(cells));
  }
  return out;
}

const SORT = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Merge `incoming` (what another node holds of the row) into `local` (undefined: this node has nothing of the row, not even a delete). */
export function mergeRow(local: RowState | undefined, incoming: RowState): RowMerge {
  for (const c of [...(incoming.star ?? []), ...[...incoming.own.values()].flat()]) { const r = rejectReason(c); if (r) return { rejected: r }; }
  // the same write in both with other content is refused (what mergeUnit does for one unit); own units first, `*` by its stamp only (its creation text is each side's own)
  // `parent`: the database empties the column of a note whose parent was removed (ON DELETE SET NULL) and the unit still says where the note was put: a node that did and one that did not hold
  // the same write with a NULL and the parent's id. That is not another write.
  const emptied = (x: Unit, y: Unit): Unit => x.map((c) => { const o = y.find((d) => stampKey(d.stamp) === stampKey(c.stamp)); return o && (o.value === null) !== (c.value === null) ? { ...c, value: null } : c; });
  const clash = (a: Unit | undefined, b: Unit | undefined, loose: boolean, field = ""): boolean => {
    if (!a || !b) return false;
    const [x, y] = loose ? [a.map((c) => ({ ...c, value: null })), b.map((c) => ({ ...c, value: null }))] : field === "parent" ? [emptied(a, b), emptied(b, a)] : [a, b];
    return mergeUnit(x, y).outcome === "rejected";
  };
  if (local) {
    if (clash(local.star, incoming.star, true)) return { rejected: "same-stamp-different-content", unit: "*" };
    for (const [f, u] of incoming.own) if (clash(local.own.get(f), u, false, f)) return { rejected: "same-stamp-different-content", unit: f };
  }
  const star = local?.star && incoming.star ? maximalHeads([...local.star, ...incoming.star]) : (local?.star ?? incoming.star)!;
  const incomingStar = creationKeyOf(incoming.star);
  const valueOf = (head: Cell, field: string): string | null | undefined => {
    const key = stampKey(head.stamp);
    if (incomingStar.has(key) && incoming.creation.has(field)) return incoming.creation.get(field);
    if (creationKeyOf(local?.star).has(key) && local?.creation.has(field)) return local.creation.get(field);
    return undefined;
  };
  const names = new Set<string>([...(local?.own.keys() ?? []), ...incoming.own.keys(), ...(local?.creation.keys() ?? []), ...incoming.creation.keys()]);
  const mergedOwn = new Map<string, Unit>();
  for (const f of names) {
    const cells = [...(incoming.own.get(f) ?? []), ...(local?.own.get(f) ?? [])]; // the same write twice: this node's copy of it wins
    if (cells.length) mergedOwn.set(f, maximalHeads(cells));
  }
  const exists = !star[0]!.deleted;
  const localValueOf = (head: Cell, field: string): string | null | undefined => (creationKeyOf(local?.star).has(stampKey(head.stamp)) ? local?.creation.get(field) : undefined);
  const before = local ? fieldsOf(local.star, local.own, localValueOf, names) : new Map<string, Unit>();
  const fields = fieldsOf(star, mergedOwn, valueOf, [...names].sort(SORT));
  const events: { field: string; result: Omit<MergeResult, "deferred"> }[] = [];
  const starResult = describeUnitChange(local?.star, star, incoming.star ?? []);
  const starChanged = !local?.star || JSON.stringify(local.star.map((c) => [c.stamp, c.deleted])) !== JSON.stringify(star.map((c) => [c.stamp, c.deleted]));
  if (starResult.outcome !== "same" || starResult.write || starChanged) events.push({ field: "*", result: starResult });
  for (const [f, unit] of fields) {
    const r = describeUnitChange(before.get(f), unit, [...(incoming.own.get(f) ?? [])]);
    if (r.outcome !== "same" || r.write || r.losers.length) events.push({ field: f, result: r });
  }
  const existedBefore = !!local?.star && !local.star[0]!.deleted;
  const leftOver = exists ? [] : [...mergedOwn].map(([field, cells]) => ({ field, cells: [...cells] }));
  return { exists, star, fields, before, starChanged, created: exists && !existedBefore, removed: !exists && existedBefore, events, leftOver };
}
