// What a per-page ink surface needs from the browser and the app's lib/ — kept here so the page book
// (src/pagebook), which may import lib/ink but not the rest of lib/, gets it without reaching for
// window, ResizeObserver or IntersectionObserver itself.

import { useEffect, useState } from "react";
import { onWindow } from "../globalEvents";
import { canObserveIntersection, observeIntersection } from "../noteTitleVisibility";
import { observeSize } from "../observeSize";
import { pixelRatio } from "../pageEnvironment";

export { observeSize, pixelRatio };

/** Whether the element is on screen or within about half a screen of it, in the scroller matching
 *  `scrollerSelector` (its closest ancestor). Without IntersectionObserver (tests) it always is. */
export function useNearScreen(ref: { current: HTMLElement | null }, scrollerSelector: string): boolean {
  const [near, setNear] = useState(!canObserveIntersection());
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.closest(scrollerSelector);
    return observeIntersection(
      el,
      (entries) => { for (const entry of entries) setNear(entry.isIntersecting); },
      { root, rootMargin: "50% 0px" },
    ) ?? undefined;
  }, [ref, scrollerSelector]);
  return near;
}

/** `onEnd` when any pointer is released or cancelled, wherever on the page that happens (a stroke
 *  can end outside the element it began on). Returns stop. */
export function onPointerEnd(onEnd: () => void): () => void {
  const stops = ["pointerup", "pointercancel"].map((type) => onWindow(type, onEnd));
  return () => { for (const stop of stops) stop(); };
}
