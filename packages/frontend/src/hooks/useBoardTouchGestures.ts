import { useEffect, useRef, useState } from "react";
import { attachBoardTouchGestures } from "../lib/boardTouchGestures";

/** Finger gestures on the board's bare pane (see lib/boardTouchGestures). `armed` is true while a held finger
 *  is dragging a selection box, so the board can show it. `enabled` is read live: a tool change needs no re-attach. */
export function useBoardTouchGestures({ container, enabled, onSelectionCancelled }: {
  container: HTMLElement | null;
  enabled: boolean;
  onSelectionCancelled: () => void;
}): { armed: boolean } {
  const [armed, setArmed] = useState(false);
  const live = useRef({ enabled, onSelectionCancelled });
  live.current = { enabled, onSelectionCancelled };
  useEffect(() => {
    if (!container) return;
    return attachBoardTouchGestures({
      container,
      isEnabled: () => live.current.enabled,
      onArmedChange: setArmed,
      onSelectionCancelled: () => live.current.onSelectionCancelled(),
    });
  }, [container]);
  return { armed };
}
