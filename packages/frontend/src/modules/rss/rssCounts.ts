import { useRssPrefsInSync, rssFeedCountsPref, rssShowCountsPref, type FeedCountChoice } from "./rssPrefs";
import { useOption } from "../../settings/useOption";
import type { BoolSettingDef } from "../../lib/settingsTypes";
import type { RssSource } from "./useRssUnread";

// Whether the reader shows numbers. Off by default: the nav says "something
// new" with a dot, and the feed list shows names only, so a backlog never
// reads as a debt. 「顯示未讀數字」 (Settings › Features › Reading) turns them
// back on; a feed can differ from it ("on"/"off" in its ⋯ sheet). Both are
// kept per account (rssPrefs), so they are the same on every device. The total
// (All feeds, the 閱讀 entry) follows the setting and adds up the feeds whose
// own number is shown.

export const SHOW_COUNTS_SETTING: BoolSettingDef = {
  id: "modules.rss_show_counts",
  tab: "modules",
  label: "Show unread numbers",
  description: "Show how many articles are new beside Reading and each feed. Off: Reading shows a small dot when something new arrives. Saved with your account, on every device.",
  keywords: ["unread", "count", "badge", "number", "未讀", "數字"],
  type: "boolean",
  default: false,
  get: () => rssShowCountsPref.store.get().value ?? false,
  set: (v) => rssShowCountsPref.store.save(v),
  subscribe: (listener) => rssShowCountsPref.store.subscribe(listener),
};

export type { FeedCountChoice };

/** Set (or clear, with null) one feed's own choice. */
export function setFeedCountChoice(sourceId: string, choice: FeedCountChoice | null): void {
  const next = { ...(rssFeedCountsPref.store.get().value ?? {}) };
  if (choice) next[sourceId] = choice;
  else delete next[sourceId];
  rssFeedCountsPref.store.save(next);
}

export type RssCounts = {
  /** The 「顯示未讀數字」 setting. */
  global: boolean;
  /** A feed's own choice, null when it follows the setting. */
  choiceFor: (sourceId: string) => FeedCountChoice | null;
  /** Whether a feed's row shows its number. */
  showFor: (sourceId: string) => boolean;
  /** The number beside All feeds and 閱讀: null when numbers are off. */
  total: (sources: readonly RssSource[] | null) => number | null;
};

export function rssCounts(global: boolean, overrides: Record<string, FeedCountChoice>): RssCounts {
  const choiceFor = (id: string) => overrides[id] ?? null;
  const showFor = (id: string) => { const c = choiceFor(id); return c ? c === "on" : global; };
  return {
    global,
    choiceFor,
    showFor,
    total: (sources) => global ? (sources ?? []).reduce((n, s) => n + (showFor(s.id) ? s.unseen : 0), 0) : null,
  };
}

export function useRssCounts(): RssCounts {
  useRssPrefsInSync();
  const [global] = useOption(SHOW_COUNTS_SETTING);
  const { value: overrides } = rssFeedCountsPref.useValue();
  return rssCounts(global, overrides ?? {});
}
