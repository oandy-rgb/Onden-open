// The phone's way to make a slot: press and hold on the timeline, then drag up
// or down. A press that moves before the hold is up is a scroll; a press that
// is lifted before it is a tap (the click handler's). Pure state machine; the
// hook below it owns the timer, the pointer events and the vibration.

import { HOLD_SLOP } from "../../../lib/touchHold";

/** How long a still finger stays down before a stretch is drawn (ms). Longer than a row's lift (touchHold
 *  HOLD_MS, 300): the timeline is mostly scrolled, and a finger that rests for a third of a second before a
 *  scroll began a draw — a 04:00–08:15 slot nobody meant. The sheet that follows lets the length be changed
 *  at once, so a deliberate press is not made to wait much longer. */
export const DRAW_HOLD_MS = 450;

export type PressState =
  | { phase: "idle" }
  | { phase: "pressing"; startY: number }
  | { phase: "drawing"; startY: number; y: number }
  /** Scrolling or cancelled: nothing more happens until the finger is up. */
  | { phase: "ignored" };

export type PressEvent =
  | { type: "down"; y: number }
  | { type: "move"; y: number; x?: number; startX?: number }
  | { type: "hold" }
  | { type: "up" }
  | { type: "cancel" };

export type PressResult = { state: PressState; /** What the caller does: nothing, or a finished stretch. */ done?: { startY: number; endY: number } };

export function pressStep(state: PressState, event: PressEvent): PressResult {
  switch (event.type) {
    case "down":
      return { state: { phase: "pressing", startY: event.y } };
    case "move":
      if (state.phase === "pressing") {
        const far = Math.abs(event.y - state.startY) > HOLD_SLOP || (event.x !== undefined && event.startX !== undefined && Math.abs(event.x - event.startX) > HOLD_SLOP);
        return { state: far ? { phase: "ignored" } : state };
      }
      if (state.phase === "drawing") return { state: { ...state, y: event.y } };
      return { state };
    case "hold":
      return { state: state.phase === "pressing" ? { phase: "drawing", startY: state.startY, y: state.startY } : state };
    case "up":
      return state.phase === "drawing"
        ? { state: { phase: "idle" }, done: { startY: state.startY, endY: state.y } }
        : { state: { phase: "idle" } };
    case "cancel":
      return { state: { phase: "idle" } };
  }
}
