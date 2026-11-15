/** Up/Down in a list of options that is driven from a text field (combobox, palette, picker).
 *  Returns the new active index, or `null` when `key` is not a list-navigation key (the caller
 *  handles it, and calls `preventDefault` when this returns a number). The active row stops at
 *  either end (it never wraps, unlike a menu: ui/usePopover) and skips rows `isDisabled` marks. */
export const isListNavKey = (key: string) => key === "ArrowDown" || key === "ArrowUp";

export function stepActive(key: string, active: number, count: number, isDisabled?: (index: number) => boolean): number | null {
  const dir = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
  if (dir === 0) return null;
  for (let i = active + dir; i >= 0 && i < count; i += dir) {
    if (!isDisabled?.(i)) return i;
  }
  return Math.min(Math.max(active, 0), Math.max(count - 1, 0));
}

/** Arrow keys in a radio group (cards, segments): the index to choose next, wrapping at the ends,
 *  or `null` when `key` is not an arrow (the caller calls `preventDefault` when this returns a number).
 *  Unlike `stepActive` this moves with ←/→ as well, and wraps. */
export function stepRadio(key: string, active: number, count: number): number | null {
  const dir = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  if (dir === 0 || count === 0) return null;
  return (active + dir + count) % count;
}
