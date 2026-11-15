// The order of one parent's children, shared by the app and the published site
// so a note sits in the same place on both: sort_order, then creation time,
// then id (the backend lists children ORDER BY sort_order, created_at).

export type OrderedChild = { id?: string; sort_order?: number | null; created_at?: string | null };

/** A row without created_at (an optimistic note the server has not answered
 *  yet) stays where it was among equals, since Array.prototype.sort is stable.
 *  Two rows with the same created_at fall to id, so the order never depends on
 *  the order the rows arrived in. */
export function compareChildren(a: OrderedChild, b: OrderedChild): number {
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
