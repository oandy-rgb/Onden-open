import { useSyncExternalStore } from "react";

// Whether the open note's title has scrolled up under the phone's top bar. The
// editor hands over its title element; the bar (a different part of the tree)
// reads the answer. One IntersectionObserver, no scroll listener: it fires only
// when the title crosses the bar's edge.

/** The phone top bar's height; the title counts as covered once it is above this. */
const BAR_HEIGHT_PX = 48;

let scrolledPast = false;
let observer: IntersectionObserver | null = null;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (next === scrolledPast) return;
  scrolledPast = next;
  listeners.forEach((l) => l());
}

/** Watch this title element (null: stop; the answer goes back to "not scrolled past"). */
export function trackNoteTitle(el: Element | null) {
  observer?.disconnect();
  observer = null;
  set(false);
  if (!el || typeof IntersectionObserver === "undefined") return;
  observer = new IntersectionObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    set(!entry.isIntersecting && (entry.boundingClientRect?.bottom ?? 0) <= BAR_HEIGHT_PX);
  }, { rootMargin: `-${BAR_HEIGHT_PX}px 0px 0px 0px` });
  observer.observe(el);
}

export function useNoteTitleScrolledPast(): boolean {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => scrolledPast,
    () => false,
  );
}

/** Whether this environment can watch elements scroll into view (false in jsdom and very old browsers). */
export function canObserveIntersection(): boolean {
  return typeof IntersectionObserver !== "undefined";
}

/** Call `onChange` with the entries each time an element in `target` crosses the root's edge; returns the stop
 *  function, or null when `canObserveIntersection()` is false. The one place besides the note title that creates
 *  an IntersectionObserver for a component. */
export function observeIntersection(
  target: Element,
  onChange: (entries: IntersectionObserverEntry[]) => void,
  options?: IntersectionObserverInit,
): (() => void) | null {
  if (!canObserveIntersection()) return null;
  const observer = new IntersectionObserver(onChange, options);
  observer.observe(target);
  return () => observer.disconnect();
}
