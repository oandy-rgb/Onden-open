import { addDays, dateIdAt } from "../../lib/localDate";

// The list is cut by day — 今天 / 昨天 / 更早 — instead of by read state: the
// list is a stream to move down, with a faint line at the place you were last
// time, not a pile to clear. The day is the workspace's (localDate), the same
// "today" the journal uses.

export type DaySection = "today" | "yesterday" | "earlier";

/** Which section an article dated `at` (ISO time) belongs to on `today` (a date id). */
export function daySection(at: string | null, today: string): DaySection {
  if (!at) return "earlier";
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return "earlier";
  const day = dateIdAt(time);
  if (day >= today) return "today"; // a clock a little ahead of ours is still today
  return day === addDays(today, -1) ? "yesterday" : "earlier";
}

export type ListRow<T> =
  | { kind: "section"; key: DaySection }
  | { kind: "last-read"; key: string }
  | { kind: "item"; key: string; item: T };

/** The list as rows: a heading where the section changes, and the 「上次讀到
 *  這裡」 line just above the article you were last on — unless that is the
 *  first one (nothing newer to cross). `lastReadId` is read once per visit. */
export function listRows<T extends { id: string; published_at: string | null; fetched_at: string }>(
  items: readonly T[], today: string, lastReadId: string | null,
): Array<ListRow<T>> {
  const rows: Array<ListRow<T>> = [];
  let section: DaySection | null = null;
  items.forEach((item, i) => {
    const s = daySection(item.published_at ?? item.fetched_at, today);
    if (s !== section) { section = s; rows.push({ kind: "section", key: s }); }
    if (lastReadId === item.id && i > 0) rows.push({ kind: "last-read", key: item.id });
    rows.push({ kind: "item", key: item.id, item });
  });
  return rows;
}
