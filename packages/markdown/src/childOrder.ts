// The order of one parent's children, shared by the app and the published site so a note sits in the same place on
// both: order_key, then order_stamp, then id (orderKey.ts compareOrdered; the backend lists children
// ORDER BY order_key COLLATE "C", order_stamp COLLATE "C", id). A site published before order keys carries only the
// integer sort_order: rows that all have no key fall back to it (then creation time, then id, as they always did).

import { compareOrdered } from "./orderKey.js";

export type OrderedChild = { id?: string; order_key?: string | null; order_stamp?: string | null; sort_order?: number | null; created_at?: string | null };

/** A row without a key (an optimistic row the server has not answered yet, or a snapshot from before order keys)
 *  compares by the legacy rule when the other has none either; a row without one sorts last (a new note not yet answered by the server). */
export function compareChildren(a: OrderedChild, b: OrderedChild): number {
  if (a.order_key || b.order_key) {
    if (!a.order_key || !b.order_key) return a.order_key ? -1 : 1;
    return compareOrdered(a, b);
  }
  const bySort = (a.sort_order ?? 0) - (b.sort_order ?? 0);
  if (bySort) return bySort;
  if (!a.created_at || !b.created_at) return 0;
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1
    : (a.id ?? "") < (b.id ?? "") ? -1 : (a.id ?? "") > (b.id ?? "") ? 1 : 0;
}

export function sortChildren<T extends OrderedChild>(nodes: readonly T[]): T[] {
  return [...nodes].sort(compareChildren);
}

/** Titles in the order a reader of the site expects (Traditional-Chinese
 *  collation, whatever locale the server or browser runs in). Every place that
 *  orders published titles — the site's pages and its rebuild diff, the
 *  studio's lists — uses this, so the preview and the published order agree. */
export function compareTitles(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hant");
}

/** Text that sorts as written, by UTF-16 unit and in no locale: ISO timestamps,
 *  ids, file paths. (Not for what a person reads: that is compareTitles.) */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
