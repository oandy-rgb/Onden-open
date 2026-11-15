// How far into the 「這次更新」 list this account has read (lib/whatsNew): the id
// of the newest change it has seen, kept per account (lib/accountPrefStore, pref
// key "changesSeen"), so a card closed on the phone stays closed on the desktop.
//
// It only moves forward: the server keeps the later id whatever the edit times
// (backend services/actorPrefs FORWARD_ORDER, ordered by the day the id starts with).

import { createAccountPref } from "./accountPrefStore";
import { PREFS } from "./prefs";
import { isNewerChange } from "./whatsNewText";
import type { SyncedPrefStore } from "./syncedPrefStore";

/** A stored value read back, or null when it is not a change id (`YYYY-MM-DD-…`). */
export function parseChangesSeen(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}[a-z0-9-]*$/.test(value) && value.length <= 100 ? value : null;
}

const changesSeenPref = createAccountPref<string>({
  serverKey: "changesSeen",
  follows: "account", // which updates they have read: same on every screen
  copy: PREFS.changesSeen,
  parse: parseChangesSeen,
  isNewer: isNewerChange,
});

export const changesSeenStore: SyncedPrefStore<string> = changesSeenPref.store;
export const changesSeenBound = changesSeenPref.bound;
