// Pointer wiring for longPressDraw's state machine: a held touch (or pen) on
// the element turns into a drawn stretch. Mouse is left alone (it clicks).
// Before the hold is up the page scrolls as usual; once drawing, the touch's
// default (scrolling) is stopped by a non-passive touchmove listener — React's
// own touch handlers are passive, so it is added by hand. Pointer events are
// what Android Chrome, Brave and Samsung Internet all send.

import { useCallback, useEffect, useRef } from "react";
import { swallowNextClick } from "../../../lib/touchHold";
import { vibrate } from "../../../lib/haptics";
import { DRAW_HOLD_MS, pressStep, type PressState } from "./longPressDraw";

/** The stretch, as viewport y of where the finger went down and where it is. */
export type DrawnRange = { startY: number; endY: number };

type Options = {
  enabled: boolean;
  /** Presses starting inside an element matching this are not ours (a block is a button). */
  ignore: string;
  /** Called while drawing with the stretch so far, and with null when it ends or is cancelled. */
  onChange: (range: DrawnRange | null) => void;
  /** The finger came up after drawing. */
  onDone: (range: DrawnRange) => void;
};

export function useLongPressDraw<E extends HTMLElement>({ enabled, ignore, onChange, onDone }: Options) {
  const element = useRef<E>(null);
  const state = useRef<PressState>({ phase: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startX = useRef(0);
  const latest = useRef({ onChange, onDone });
  latest.current = { onChange, onDone };

  const stopTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const reset = useCallback(() => {
    stopTimer();
    if (state.current.phase === "drawing") latest.current.onChange(null);
    state.current = { phase: "idle" };
  }, []);

  useEffect(() => {
    const el = element.current;
    if (!el) return;
    // Once drawing, the page must not scroll under the finger; a context menu would end the press.
    const block = (event: Event) => { if (state.current.phase === "drawing" && event.cancelable) event.preventDefault(); };
    const menu = (event: Event) => { if (state.current.phase !== "idle") event.preventDefault(); };
    el.addEventListener("touchmove", block, { passive: false });
    el.addEventListener("contextmenu", menu);
    return () => { el.removeEventListener("touchmove", block); el.removeEventListener("contextmenu", menu); };
  }, []);
  useEffect(() => { if (!enabled) reset(); }, [enabled, reset]);
  useEffect(() => reset, [reset]);

  const onPointerDown = (event: React.PointerEvent<E>) => {
    if (!enabled || event.pointerType === "mouse" || !event.isPrimary) return;
    if ((event.target as Element).closest(ignore)) return;
    stopTimer();
    startX.current = event.clientX;
    state.current = pressStep(state.current, { type: "down", y: event.clientY }).state;
    timer.current = setTimeout(() => {
      timer.current = null;
      state.current = pressStep(state.current, { type: "hold" }).state;
      if (state.current.phase === "drawing") {
        vibrate(10);
        latest.current.onChange({ startY: state.current.startY, endY: state.current.y });
      }
    }, DRAW_HOLD_MS);
  };
  const onPointerMove = (event: React.PointerEvent<E>) => {
    if (state.current.phase === "idle") return;
    state.current = pressStep(state.current, { type: "move", y: event.clientY, x: event.clientX, startX: startX.current }).state;
    if (state.current.phase === "ignored") stopTimer();
    if (state.current.phase === "drawing") latest.current.onChange({ startY: state.current.startY, endY: state.current.y });
  };
  const onPointerUp = () => {
    const { state: next, done } = pressStep(state.current, { type: "up" });
    stopTimer();
    state.current = next;
    if (done) {
      swallowNextClick(); // the click that follows a lifted finger is not a tap
      latest.current.onChange(null);
      latest.current.onDone(done);
    }
  };
  const onPointerCancel = () => reset();

  return {
    ref: element,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
