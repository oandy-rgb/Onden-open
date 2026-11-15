// Where the toolbar layout (lib/toolbarLayout) is kept: on the server under the
// pref keys "toolbarLayout.phone" / "toolbarLayout.desktop" (one per kind of screen,
// lib/accountPrefStore `deviceKind`) and in a local copy, so it follows the account to
// every device of that kind; the contract is lib/syncedPrefStore's. null is the default.

import { createAccountPref } from "./accountPrefStore";
import { PREFS } from "./prefs";
import { parseToolbarLayout, type ToolbarLayout } from "./toolbarLayout";
import { useSyncedPref, type SyncedPrefStore } from "./syncedPrefStore";

export type ToolbarLayoutStore = SyncedPrefStore<ToolbarLayout>;

export const toolbarLayoutPref = createAccountPref<ToolbarLayout>({
  serverKey: "toolbarLayout",
  follows: "deviceKind", // a phone's toolbar is much narrower: a desktop arrangement must not land on it (owner, 2026-11-09)
  copy: PREFS.toolbarLayout, parse: parseToolbarLayout,
});

export const toolbarLayoutStore: ToolbarLayoutStore = toolbarLayoutPref.store;

/** The layout (null: the default) and a way to change it (lib/syncedPrefStore useSyncedPref). */
export function useToolbarLayout(store: ToolbarLayoutStore = toolbarLayoutStore) {
  return useSyncedPref(store, store === toolbarLayoutStore ? toolbarLayoutPref.bound : () => true);
}
