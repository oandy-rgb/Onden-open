// How a player moves between steps: the keys and the swipe, as pure rules both
// the app's player and the site's small player ask (stepsEnhance.ts).

/** The step a key moves to from `index` of `count` steps, or null when the key
 *  is not one of the player's (or there is nowhere to go). */
export function stepForKey(key: string, index: number, count: number): number | null {
  const target = key === "ArrowLeft" || key === "PageUp" ? index - 1
    : key === "ArrowRight" || key === "PageDown" ? index + 1
    : key === "Home" ? 0
    : key === "End" ? count - 1
    : null;
  return target === null || target < 0 || target >= count || target === index ? null : target;
}

/** A horizontal swipe's step change: -1 (back), +1 (forward) or 0. Only a clear
 *  sideways move counts, so a vertical page scroll is left alone. */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  const MIN = 48;
  if (Math.abs(dx) < MIN || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}
