// The sidebar's tag list choices, kept per account (lib/syncedPrefStore, pref
// key "sidebarTags"), so the phone and the desktop show the same list:
//   pinned — tag ids listed first, in pin order;
//   hidden — tag ids left out of the sidebar list. Only that: the tag keeps
//            working everywhere else (this is not the tag's own 「隱藏標籤」,
//            which is the workspace's and lives on the tag page).
// null is "nothing pinned, nothing hidden".

import { createAccountPref } from "./accountPrefStore";
import { PREFS } from "./prefs";
import type { SyncedPrefStore } from "./syncedPrefStore";

export type SidebarTags = {
  /** Tag ids in pin order. */
  pinned: readonly string[];
  /** Tag ids not listed in the sidebar. */
  hidden: readonly string[];
};

export const NO_SIDEBAR_TAGS: SidebarTags = { pinned: [], hidden: [] };

/** A stored value read back, or null when it is not one. */
export function parseSidebarTags(value: unknown): SidebarTags | null {
  if (!value || typeof value !== "object") return null;
  const { pinned, hidden } = value as { pinned?: unknown; hidden?: unknown };
  const ids = (list: unknown): string[] | null =>
    Array.isArray(list) && list.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64) ? [...new Set(list as string[])] : null;
  const p = ids(pinned), h = ids(hidden);
  return p && h ? { pinned: p.slice(0, 200), hidden: h.slice(0, 1000) } : null;
}

export type SidebarTagsStore = SyncedPrefStore<SidebarTags>;

const sidebarTagsPref = createAccountPref<SidebarTags>({
  serverKey: "sidebarTags",
  follows: "account", // pinned and hidden tags: about their tags, not the screen
  copy: PREFS.sidebarTags, parse: parseSidebarTags,
});

export const sidebarTagsStore: SidebarTagsStore = sidebarTagsPref.store;

export const sidebarTagsBound = sidebarTagsPref.bound;
