// Following one pressed pointer for a thing that is moved or stretched (the day timeline's blocks, the
// week board's cards). Kept apart from pointerDrag.ts, which the first screen needs: this loads with
// the screens that drag.

import { beginTouchHold, createEdgeAutoScroll, createTouchPressGuard, isHoldPointer, swallowNextClick } from "./touchHold";
import { capturePointer, DRAG_SLOP_PX } from "./pointerDrag";

// ── One drag of a thing the pointer is pressed on ──────────────────────────

export type PointerDragCallbacks = {
  /** Touch / pen with `hold`: the press stayed still long enough and the thing lifted. */
  onLift?: () => void;
  /** The pointer moved (past the drag slop, or after the lift). Viewport coordinates. */
  onDrag: (x: number, y: number) => void;
  /** The pointer came up. `dragged` false: it never left the slop (a press, a hold released in place). */
  onEnd: (x: number, y: number, dragged: boolean) => void;
  /** Escape, a cancelled pointer, or a scroll that took the finger: nothing is applied. */
  onCancel: () => void;
};

/** What `trackPointerDrag` hands back while the press is followed: `cancel` ends it with nothing applied
 *  (the caller's Esc, via hooks/useEscapeKey — the one Esc listener). */
export type PointerDragRun = { cancel: () => void };

/** Follows one pressed pointer until it is up, for a block that is moved or stretched.
 *  - Mouse (and a pen or finger when `hold` is false, e.g. a grip with `touch-action: none`):
 *    the pointer is captured and a drag starts after DRAG_SLOP_PX.
 *  - Finger or pen with `hold`: the shared hold gesture (touchHold) — scrolling before the
 *    lift cancels, the lift vibrates, and nothing scrolls under the finger afterwards.
 *  While dragging, `scroller` (if given) is scrolled when the pointer nears its edge, and
 *  `onDrag` is called again with the same pointer so the thing follows the scrolled content.
 *  A drag swallows the click that follows it. Returns null when the press is not ours. */
export function trackPointerDrag(
  event: React.PointerEvent<Element>,
  { hold, scroller, ...callbacks }: PointerDragCallbacks & { hold: boolean; scroller?: () => HTMLElement | null },
): PointerDragRun | null {
  if (event.button !== 0 || !event.isPrimary) return null;
  let active = true;
  const auto = createEdgeAutoScroll(() => active, (x, y) => callbacks.onDrag(x, y), { list: () => scroller?.() ?? null });
  const follow = (x: number, y: number) => { callbacks.onDrag(x, y); if (scroller) auto.start(x, y); };
  const stop = () => { active = false; auto.stop(); };

  if (hold && isHoldPointer(event.pointerType)) {
    const took = beginTouchHold(event, createTouchPressGuard(), {
      onLift: () => callbacks.onLift?.(),
      onDrag: follow,
      onRelease: (x, y, moved) => { stop(); callbacks.onEnd(x, y, moved); },
      onAbort: () => { stop(); callbacks.onCancel(); },
    });
    return took ? { cancel: () => { stop(); callbacks.onCancel(); } } : null;
  }

  const target = event.currentTarget;
  capturePointer(target, event.pointerId);
  const startX = event.clientX;
  const startY = event.clientY;
  let dragged = false;
  const finish = () => {
    stop();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
  };
  function onMove(ev: PointerEvent) {
    if (ev.pointerId !== event.pointerId) return;
    if (!dragged) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_SLOP_PX) return;
      dragged = true;
    }
    follow(ev.clientX, ev.clientY);
  }
  function onUp(ev: PointerEvent) {
    if (ev.pointerId !== event.pointerId) return;
    finish();
    if (dragged) swallowNextClick();
    callbacks.onEnd(ev.clientX, ev.clientY, dragged);
  }
  function onCancel() { finish(); callbacks.onCancel(); }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  return { cancel: () => { if (dragged) swallowNextClick(); onCancel(); } };
}

/** The nearest element matching `selector` under a viewport point (where a dragged thing is let go), or null. */
export function closestAtPoint(x: number, y: number, selector: string): HTMLElement | null {
  return document.elementFromPoint?.(x, y)?.closest<HTMLElement>(selector) ?? null;
}
