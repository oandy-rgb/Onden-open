/** How far (CSS px) a pressed pointer must move before it counts as a drag rather than a click.
 *  A resting touch hold has its own, looser tolerance: HOLD_SLOP in lib/touchHold. */
export const DRAG_SLOP_PX = 4;

/** Keep receiving this pointer's events after it leaves `el` (a drag that overshoots the handle).
 *  The one place that calls `setPointerCapture`: jsdom has no such method and the browser throws if
 *  the pointer is already gone, and neither must stop the press. */
export function capturePointer(el: Element, pointerId: number): void {
  try { el.setPointerCapture?.(pointerId); } catch { /* jsdom, or the pointer already ended */ }
}
