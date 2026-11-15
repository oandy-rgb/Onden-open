// Where the navigation layout (lib/navLayout) is kept: on the server under the
// pref key "nav" and in a local copy; the contract is lib/syncedPrefStore's.
// null is the default layout (never edited, or 「恢復預設」). Only after a sync
// reached the server (`settled`) may the shell prune ids that are gone.

import { createAccountPref } from "./accountPrefStore";
import { PREFS } from "./prefs";
import { parseNavLayout, type NavLayout } from "./navLayout";
import { useSyncedPref, type SyncedPrefStore } from "./syncedPrefStore";

export type NavLayoutStore = SyncedPrefStore<NavLayout>;

export const navLayoutPref = createAccountPref<NavLayout>({
  serverKey: "nav",
  follows: "account", // destination order is the person's; only how many the phone bar shows is screen-specific (judgment call, see PR audit)
  copy: PREFS.navLayout, parse: parseNavLayout,
});

export const navLayoutStore: NavLayoutStore = navLayoutPref.store;

/** The layout and a way to change it (lib/syncedPrefStore useSyncedPref). */
export function useNavLayout(store: NavLayoutStore = navLayoutStore) {
  return useSyncedPref(store, store === navLayoutStore ? navLayoutPref.bound : () => true);
}
