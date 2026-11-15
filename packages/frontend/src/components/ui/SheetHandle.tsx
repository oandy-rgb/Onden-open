import { useRef, type PointerEvent } from "react";
import { capturePointer } from "../../lib/pointerDrag";

// The bottom sheet's grab handle, for every sheet (ui/Sheet, <Menu sheet>,
// <Popover sheet>): the card follows the finger both ways (owner, 2026-11-01).
// Down: let go far enough (or with a flick) and the sheet slides away and
// closes, else it springs back. Up: a card whose content is cut off grows
// with the finger, and let go far enough it stays at its full height (the
// content's, capped by the room the CSS gives it); a card that already shows
// everything gives a little, against resistance, and springs back.
// The touch target is the whole top strip (ui.css). The card is the handle's
// parent; the drag writes its style directly so a move costs no render.

const SETTLE = "transform 0.16s ease-out, height 0.16s ease-out";
/** How far a card that cannot grow moves up: a fifth of the finger, at most this. */
const GIVE_MAX = 24;

export function SheetHandle({ onClose }: { onClose: () => void }) {
  const drag = useRef<{ startY: number; startT: number; card: HTMLElement; startH: number; room: number; dy: number; grown: number } | null>(null);

  const down = (event: PointerEvent<HTMLDivElement>) => {
    const card = event.currentTarget.parentElement;
    if (!card || event.button !== 0) return;
    capturePointer(event.currentTarget, event.pointerId);
    card.style.transition = "none";
    const startH = card.offsetHeight;
    const cap = Number.parseFloat(getComputedStyle(card).maxHeight);
    // The most it can grow: up to its content's full height, never past the room it is given.
    const room = Math.max(0, Math.min(card.scrollHeight, Number.isFinite(cap) ? cap : Infinity) - startH);
    drag.current = { startY: event.clientY, startT: event.timeStamp, card, startH, room, dy: 0, grown: 0 };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const raw = event.clientY - d.startY;
    d.dy = Math.max(0, raw);
    d.grown = Math.min(d.room, Math.max(0, -raw));
    const give = raw < 0 ? Math.max(-GIVE_MAX, (raw + d.grown) / 5) : 0;
    d.card.style.height = d.grown ? `${d.startH + d.grown}px` : "";
    d.card.style.transform = d.dy ? `translateY(${d.dy}px)` : give ? `translateY(${give}px)` : "";
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const card = d.card;
    card.style.transition = SETTLE;
    const speed = (Math.max(d.dy, d.grown)) / Math.max(1, event.timeStamp - d.startT);
    const done = event.type === "pointerup";
    if (done && ((d.dy > 24 && speed > 0.5) || d.dy > Math.min(120, card.offsetHeight / 3))) {
      card.style.transform = `translateY(${card.offsetHeight}px)`;
      setTimeout(onClose, 160);
      return;
    }
    card.style.transform = "";
    // Pulled up far enough (or flicked): stay at the full height; else back to where it was.
    const stay = done && d.room > 0 && ((d.grown > 24 && speed > 0.5) || d.grown > Math.min(80, d.room / 3));
    card.style.height = stay ? `${d.startH + d.room}px` : d.grown ? `${d.startH}px` : "";
    card.addEventListener("transitionend", () => {
      card.style.transition = "";
      if (!stay) card.style.height = "";
    }, { once: true });
  };

  return <div className="ui-sheet-handle" aria-hidden="true" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />;
}
