import { useEffect } from "react";

/** Whether a press is the one that acts: a finger or pen, or the mouse's primary button. */
export function isPrimaryPress(e: { pointerType: string; button: number }): boolean {
  return e.pointerType !== "mouse" || e.button === 0;
}

/** A press that moved no further than this (CSS px) is a tap. */
const TAP_SLOP = 8;
const TAP_MAX_MS = 600;

/** A tap on `el`: one pointer (finger, pen or the primary mouse button) that
 *  goes down and up in place. It only listens — the element's other handlers
 *  (the ink engine's panning and drawing) are not touched, and a second finger
 *  (a pinch), a drag (a pan or a scroll the browser took over) or a cancel
 *  is not a tap. */
export function useTap(el: HTMLElement | null, enabled: boolean, onTap: (clientX: number, clientY: number) => void): void {
  useEffect(() => {
    if (!el || !enabled) return;
    const down = new Set<number>();
    let start: { id: number; x: number; y: number; at: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (!isPrimaryPress(e)) return;
      down.add(e.pointerId);
      start = down.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp } : null;
    };
    const onMove = (e: PointerEvent) => {
      if (start && start.id === e.pointerId && Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) start = null;
    };
    const onUp = (e: PointerEvent) => {
      down.delete(e.pointerId);
      const press = start;
      if (!press || press.id !== e.pointerId) return;
      start = null;
      if (e.timeStamp - press.at <= TAP_MAX_MS && Math.hypot(e.clientX - press.x, e.clientY - press.y) <= TAP_SLOP) onTap(e.clientX, e.clientY);
    };
    // A touch tap is followed by compatibility mouse events; their mousedown
    // would move focus off the box this tap just opened (and close it).
    const onMouseDown = (e: MouseEvent) => e.preventDefault();
    const onCancel = (e: PointerEvent) => { down.delete(e.pointerId); if (start?.id === e.pointerId) start = null; };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    el.addEventListener("mousedown", onMouseDown);
    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
    };
  }, [el, enabled, onTap]);
}
