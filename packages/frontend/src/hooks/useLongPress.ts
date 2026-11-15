import { useMemo, useRef, type MouseEvent, type PointerEvent } from "react";
import { createLongPress } from "../lib/touchHold";

/** A long press (touch or mouse held still) or a right click / Android's long-press contextmenu
 *  runs `onLongPress`; the click that ends a long press is swallowed so the row does not also open.
 *  A short tap is a normal click. Spread the result on the element. Timing and slop: lib/touchHold. */
export function useLongPress(onLongPress: () => void) {
  const latest = useRef(onLongPress);
  latest.current = onLongPress;
  const press = useMemo(() => createLongPress(() => latest.current()), []);
  return {
    onPointerDown: (event: PointerEvent) => press.down(event),
    onPointerMove: (event: PointerEvent) => press.move(event),
    onPointerUp: press.cancel,
    onPointerCancel: press.cancel,
    onPointerLeave: press.cancel,
    onContextMenu: (event: MouseEvent) => { event.preventDefault(); press.contextMenu(); },
    onClickCapture: (event: MouseEvent) => { press.consumeClick(event); },
  };
}
