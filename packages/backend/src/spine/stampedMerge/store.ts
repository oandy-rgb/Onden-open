// A set of stamped units: rows, their fields, JSON keys and tombstones, addressed as (table, row key, field) like
// the stamp table of db/migrations/190. Merging two stores merges each unit by itself (./unit.ts).
//
// The whole-row unit `*` and its fields (docs/architecture/proposals/causal-stamps-2026-11-12.md §3):
//   - `*` holds how the row was created (an object: field name → value) or its permanent deletion (tombstone);
//   - a field with no stamp of its own FOLLOWS `*`: its value and its stamp are the `*` ones. A field written on its own
//     has a unit of its own. A field's current state is the merge of both, so one node changing the title and another
//     changing the body of a row both created by a third keeps both, and a field written after the row was created wins
//     over the creation values it saw, never over a different write it did not see;
//   - a JSON column is a set of fields named `key:<name>`; removing a key writes a tombstone for that field.
// What a creation value says it has seen: nothing. A field that follows `*` carries `*`'s stamp but an EMPTY `saw`, because
// `saw` only ever speaks about the unit it is in, and `*`'s `saw` is about `*`. (Taking `*`'s own `saw` for the field would
// let a recreated row "see" writes to fields that its creator never held.) So no part of this file needs a row to arrive
// whole, and a field edit that reaches a node before the row's creation does is simply kept until it does.
//
// The stored form is canonical: a field unit that equals what following `*` would give is not stored, so two nodes
// holding the same writes hold the same map.

import { placedSort } from "./rules/place.js";
import { type Cell, type Json, type Stamp, type Unit, type SkewGate, type MergeResult, type Rejection, GENESIS_STAMP_ORIGIN, canonical, deferReason, describeUnitChange, maximalHeads, mergeUnit, rejectReason, writeUnit } from "./unit.js";

export const STAR = "*";
export type UnitAddress = { table: string; row: string; field: string };
export type Store = ReadonlyMap<string, Unit>;

const SEP = "\u0001";
export const addressKey = (a: UnitAddress): string => `${a.table}${SEP}${a.row}${SEP}${a.field}`;
export const parseAddress = (key: string): UnitAddress => { const [table, row, field] = key.split(SEP) as [string, string, string]; return { table, row, field }; };
const rowKeyOf = (a: UnitAddress): string => `${a.table}${SEP}${a.row}`;
/** A JSON column's key as a field name. */
export const keyField = (key: string): string => `key:${key}`;

type Fields = Record<string, Json>;
const isFields = (v: Json | null): v is Fields => v !== null && typeof v === "object" && !Array.isArray(v);

/** What following `*` gives for `field`: the creation value of each `*` head that has one. */
function derived(star: Unit | undefined, field: string): Cell[] {
  const out: Cell[] = [];
  for (const h of star ?? []) if (!h.deleted && isFields(h.value) && Object.hasOwn(h.value, field)) out.push({ ...h, saw: {}, value: h.value[field]! });
  return out;
}

/** What the deleter of a row had seen of its units, carried by a creation that covers the delete (meta.seen, written by migration 206's trigger and by `createRow`). */
function seenByDelete(star: Unit | undefined, includeDeletes = false): Record<string, number> {
  const seen: Record<string, number> = {};
  for (const h of star ?? []) {
    const s = h.deleted && !includeDeletes ? undefined : (h.meta as { seen?: unknown } | undefined)?.seen;
    if (s && typeof s === "object" && !Array.isArray(s)) for (const [o, n] of Object.entries(s)) if (typeof n === "number") seen[o] = Math.max(seen[o] ?? -1, n);
  }
  return seen;
}

/**
 * A row made again over a permanent delete: the writes to its fields that the deleter had SEEN ended with the delete, so they are not heads beside the
 * recreated values (README "刪除之後再建立"). `star` is the row's `*` as it stands now; a write the deleter had not seen stays, and rules/trash.ts tells its author.
 * A function of the SET of writes (the recreation's `meta.seen` travels with it), so it gives the same answer on every node and in every arrival order.
 */
export function droppedBySeen(star: Unit | undefined, cells: readonly Cell[]): Cell[] {
  const seen = seenByDelete(star);
  if (Object.keys(seen).length === 0) return [...cells];
  return cells.filter((c) => c.stamp.origin === GENESIS_STAMP_ORIGIN || c.stamp.seq > (seen[c.stamp.origin] ?? -1));
}

/**
 * The field as it stands: what following `*` gives (from the heads of `*` that are still heads) joined with the field's own
 * writes. A write made in the same transaction as the row's creation has the creation's stamp: the field's own unit is
 * the later statement and replaces the creation value.
 */
export function effectiveUnit(store: Store, a: UnitAddress): Unit | undefined {
  const own = store.get(addressKey(a));
  if (a.field === STAR) return own;
  const cells = [...derived(store.get(addressKey({ ...a, field: STAR })), a.field), ...(own ?? [])];
  return cells.length ? maximalHeads(cells) : undefined;
}

const indexes = new WeakMap<Store, Map<string, Set<string>>>();
/** The own units of each row, by (table, row): built once per store, which is never changed after it is made. */
function ownFields(store: Store): Map<string, Set<string>> {
  let index = indexes.get(store);
  if (!index) {
    index = new Map();
    for (const key of store.keys()) { const a = parseAddress(key); const k = rowKeyOf(a); (index.get(k) ?? index.set(k, new Set()).get(k)!).add(a.field); }
    indexes.set(store, index);
  }
  return index;
}

/** The fields a row has at all (own units and `*` creation values), `*` first. */
export function fieldsOf(store: Store, table: string, row: string): string[] {
  const names = new Set<string>(ownFields(store).get(`${table}${SEP}${row}`) ?? []);
  for (const h of store.get(addressKey({ table, row, field: STAR })) ?? []) if (!h.deleted && isFields(h.value)) for (const f of Object.keys(h.value)) names.add(f);
  names.delete(STAR);
  return [...names].sort();
}

export type RowView = { exists: boolean; star: Unit | undefined; fields: Map<string, Unit> };
/** A row as it stands. `exists` is false once the winning `*` write is a tombstone (the fields are still here: they are somebody's words). */
export function rowOf(store: Store, table: string, row: string): RowView {
  const star = store.get(addressKey({ table, row, field: STAR }));
  const fields = new Map<string, Unit>();
  for (const f of fieldsOf(store, table, row)) fields.set(f, effectiveUnit(store, { table, row, field: f })!);
  // a row's parent and order key are one place (rules/place.ts)
  if (fields.has("parent") && fields.has("sort")) fields.set("sort", placedSort(fields.get("parent"), fields.get("sort")!));
  return { exists: star !== undefined && !star[0]!.deleted, star, fields };
}
/** Every (table, row key) in the store. */
export function rowKeys(store: Store, table?: string): { table: string; row: string }[] {
  const out: { table: string; row: string }[] = [];
  for (const k of ownFields(store).keys()) { const [t, row] = k.split(SEP) as [string, string]; if (!table || t === table) out.push({ table: t, row }); }
  return out.sort((x, y) => (x.table + SEP + x.row < y.table + SEP + y.row ? -1 : 1));
}

export type StoreEvent = { address: UnitAddress; result: MergeResult };
export type StoreMerge = {
  store: Store;
  /** What happened to each unit that changed or conflicted. `result.unit` is always the unit as the returned store shows it. */
  events: StoreEvent[];
  /** Refused for good: the sender made a mistake or is not following the format. */
  rejected: { address: UnitAddress; reason: Rejection }[];
  /**
   * Not taken yet: their clock is ahead of ours by more than the limit. The caller offers them again after its own clock has
   * moved on, and does not count the sender's progress past the first of them (nothing is dropped, nothing is skipped).
   */
  deferred: { address: UnitAddress; cells: Cell[] }[];
};

/** Merge `incoming` into `local`. Writes that are malformed or reuse a (origin, seq) with other content are refused (the rest of that unit with them); writes whose clock is too far ahead wait, one by one. */
export function mergeStore(local: Store, incoming: Store, gate?: SkewGate): StoreMerge {
  const rejected: StoreMerge["rejected"] = [], deferred: StoreMerge["deferred"] = [];
  const admitted = new Map<string, Unit>();
  for (const [key, unit] of incoming) {
    const bad = unit.map((c) => rejectReason(c)).find((r) => r !== null) ?? (local.get(key) && mergeUnit(local.get(key), unit).outcome === "rejected" ? "same-stamp-different-content" : null);
    if (bad) { rejected.push({ address: parseAddress(key), reason: bad }); continue; }
    const later = unit.filter((c) => deferReason(c, gate) !== null), now = unit.filter((c) => !later.includes(c));
    if (later.length) deferred.push({ address: parseAddress(key), cells: later });
    if (now.length) admitted.set(key, now);
  }
  const out = new Map<string, Unit>(local);
  const events: StoreEvent[] = [];
  const touched = new Map<string, { table: string; row: string }>();
  for (const key of admitted.keys()) { const a = parseAddress(key); touched.set(rowKeyOf(a), { table: a.table, row: a.row }); }
  for (const { table, row } of [...touched.values()].sort((x, y) => (x.table + SEP + x.row < y.table + SEP + y.row ? -1 : 1))) {
    for (const f of ownFields(local).get(`${table}${SEP}${row}`) ?? []) out.delete(addressKey({ table, row, field: f }));
    const starAddress = { table, row, field: STAR };
    const l = local.get(addressKey(starAddress)), i = admitted.get(addressKey(starAddress));
    const mstar = l && i ? mergeUnit(l, i).unit : l ?? i;
    if (mstar) out.set(addressKey(starAddress), mstar);
    if (i && mstar) { const r = describeUnitChange(l, mstar, i); if (r.outcome !== "same" || r.write) events.push({ address: starAddress, result: { ...r, deferred: [] } }); }
    for (const f of [...new Set([...fieldsOf(local, table, row), ...fieldsOf(admitted, table, row)])].sort()) {
      const address = { table, row, field: f };
      // Only the field's own writes are stored; what follows `*` is read from the merged `*`, so a creation value that a
      // tombstone or a later `*` write has replaced cannot come back from a message that arrives late.
      const stored = maximalHeads(droppedBySeen(mstar, [...(local.get(addressKey(address)) ?? []), ...(admitted.get(addressKey(address)) ?? [])]));
      if (stored.length) out.set(addressKey(address), stored);
      const after = effectiveUnit(out, address);
      if (!after) continue; // it followed a `*` that is gone: the event of `*` says so, there is no unit left to describe
      const r = describeUnitChange(effectiveUnit(local, address), after, [...(admitted.get(addressKey(address)) ?? []), ...derived(i, f)]);
      if (r.outcome !== "same" || r.write) events.push({ address, result: { ...r, deferred: [] } });
    }
  }
  return { store: out, events, rejected, deferred };
}

/**
 * Make a row (its creation values in `values`, field name → value). Made again over a row that is there (a permanent delete
 * that was undone, a derived id made on a second node that had already got part of it), it replaces what the node holds:
 * `*` covers the old `*`, and every field the node already has a value for gets a write of its own with the same stamp
 * that covers that field's heads, so the recreator's values win over what it saw and over nothing it did not.
 */
export function createRow(store: Store, a: { table: string; row: string }, stamp: Stamp, values: Fields, by: "person" | "system" = "person"): Store {
  const address = addressKey({ ...a, field: STAR });
  // made again over a delete (or over a creation that already carries what a delete had seen): the new creation keeps that, so the writes the deleter had seen stay ended
  const seen = seenByDelete(store.get(address), true);
  const next = new Map(store).set(address, writeUnit(store.get(address), stamp, { value: values, ...(Object.keys(seen).length ? { meta: { seen } } : {}) }, by));
  for (const [field, value] of Object.entries(values)) {
    const there = effectiveUnit(store, { ...a, field });
    if (there) next.set(addressKey({ ...a, field }), writeUnit(there, stamp, { value }, by));
  }
  return next;
}
/** Change one field (or one JSON key): the write has seen what the field is now, which replaces it, conflict included. */
export function writeField(store: Store, a: UnitAddress, stamp: Stamp, change: ({ value: Json } | { deleted: true }) & { meta?: Json }, by: "person" | "system" = "person"): Store {
  const there = effectiveUnit(store, a), next = writeUnit(there, stamp, change, by);
  return next === there ? store : new Map(store).set(addressKey(a), next);
}
/** Delete the row for good (a tombstone on `*`). The fields stay: a field somebody wrote and the deleter had not seen is theirs (rules/trash.ts). */
export function deleteRow(store: Store, a: { table: string; row: string }, stamp: Stamp, meta?: Json): Store {
  const address = addressKey({ ...a, field: STAR });
  return new Map(store).set(address, writeUnit(store.get(address), stamp, { deleted: true, ...(meta === undefined ? {} : { meta }) }));
}

/** The keys of a JSON column as they stand: key → value, for keys whose winning write is not a tombstone. */
export function jsonObjectOf(store: Store, table: string, row: string): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const f of fieldsOf(store, table, row)) {
    if (!f.startsWith("key:")) continue;
    const win = effectiveUnit(store, { table, row, field: f })![0]!;
    if (!win.deleted) out[f.slice(4)] = win.value!;
  }
  return out;
}

export const storeText = (store: Store): string => [...store.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, u]) => `${k}=${canonical(u)}`).join("\n");

/** What a node holds of a row, as one number per origin: for the deleting write to carry (`Deletion.seen` in rules/trash.ts). Only for deciding who is told; never for what is kept. */
export function seenOfRow(store: Store, table: string, row: string): Record<string, number> {
  const seen: Record<string, number> = {};
  const add = (u: Unit | undefined) => { for (const c of u ?? []) { for (const [o, n] of Object.entries(c.saw)) seen[o] = Math.max(seen[o] ?? -1, n); seen[c.stamp.origin] = Math.max(seen[c.stamp.origin] ?? -1, c.stamp.seq); } };
  add(store.get(addressKey({ table, row, field: STAR })));
  for (const f of fieldsOf(store, table, row)) add(effectiveUnit(store, { table, row, field: f }));
  return seen;
}
