// A row's place among its siblings is ONE thing: its parent and its order key (docs/research/sync-design-vs-literature-2026-11-16.md item 8). An order key only means
// something under the parent it was chosen under, so the key a row shows must come from the write that set its parent, or from a later write that had seen it.
//
// The two are stored as two units (`parent`, `sort`), and every write that changes the parent also stamps the order key with the same stamp (migration 209: the stamp
// trigger stamps `sort` together with `parent`). So the write that set the winning parent is always among the writes to `sort`: as a head, or covered by a head that saw it.
// The rule: the order key shown is the best head of `sort` that IS that write or had seen it (`covers`). A head of `sort` that had not seen the winning parent (a reorder under the
// parent the move left) stays a head, a conflict its author can see, and is never shown under the new parent. It is a function of the two units' heads, so every node shows the same.
//
// When the winning parent write is not among the writes to `sort` at all (a stamp made before migration 209, when a move could leave the key untouched; or a genesis parent), no
// head is tied to it and the key is the best head of `sort`, as before: such a write was made on one node with the key that node held, and no exchange happened before 209.
//
//   const sort = placedSort(parentUnit, sortUnit);   // the same heads, the one to show first
import { type Unit, covers, isGenesis, stampKey } from "../unit.js";

/** The heads of `sort` with the one to show first (the rest in their order). `parent` undefined: the row has no parent unit (nothing to tie the key to). */
export function placedSort(parent: Unit | undefined, sort: Unit): Unit {
  const p = parent?.[0];
  if (!p || isGenesis(p) || sort.length < 2) return sort;
  const tied = sort.find((h) => !isGenesis(h) && (stampKey(h.stamp) === stampKey(p.stamp) || covers(h, { ...p, saw: {} })));
  if (!tied || tied === sort[0]) return sort;
  return [tied, ...sort.filter((h) => h !== tied)];
}
