import { useEffect } from "react";
import { PORTRAIT_PHONE_QUERY } from "../lib/mediaQuery";
import { useMediaQuery } from "./useIsMobile";

/** `lock` is missing from the DOM typings and from some browsers (iOS Safari). */
const orientation = () => (typeof screen === "undefined" ? undefined : (screen.orientation as (ScreenOrientation & { lock?: (to: string) => Promise<void> }) | undefined));

/**
 * Presenting on a phone held upright: asks the browser for full screen with the screen turned sideways
 * (`requestFullscreen` + `screen.orientation.lock("landscape")`, which browsers only allow in full screen) and
 * gives the screen back when `active` ends. Browsers that do not support either, or refuse (iOS Safari, a
 * desktop), are left alone and nothing is shown about it: returns whether the screen is still upright, for the
 * caller's own "turn your phone" hint. Never leaves a full screen another surface owns.
 */
export function usePresentLandscape(active: boolean): boolean {
  const upright = useMediaQuery(PORTRAIT_PHONE_QUERY);
  useEffect(() => {
    if (!active || !upright) return;
    const root = document.documentElement;
    let owned = false;
    if (!document.fullscreenElement && root.requestFullscreen) {
      owned = true;
      void root.requestFullscreen()
        .then(() => orientation()?.lock?.("landscape"))
        .catch(() => { /* refused or unsupported: the hint stays */ });
    }
    return () => {
      try { orientation()?.unlock?.(); } catch { /* nothing was locked */ }
      if (owned && document.fullscreenElement === root) void document.exitFullscreen?.().catch(() => {});
    };
    // Once per presentation: turning the phone must not toggle full screen again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  return active && upright;
}
