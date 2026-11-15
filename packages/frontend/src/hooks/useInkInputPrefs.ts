import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { addToast } from "../lib/appStore";
import { t } from "../lib/i18n";
import { deviceHasTouch } from "../lib/ink";
import {
  getFingerSetting, getPenSetting, notePenSeen, setFingerSetting, subscribeInkInputPrefs,
} from "../lib/inkInputPrefs";
import { PREFS, getPref, removePref, setPref } from "../lib/prefs";

/** Set by the migration below, shown once by the first hook that mounts. */
let migrationNoticePending = false;

/**
 * Carry the retired finger settings over (once per device).
 *
 * Before the tools model, a finger panned when `onden.ink.fingerMode` was
 * "pan", or "auto" with a pen remembered in `onden.ink.penSeen`. That hidden
 * state decided silently; it must not keep doing so. If it made fingers pan
 * here, the finger setting is switched to "only scroll" — visible as the
 * ⋯ menu's 「手指也能畫」 being off plus a one-time notice — so nothing
 * changes behind the person's back and one tap turns it off. Anyone whose
 * fingers drew keeps drawing (the new default).
 * Returns true when it switched fingers to scroll. Idempotent: the old keys are
 * removed, and an explicit new-style choice is never overwritten.
 */
export function migrateLegacyFingerPrefs(): boolean {
  const mode = getPref(PREFS.inkFingerMode);
  const seen = getPref(PREFS.inkPenSeen);
  if (mode === null && seen === null) return false;
  removePref(PREFS.inkFingerMode);
  removePref(PREFS.inkPenSeen);
  if (getPref(PREFS.inkStylusOnly) !== null) return false;
  const fingersScrolled = mode === "pan" || (mode !== "draw" && seen === "1");
  if (!fingersScrolled) return false;
  setPref(PREFS.inkStylusOnly, "1");
  migrationNoticePending = true;
  return true;
}

/**
 * The device-level input settings every ink host shares (lib/inkInputPrefs):
 * `stylusOnly` — fingers only scroll with a drawing tool (the policy's name for
 * the finger setting) — and `penDraws` — the pen draws in every tool. Hosts
 * pass both to their engine (`setInputPrefs`) and call `onPenSeen` from the
 * engine's first pen touch.
 */
export function useInkInputPrefs() {
  // Before the settings read storage, so they see a migrated value.
  useState(migrateLegacyFingerPrefs);
  const stylusOnly = useSyncExternalStore(subscribeInkInputPrefs, () => getFingerSetting() === "scroll");
  const penDraws = useSyncExternalStore(subscribeInkInputPrefs, () => getPenSetting() === "draws");
  const [touchCapable] = useState(deviceHasTouch);
  const toggleFingerDraws = useCallback(() => setFingerSetting(getFingerSetting() === "scroll" ? "toolbar" : "scroll"), []);
  const onPenSeen = useCallback(() => {
    if (notePenSeen()) addToast(t("A pen was detected: fingers now only scroll. To draw with a finger too, turn on “Finger draws too” in the More menu."), "info");
  }, []);
  useEffect(() => {
    if (!migrationNoticePending) return;
    migrationNoticePending = false;
    addToast(t("Stylus mode is on, carried over from your earlier setting: fingers only scroll. Turn on “Finger draws too” in the More menu to draw with a finger."), "info");
  }, []);
  return { stylusOnly, penDraws, touchCapable, toggleFingerDraws, onPenSeen };
}
