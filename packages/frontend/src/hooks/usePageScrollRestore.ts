import { useEffect, useLayoutEffect, useRef } from "react";
import { ownPageScrollRestoration } from "../lib/pageUrl";
import { consumeScrollTarget, rememberPageScroll, restoreWhenTall } from "../lib/pageScrollRestore";

/**
 * Keep the phone page scroll per screen (see lib/pageScrollRestore). `screenKey`
 * names the screen — the list, or one note — and `enabled` is the phone layout:
 * desktop panes own their scroll and are left alone.
 */
export function usePageScrollRestore(screenKey: string, enabled: boolean): void {
  const keyRef = useRef(screenKey);

  useEffect(() => {
    if (!enabled) return;
    const releaseRestoration = ownPageScrollRestoration();
    let frame = 0;
    const record = () => {
      frame = 0;
      rememberPageScroll(keyRef.current, window.scrollY);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(record); };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      releaseRestoration();
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled]);

  // Layout effect: switch the key before the browser's clamp-to-shorter-page
  // scroll event can be recorded under the screen we just left.
  useLayoutEffect(() => {
    keyRef.current = screenKey;
  }, [screenKey]);

  // Layout effect too: restoring after paint shows the screen at the wrong place for a frame, then jumps.
  useLayoutEffect(() => {
    if (!enabled) return;
    return restoreWhenTall(consumeScrollTarget(screenKey));
  }, [screenKey, enabled]);
}
