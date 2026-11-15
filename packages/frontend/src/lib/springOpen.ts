// Spring-loaded folders for the sidebar's drag: a held note that STAYS over a folded row opens it, so the
// person can drop deeper without leaving the drag. One timer for the notes tree and the tag list
// (hooks/useSidebarDrag owns the instance); what "opened" means (a temporary set, never saved) is the caller's.

/** How long a held note must stay over a folded row before it opens (ms). */
export const SPRING_OPEN_MS = 700;
/** The same on touch: a fingertip drifts and the hold already cost HOLD_MS, so it waits a little longer. */
export const SPRING_OPEN_TOUCH_MS = 900;

export interface SpringOpen {
  /** The row now under the held note and eligible to open (`null`: none). Staying on the same row keeps the
   *  running timer, however the pointer wanders inside it; moving to another row (or none) restarts or clears it. */
  hover(rowId: string | null): void;
  /** The row now waiting (or opened) — a hovering held note may keep it as the candidate beyond the row's
   *  "into" band so a drifting finger does not restart the wait. */
  current(): string | null;
  /** Drop the timer and forget the row (drag over, cancelled, unmounted). */
  cancel(): void;
}

/** `onArm(id)` fires when the timer starts (draw the waiting hint), `onDisarm()` when it is cleared without
 *  opening, `onOpen(id)` when the row has waited long enough. After `onOpen` the row is not armed again until
 *  the held note has left it and come back. */
export function createSpringOpen(
  delayMs: number,
  on: {
    onArm(id: string): void; onDisarm(): void; onOpen(id: string): void;
    /** At expiry: the folded row under the pointer NOW. The list can move under a still pointer (wheel, rows
     *  arriving) without any pointermove, so the row armed earlier may no longer be the one under it; if it
     *  differs, the old row is not opened and the new one starts its own wait. */
    stillOver?(): string | null;
  },
): SpringOpen {
  let rowId: string | null = null;
  let opened = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const self: SpringOpen = {
    hover(next) {
      if (next === rowId) return;
      const hadHint = rowId !== null && !opened;
      clearTimer();
      rowId = next;
      opened = false;
      if (hadHint) on.onDisarm();
      if (next === null) return;
      on.onArm(next);
      timer = setTimeout(() => {
        timer = null;
        const now = on.stillOver ? on.stillOver() : next;
        if (now !== next) { self.hover(now); return; }
        opened = true;
        on.onOpen(next);
      }, delayMs);
    },
    current: () => rowId,
    cancel() {
      clearTimer();
      const hadHint = rowId !== null && !opened;
      rowId = null;
      opened = false;
      if (hadHint) on.onDisarm();
    },
  };
  return self;
}
