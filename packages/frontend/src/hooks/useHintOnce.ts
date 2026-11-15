// A hint shown once per account, on whichever device meets it first.
//
//   const { show, markSeen } = useHintOnce("hashtag-to-scope");
//   if (show) …render the hint; call markSeen() when it is shown or closed.
//
// `show` is false until this page has the server's list (or, offline, this
// device's copy), so a hint another device already showed never shows again.
// Marking is written to this device at once and to the server when it can be
// reached (lib/hintsSeenStore).
//
// `legacy` is the device flag the hint used before it was per account. A flag
// of "1" means it was already seen: it is carried into the account list once
// and the old key removed, so a hint someone closed does not return. Without
// an account to write to (before sign-in) the flag is only read.

import { isBrowserOnline } from "../lib/data";
import { useCallback, useEffect } from "react";
import { getPref, removePref, type Pref } from "../lib/prefs";
import { hintsSeenBound, hintsSeenStore } from "../lib/hintsSeenStore";
import { useSyncedPref } from "../lib/syncedPrefStore";

export function useHintOnce(id: string, legacy?: Pref): { show: boolean; markSeen: () => void } {
  const { value, settled } = useSyncedPref(hintsSeenStore, hintsSeenBound);
  const bound = hintsSeenBound();
  const legacySeen = legacy ? getPref(legacy) === "1" : false;
  const listed = value?.includes(id) ?? false;

  const markSeen = useCallback(() => {
    const now = hintsSeenStore.get().value ?? [];
    if (!now.includes(id)) hintsSeenStore.save([...now, id]);
  }, [id]);

  useEffect(() => {
    if (!legacy || !bound || getPref(legacy) === null) return;
    if (legacySeen) markSeen();
    removePref(legacy);
  }, [legacy, bound, legacySeen, markSeen]);

  // Known = this page heard the server's list. A copy kept on this device may
  // be older than another device's (it marked the hint since), so it only
  // decides while offline. Before an account is bound (sign-in, tests) the
  // list lives in memory only and is taken as is.
  const offline = !isBrowserOnline();
  const known = !bound || settled || (offline && value !== null);
  return { show: known && !listed && !legacySeen, markSeen };
}

