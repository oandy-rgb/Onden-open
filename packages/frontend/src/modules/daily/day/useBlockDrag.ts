// The gestures on a planned block: pressed and dragged to move it, its lower edge
// pulled to change the length, Alt+↑↓ / Alt+Shift+↑↓ from the keyboard. Each one only
// previews (the block is drawn at the slot it would have); the write happens once, when
// the gesture is done, through `commit`. A refused write leaves the data as it was, so
// the block goes back by itself. The pointer part is lib/pointerDrag (mouse; finger and
// pen hold first, like the note rows) and the slot maths is timelineDrag.

import { useEffect, useRef, useState } from "react";
import type { DayWindow } from "@onden/markdown";
import { useEscapeKey } from "../../../hooks/useEscapeKey";
import { isImeComposing } from "../../../lib/keys";
import { trackPointerDrag, type PointerDragRun } from "../../../lib/pointerDragSession";
import { moveSpan, resizeSpan, slotSpan, type BlockSpan } from "./timelineDrag";
import { SNAP_MINUTES, type PlacedSlot } from "./timelineSlots";

export type BlockGesture = { id: string; mode: "move" | "resize"; slot: PlacedSlot };

/** Keys pressed one after another make one write, this long after the last. */
export const KEY_COMMIT_MS = 600;

type Options = {
  day: DayWindow;
  /** Minutes after the day's start at a viewport y (follows the scroll). */
  minutesAt: (clientY: number) => number;
  /** The element that scrolls while a block is dragged near its edge. */
  scroller: () => HTMLElement | null;
  /** Writes the slot; resolves when it was accepted or refused (the writer has already told the person). */
  commit: (id: string, slot: PlacedSlot) => Promise<unknown>;
  /** A keyboard step happened: say it in words. */
  onKeyStep: (slot: PlacedSlot, mode: BlockGesture["mode"]) => void;
};

export function useBlockDrag(options: Options) {
  const [gesture, setGesture] = useState<BlockGesture | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const latest = useRef({ options, gesture, selectedId: selected });
  latest.current = { options, gesture, selectedId: selected };
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef<PointerDragRun | null>(null);

  const finish = async (next: BlockGesture) => {
    setGesture(next); // stays drawn where it was dropped until the write answers
    try { await latest.current.options.commit(next.id, next.slot); } finally { setGesture((now) => (now === next ? null : now)); }
  };
  const flushKeys = () => {
    if (keyTimer.current) { clearTimeout(keyTimer.current); keyTimer.current = null; }
    const pending = latest.current.gesture;
    if (pending) void finish(pending);
  };
  // Esc drops what is being dragged, or keys pressed but not yet written.
  useEscapeKey(() => {
    if (!running.current && !keyTimer.current) return false;
    running.current?.cancel();
    running.current = null;
    if (keyTimer.current) { clearTimeout(keyTimer.current); keyTimer.current = null; }
    setGesture(null);
  }, gesture !== null);
  useEffect(() => () => { if (keyTimer.current) flushKeys(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- unmount only

  /** Pointer press on a block (`edge` false: moves it) or its grip (`edge` true: stretches it). */
  const press = (id: string, span: BlockSpan, edge: boolean) => (event: React.PointerEvent) => {
    // A finger only pulls the grip of a block it has selected (held); otherwise the touch is a scroll.
    if (edge && event.pointerType !== "mouse" && latest.current.selectedId !== id) return;
    if (keyTimer.current) flushKeys();
    const { day, minutesAt, scroller } = options;
    const mode = edge ? "resize" : "move";
    const from = minutesAt(event.clientY);
    let last: BlockGesture | null = null;
    const preview = (y: number) => {
      const slot = (edge ? resizeSpan : moveSpan)(day, span, minutesAt(y) - from);
      last = slot ? { id, mode, slot } : null;
      setGesture(last);
    };
    running.current = trackPointerDrag(event, {
      // A finger holds first (so scrolling stays scrolling); the grip is only there to be pulled.
      hold: !edge,
      scroller,
      onLift: () => setSelected(id),
      onDrag: (_x, y) => preview(y),
      onEnd: (_x, _y, dragged) => {
        running.current = null;
        if (!dragged) { if (!edge) setSelected(id); return; }
        if (last) void finish(last); else setGesture(null);
      },
      onCancel: () => { running.current = null; setGesture(null); },
    });
  };

  /** Alt+↑↓ moves by one grid step, Alt+Shift+↑↓ changes the length. */
  const keyDown = (id: string, span: BlockSpan) => (event: React.KeyboardEvent) => {
    if (isImeComposing(event) || !event.altKey || event.ctrlKey || event.metaKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const mode = event.shiftKey ? "resize" : "move";
    const base = latest.current.gesture?.id === id ? slotSpan(latest.current.gesture.slot) : span;
    const step = (event.key === "ArrowUp" ? -1 : 1) * SNAP_MINUTES;
    const slot = (mode === "resize" ? resizeSpan : moveSpan)(options.day, base, step);
    if (!slot) return;
    const next = { id, mode, slot } as const;
    latest.current.gesture = next;
    setGesture(next);
    options.onKeyStep(slot, mode);
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(flushKeys, KEY_COMMIT_MS);
  };

  const revealed = (id: string) => selected === id || hover === id || focus === id || gesture?.id === id;
  return {
    gesture,
    selectedId: selected,
    revealed,
    press,
    keyDown,
    deselect: () => setSelected(null),
    /** Hover and focus show the grip. */
    reveal: (id: string) => ({
      onPointerEnter: (event: React.PointerEvent) => { if (event.pointerType === "mouse") setHover(id); },
      onPointerLeave: () => setHover((now) => (now === id ? null : now)),
      onFocus: () => setFocus(id),
      onBlur: () => { setFocus((now) => (now === id ? null : now)); if (keyTimer.current) flushKeys(); },
    }),
  };
}
