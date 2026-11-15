import { useLayoutEffect, type RefObject } from "react";
import { fadeOutDetached } from "../lib/mediaFadeOut";

/** Fade out a playing player when its component is removed. Layout-effect
 *  cleanups run before React removes the host DOM, so the element can still be
 *  moved out in time; the player must sit inside a wrapper element of its own
 *  so that React removes the wrapper, not the moved element. */
export function useFadeOutOnUnmount(ref: RefObject<HTMLMediaElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    return () => { if (el) fadeOutDetached(el); };
  }, [ref]);
}
