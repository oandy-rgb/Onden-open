// The device's two ink input settings and who changes them (inputPolicy.ts
// explains what they do). One store: the ⋯ menu's switch, the settings page,
// the first-pen detection and every ink host read and write here, so they
// cannot disagree. Kept in this browser only (a Tab S9 and a phone differ).
//
//   finger  "scroll"   a finger only scrolls and zooms with a drawing tool
//           "toolbar"  a finger follows the toolbar (it draws with the pen tool)
//   pen     "draws"    the pen draws with the last drawing tool in every tool
//           "toolbar"  the pen follows the toolbar like a finger
//
// The stored finger value is the old `inkStylusOnly` flag ("1" = scroll), so a
// device keeps its choice. Nothing is stored until a choice is made, which is
// what lets the first pen put a new device into pen mode without overriding
// anyone's decision.

import { PREFS, getPref, setPref } from "./prefs";

export type FingerSetting = "scroll" | "toolbar";
export type PenSetting = "draws" | "toolbar";

export const getFingerSetting = (): FingerSetting => (getPref(PREFS.inkStylusOnly) === "1" ? "scroll" : "toolbar");
export const getPenSetting = (): PenSetting => (getPref(PREFS.inkPenDraws) === "0" ? "toolbar" : "draws");

const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** Calls `listener` after any change made through this module. Returns stop. */
export function subscribeInkInputPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setFingerSetting(value: FingerSetting): void {
  setPref(PREFS.inkStylusOnly, value === "scroll" ? "1" : "0");
  notify();
}

export function setPenSetting(value: PenSetting): void {
  setPref(PREFS.inkPenDraws, value === "draws" ? "1" : "0");
  notify();
}

/** A pen touched an ink surface. On a device that never chose a finger setting
 *  this is the switch into pen mode: fingers only scroll from now on. Returns
 *  true when it did that (the caller says so once). */
export function notePenSeen(): boolean {
  if (getPref(PREFS.inkStylusOnly) !== null) return false;
  setFingerSetting("scroll");
  return true;
}
