/** A short haptic tick where the device has one (the row lifted, a stroke snapped to a shape). */
export function vibrate(ms: number): void {
  try { navigator.vibrate?.(ms); } catch { /* no haptics */ }
}
