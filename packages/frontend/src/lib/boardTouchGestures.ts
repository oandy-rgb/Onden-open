// Touch gestures on the board's empty pane, answered like a map app does:
//   one finger drag  = move the board (React Flow's own pan; we only keep it from also starting a box)
//   one finger tap   = deselect, as before (React Flow is handed the tap's pointer-down / pointer-up pair)
//   two fingers      = zoom + move; a box that is already open is cancelled the moment the second finger lands
//   press and hold   = after BOX_SELECT_HOLD_MS without moving, the same finger drags a selection box
// Cards, the pen layer, a mouse and a stylus never come through here: only a finger on the bare pane.
//
// React Flow starts a box on the pane's pointer-down (selectionOnDrag) and pans on touch-start at the same
// time, which is why the first finger of a pinch used to open a box. We hold that first pointer-down back
// (a capture listener on window runs before React's root listener) and, once the hold has lasted, replay
// it so React Flow opens the box from the very same finger. While the box is open the finger's touch moves
// are kept from the pan, so the board stays put under the box.

import { vibrate } from "./haptics";
import { BOX_SELECT_HOLD_MS, HOLD_SLOP } from "./touchHold";

export type BoardTouchGesturesOptions = {
  /** The element that holds the pane (React Flow's wrapper). */
  container: HTMLElement;
  /** True while a hold may open a box (the select tool); false lets every event through. */
  isEnabled: () => boolean;
  /** The hold has lasted: the board shows its feedback and a box can now be dragged. */
  onArmedChange: (armed: boolean) => void;
  /** A second finger landed while a box was open: put back what the box changed. */
  onSelectionCancelled: () => void;
};

type Pending = { pointerId: number; target: Element; x: number; y: number; timer: ReturnType<typeof setTimeout> };

export function attachBoardTouchGestures(options: BoardTouchGesturesOptions): () => void {
  const { container, isEnabled, onArmedChange, onSelectionCancelled } = options;
  const fingers = new Set<number>();
  let pending: Pending | null = null;
  let armed: { pointerId: number; target: Element; x: number; y: number } | null = null;
  let replaying = false;

  const isFingerOnPane = (e: PointerEvent) =>
    e.pointerType === "touch" && e.button === 0 && e.target instanceof Element && container.contains(e.target) && e.target.classList.contains("react-flow__pane");

  function dispatchPointer(type: "pointerdown" | "pointerup", target: Element, source: { pointerId: number; x: number; y: number }) {
    const init: PointerEventInit = { bubbles: true, cancelable: true, composed: true, pointerId: source.pointerId, pointerType: "touch", isPrimary: true, button: 0, buttons: type === "pointerdown" ? 1 : 0, clientX: source.x, clientY: source.y };
    const event = typeof PointerEvent === "function" ? new PointerEvent(type, init) : Object.assign(new MouseEvent(type, init), { pointerId: init.pointerId, pointerType: "touch", isPrimary: true });
    replaying = true;
    try { target.dispatchEvent(event); } finally { replaying = false; }
  }

  function clearPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  function endArmed() {
    if (!armed) return;
    armed = null;
    onArmedChange(false);
  }

  function onDown(e: PointerEvent) {
    if (replaying || e.pointerType !== "touch") return;
    fingers.add(e.pointerId);
    if (fingers.size >= 2) {
      clearPending();
      if (armed) {
        const open = armed;
        endArmed();
        // Close React Flow's box (it keeps the cards inside it selected), then put the old selection back.
        dispatchPointer("pointerup", open.target, open);
        onSelectionCancelled();
      }
      return;
    }
    if (!isEnabled() || !isFingerOnPane(e)) return;
    // The pane never sees this pointer-down; a tap still reaches it as a click, a drag as React Flow's pan.
    e.stopPropagation();
    const target = e.target as Element;
    const { pointerId, clientX: x, clientY: y } = e;
    pending = {
      pointerId, target, x, y,
      timer: setTimeout(() => {
        pending = null;
        if (fingers.size !== 1 || !fingers.has(pointerId)) return;
        armed = { pointerId, target, x, y };
        onArmedChange(true);
        vibrate(12);
        dispatchPointer("pointerdown", target, { pointerId, x, y });
      }, BOX_SELECT_HOLD_MS),
    };
  }

  function onMove(e: PointerEvent) {
    if (pending && e.pointerId === pending.pointerId && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > HOLD_SLOP) clearPending();
  }

  function onUp(e: PointerEvent) {
    if (e.pointerType !== "touch" || replaying) return;
    fingers.delete(e.pointerId);
    if (pending?.pointerId === e.pointerId) {
      // A tap on the bare pane (no hold, no drag). React Flow only turns a pane tap into "deselect" through
      // its own pointer-down / pointer-up pair when box selection is on, so give it that pair.
      const tap = pending;
      clearPending();
      dispatchPointer("pointerdown", tap.target, { pointerId: tap.pointerId, x: tap.x, y: tap.y });
      dispatchPointer("pointerup", tap.target, { pointerId: tap.pointerId, x: e.clientX, y: e.clientY });
    }
    if (armed?.pointerId === e.pointerId) endArmed();
  }

  // The finger that holds a box must not also pan: d3-zoom already saw its touch-start.
  function onTouchMove(e: TouchEvent) {
    if (armed && e.touches.length === 1 && container.contains(e.target as Node)) e.stopPropagation();
  }

  const capture = { capture: true } as const;
  window.addEventListener("pointerdown", onDown, capture);
  window.addEventListener("pointermove", onMove, capture);
  window.addEventListener("pointerup", onUp, capture);
  window.addEventListener("pointercancel", onUp, capture);
  window.addEventListener("touchmove", onTouchMove, capture);
  return () => {
    window.removeEventListener("pointerdown", onDown, capture);
    window.removeEventListener("pointermove", onMove, capture);
    window.removeEventListener("pointerup", onUp, capture);
    window.removeEventListener("pointercancel", onUp, capture);
    window.removeEventListener("touchmove", onTouchMove, capture);
    clearPending();
    armed = null;
  };
}
