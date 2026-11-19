// Dialogs and cards of the shell that nobody sees at first paint: each is fetched when it is
// first rendered, so none of them is in the boot JS (scripts/check-boot-bundle.mjs). The loader
// is the same function the screen's lazyWithReload() calls; lib/offlineWarmup.ts fetches them all ahead
// (loadLateShellScreens) so they also open offline.
export const loadTagDeleteConfirm = () => import("./TagDeleteConfirm");
export const loadTagMoveConfirm = () => import("./TagMoveConfirm");
export const loadMoveToSpaceConfirm = () => import("./MoveToSpaceConfirm");
export const loadShortcutsCheatsheet = () => import("./ShortcutsCheatsheet");
export const loadTimeZoneAsk = () => import("./TimeZoneAsk");
// The 「移動…」 list under the note's breadcrumb and the phone's location bar: only after a tap.
// The quiet 「n 個沒用的標籤」 line at the foot of the tag list: absent when nothing needs tidying.
export const loadTagTidy = () => import("./TagTidy");
export const loadParentPicker = () => import("./ParentPicker");

const LATE_SHELL_SCREENS: ReadonlyArray<() => Promise<unknown>> = [
  loadTagDeleteConfirm,
  loadTagMoveConfirm,
  loadMoveToSpaceConfirm,
  loadShortcutsCheatsheet,
  loadTimeZoneAsk,
  loadParentPicker,
  loadTagTidy,
];

/** Fetches every screen above (lib/offlineWarmup), one at a time like the rest of the warm-up. */
export async function loadLateShellScreens(): Promise<void> {
  for (const load of LATE_SHELL_SCREENS) await load();
}
