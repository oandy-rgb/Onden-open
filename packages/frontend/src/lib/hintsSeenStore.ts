// The one-time hints this account has already been shown, kept per account
// (lib/accountPrefStore, pref key "hintsSeen"), so a hint closed on the phone
// stays closed on the desktop. A hint is a string id (hooks/useHintOnce).
//
// A list only grows: saving sends the union of this device's list and the
// server's, so a device that was offline never erases a hint another device
// has since seen.

import { createAccountPref } from "./accountPrefStore";
import { PREFS } from "./prefs";
import type { SyncedPrefStore } from "./syncedPrefStore";

export type HintsSeen = readonly string[];

const MAX_HINTS = 100;

/** A stored value read back, or null when it is not a list of hint ids. */
export function parseHintsSeen(value: unknown): HintsSeen | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)) return null;
  return [...new Set(value as string[])].slice(0, MAX_HINTS);
}

const hintsSeenPref = createAccountPref<HintsSeen>({
  serverKey: "hintsSeen",
  follows: "account", // one-time hints already seen: should not reappear on another device
  copy: PREFS.hintsSeen,
  parse: parseHintsSeen,
  // Keep the merged list here too (the factory does), or a hint another device
  // saw stays unseen on this page until the next sync.
  merge: (theirs, mine) => [...new Set([...(theirs ?? []), ...mine])].slice(0, MAX_HINTS),
});

export const hintsSeenStore: SyncedPrefStore<HintsSeen> = hintsSeenPref.store;

export const hintsSeenBound = hintsSeenPref.bound;
