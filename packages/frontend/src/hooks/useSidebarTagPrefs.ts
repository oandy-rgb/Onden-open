// The account's pinned and hidden sidebar tags (lib/sidebarTagsStore), shared
// by the phone's 標籤 tab, the desktop sidebar section and the tag page's pin
// button. Pins used to be this device's list (onden.pinnedTagViews); a list
// still there is moved into the account once, when the account has none yet.

import { useCallback, useEffect, useMemo } from "react";
import { getPref, PREFS, removePref } from "../lib/prefs";
import { sidebarTagsBound, sidebarTagsStore, NO_SIDEBAR_TAGS, type SidebarTags } from "../lib/sidebarTagsStore";
import { useSyncedPref } from "../lib/syncedPrefStore";

export function useSidebarTagPrefs(): {
  pinned: readonly string[];
  hidden: ReadonlySet<string>;
  isPinned: (tagId: string) => boolean;
  isHidden: (tagId: string) => boolean;
  togglePin: (tagId: string) => void;
  toggleHidden: (tagId: string) => void;
} {
  const { value, settled, save } = useSyncedPref(sidebarTagsStore, sidebarTagsBound);
  const current: SidebarTags = value ?? NO_SIDEBAR_TAGS;

  // Once the server has been asked, an account with no list of its own takes
  // the device's old pins; either way the old key is gone afterwards.
  useEffect(() => {
    if (!settled) return;
    const old = getPref(PREFS.pinnedTagViews);
    if (old === null) return;
    const ids = old.split(",").filter(Boolean);
    if (sidebarTagsStore.get().value === null && ids.length > 0) sidebarTagsStore.save({ pinned: ids, hidden: [] });
    removePref(PREFS.pinnedTagViews);
  }, [settled]);

  const hidden = useMemo(() => new Set(current.hidden), [current.hidden]);
  const edit = useCallback((change: (now: SidebarTags) => SidebarTags) => save(change(sidebarTagsStore.get().value ?? NO_SIDEBAR_TAGS)), [save]);
  const toggle = (list: readonly string[], id: string) => list.includes(id) ? list.filter((other) => other !== id) : [...list, id];
  return {
    pinned: current.pinned,
    hidden,
    isPinned: (tagId) => current.pinned.includes(tagId),
    isHidden: (tagId) => hidden.has(tagId),
    togglePin: (tagId) => edit((now) => ({ ...now, pinned: toggle(now.pinned, tagId) })),
    toggleHidden: (tagId) => edit((now) => ({ ...now, hidden: toggle(now.hidden, tagId) })),
  };
}
