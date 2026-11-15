import { useT, tn } from "../../lib/i18n";
import type { NavIndicatorProps } from "../types";
import { useRssCounts } from "./rssCounts";
import { useRssUnread } from "./useRssUnread";

/** The mark on RSS's navigation entries (閱讀 on the desktop bar or in its
 *  更多 ▾ menu, RSS in the phone's 更多 sheet, the hub's tab): a small dot
 *  when articles arrived since the reader was last open; with 「顯示未讀數字」
 *  on, the number of unseen articles instead. Nothing otherwise. `dotOnly`
 *  (a container folding the entry: 更多 ▾, the phone's 更多 button) shows a
 *  dot for either. */
export default function RssNavIndicator({ dotOnly = false }: NavIndicatorProps) {
  const t = useT();
  const { sources, hasNew } = useRssUnread();
  const counts = useRssCounts();
  const total = counts.total(sources);
  if (total !== null && !dotOnly) {
    if (total <= 0) return null;
    return (
      <span className="nav-indicator nav-indicator--count"
        aria-label={tn("1 new article", "{n} new articles", total)}>
        {total}
      </span>
    );
  }
  if (total !== null ? total <= 0 : !hasNew) return null;
  return <span className="nav-indicator nav-indicator--dot" role="img" aria-label={t("New articles")} />;
}
