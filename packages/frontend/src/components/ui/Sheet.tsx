import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { classNames } from "../../lib/utils";
import { useVirtualKeyboard } from "../../hooks/useVirtualKeyboard";
import { Modal } from "./Modal";
import { SheetHandle } from "./SheetHandle";

// The phone's bottom sheet, on ui/Modal (top layer, backdrop, Esc, busy, focus).
// On a phone (≤600px) the card docks to the bottom edge with the shared look
// (ui.css: .ui-sheet*): 16px top corners, a handle, the safe area, dvh heights.
// It rides on the on-screen keyboard: the bottom sits on the keyboard's top
// edge and the height is what is left above it (--kb-inset, useVirtualKeyboard).
// Wider than that the card is the caller's own: a centred card (the default),
// or, with `desktop="bottom"`, docked to the bottom edge as it always was.
//
// `steady`: the height is fixed for as long as it is set — a shorter content
// does not shrink the sheet; only the keyboard opening or closing changes it.
// For a sheet with a search over a list: the top edge must not jump while the
// person types. The height is the content's own when the sheet turns steady
// (two places = a short sheet), or all the room when the content is taller.
// The caller makes the list fill what is left of the card
// (`flex: 1; min-height: 0; overflow-y: auto`).
//
// `cardClassName` is the card's own class (its desktop size, border, padding);
// `className` is the full-screen layer's (test hooks, desktop placement).

/** How long the viewport must be still before the sheet moves with the keyboard. */
const KEYBOARD_SETTLE_MS = 120;

type Props = {
  /** Accessible name. */
  label: string;
  className?: string;
  cardClassName?: string;
  busy?: boolean;
  steady?: boolean;
  /** Where the card sits above the phone breakpoint. */
  desktop?: "center" | "bottom";
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null> | "dialog";
  children: ReactNode;
};

export function Sheet({ label, className, cardClassName, busy, steady = false, desktop = "center", onClose, initialFocus, children }: Props) {
  // Settled: one move once the keyboard is up, not one per event against Chrome's pan.
  const keyboard = useVirtualKeyboard(true, KEYBOARD_SETTLE_MS);
  // Only a keyboard that is up moves the sheet: a pinch-zoom also shrinks the visual viewport.
  const inset = keyboard.open ? keyboard.inset : 0;
  const card = useRef<HTMLDivElement>(null);
  // The steady height: null while it is measured (the card at its own height),
  // 0 for all the room, else the content's height in px.
  const [fit, setFit] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!steady) { setFit(null); return; }
    const el = card.current;
    if (!el) return;
    const height = el.getBoundingClientRect().height;
    const room = parseFloat(getComputedStyle(el).maxHeight);
    // No layout (jsdom), no cap (wider than a phone) or content as tall as the room: all of it.
    setFit(height > 0 && Number.isFinite(room) && height < room - 1 ? height : 0);
  }, [steady]);
  return (
    <Modal label={label} className={classNames("ui-sheet-layer", desktop === "bottom" && "ui-sheet-layer--bottom", className)}
      busy={busy} onClose={onClose} initialFocus={initialFocus}>
      <div ref={card} className={classNames("ui-sheet", steady && "ui-sheet--steady", cardClassName)} style={{ "--kb-inset": `${inset}px`, "--ui-sheet-steady-height": fit ? `${fit}px` : undefined } as CSSProperties}
        data-keyboard={keyboard.open || undefined} data-fitting={(steady && fit === null) || undefined}>
        <SheetHandle onClose={busy ? () => {} : onClose} />
        {children}
      </div>
    </Modal>
  );
}
