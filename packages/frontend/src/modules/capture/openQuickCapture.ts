// Opening quick capture goes through a window event, so the phone's ＋, ⌘⇧N and the
// palette only call openQuickCapture(). Kept apart from the box so callers do not
// pull its code in (QuickCaptureHost loads the box on the first request).

import { emitWindowEvent } from "../../lib/globalEvents";

export const OPEN_QUICK_CAPTURE_EVENT = "onden-open-quick-capture";

/** Open the capture box (focused, ready to type). */
export function openQuickCapture(): void {
  emitWindowEvent(OPEN_QUICK_CAPTURE_EVENT);
}
