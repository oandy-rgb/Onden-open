// Phone "back returns to where I was in the list".
//
// On a phone the list and the note are different screens that share the
// document's scroll, so opening a note collapses the page and Back would land
// at the top. This module keeps the page scroll per screen key in memory (a
// session, not storage: a reload may legitimately start at the top) and puts it
// back when a BACK navigation returns to that screen. Forward navigation to a
// screen always starts at the top, so only Back restores.

const positions = new Map<string, number>();
let backPending = false;

/** Record the page scroll for a screen. */
export function rememberPageScroll(key: string, y: number): void {
  positions.set(key, Math.max(0, Math.round(y)));
}

/** Call from every Back (header button, link trail, browser popstate) right
 *  before the state change; the next screen change consumes it. */
export function markBackNavigation(): void {
  backPending = true;
}

/** Decide what the screen we just arrived at should scroll to: the remembered
 *  position after a Back, 0 (and the stale entry dropped) after a forward
 *  navigation. Consumes the Back mark. */
export function consumeScrollTarget(key: string): number {
  const back = backPending;
  backPending = false;
  if (!back) {
    positions.delete(key);
    return 0;
  }
  return positions.get(key) ?? 0;
}

export function clearPageScrollMemory(): void {
  positions.clear();
  backPending = false;
}

/**
 * Scroll the window to `target`: at once when the document is already tall
 * enough (call it where the screen is committed, before the browser paints, or
 * the screen shows for a frame at the wrong place), else on each frame while it
 * grows (the list re-renders after data load, and a windowed list's spacers only
 * give the height once it has measured). Gives up when the user scrolls
 * themselves, or after `timeoutMs`. Returns a cancel function.
 */
export function restoreWhenTall(target: number, timeoutMs = 2000): () => void {
  if (target <= 0 || typeof window === "undefined") return () => {};
  let done = false;
  let frame = 0;
  const started = performance.now();
  let lastSet = -1;
  const finish = () => {
    done = true;
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener("wheel", finish);
    window.removeEventListener("touchstart", finish);
  };
  const tick = () => {
    frame = 0;
    if (done) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max >= target) {
      window.scrollTo(0, target);
      // The scroll can shift the windowed list (spacers re-render); confirm
      // on the next frame before stopping.
      if (lastSet === target && Math.abs(window.scrollY - target) <= 1) return finish();
      lastSet = target;
    } else if (max > window.scrollY) {
      window.scrollTo(0, max);
    }
    if (performance.now() - started > timeoutMs) return finish();
    frame = requestAnimationFrame(tick);
  };
  window.addEventListener("wheel", finish, { passive: true });
  window.addEventListener("touchstart", finish, { passive: true });
  tick();
  return finish;
}
