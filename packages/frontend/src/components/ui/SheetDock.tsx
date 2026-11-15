import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { capturePointer } from "../../lib/pointerDrag";
import { classNames } from "../../lib/utils";
import { observeSize } from "../../lib/observeSize";
import { useVirtualKeyboard, visibleContentBottom } from "../../hooks/useVirtualKeyboard";
import "./ui.css";

// DockedSheet (the docked half of the sheet owner, beside ui/Sheet): a bottom panel that is NOT modal.
// Its own file and entry so the code loads with the panel that uses it, not with the first screen, which already carries Sheet. The page behind it stays alive (scrolls, takes
// typing); only the panel's own heights change:
//   bar  — one row docked above the bottom navigation (`dock.bar` is that row; the body is kept, hidden)
//   half — about half the screen, the note above stays visible
//   full — all the room, for a long answer
// It sits on whatever is at the bottom: the bottom navigation, or the keyboard together with the editor's
// formatting row. While the person types in the panel itself it takes all the room above the keyboard (the
// page behind is not visible then). Back and Esc are the caller's (hooks/useEscapeKey useDismiss):
// the panel only draws and reports height changes. The page keeps its last lines reachable: the panel's
// height is published as --ui-dock-clearance on the root while it shows.


// The docked sheet's handle: the same strip, but a drag changes the sheet's height
// instead of closing it: down is one height lower, up one higher, a tap on the bar opens it. The card follows
// the finger a little and settles back; the new height is the caller's state.

export type SheetDockHeight = "bar" | "half" | "full";
const DOCK_ORDER: readonly SheetDockHeight[] = ["bar", "half", "full"];
/** How far (px) the finger must travel to change the height, and the least that counts as a tap. */
const DOCK_STEP_PX = 40;
const DOCK_TAP_PX = 6;
const DOCK_FOLLOW_PX = 48;
const SETTLE = "transform 0.16s ease-out, height 0.16s ease-out";

function SheetDockHandle({ height, onHeightChange }: { height: SheetDockHeight; onHeightChange: (height: SheetDockHeight) => void }) {
  const drag = useRef<{ startY: number; card: HTMLElement; dy: number } | null>(null);
  const down = (event: PointerEvent<HTMLDivElement>) => {
    const card = event.currentTarget.parentElement;
    if (!card || event.button !== 0) return;
    capturePointer(event.currentTarget, event.pointerId);
    card.style.transition = "none";
    drag.current = { startY: event.clientY, card, dy: 0 };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.dy = event.clientY - d.startY;
    d.card.style.transform = `translateY(${Math.max(-DOCK_FOLLOW_PX, Math.min(DOCK_FOLLOW_PX, d.dy / 2))}px)`;
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    d.card.style.transition = SETTLE;
    d.card.style.transform = "";
    if (event.type !== "pointerup") return;
    const at = DOCK_ORDER.indexOf(height);
    const go = (next: SheetDockHeight) => { if (next !== height) onHeightChange(next); };
    if (d.dy > DOCK_STEP_PX) go(DOCK_ORDER[Math.max(0, at - 1)]);
    else if (d.dy < -DOCK_STEP_PX) go(DOCK_ORDER[Math.min(DOCK_ORDER.length - 1, at + 1)]);
    else if (Math.abs(d.dy) < DOCK_TAP_PX && height === "bar") go("half");
  };
  return <div className="ui-sheet-handle" aria-hidden="true" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />;
}

export type SheetDock = {
  height: SheetDockHeight;
  onHeightChange: (height: SheetDockHeight) => void;
  /** The row shown at the bar height. */
  bar: ReactNode;
};

export function DockedSheet({ label, className, cardClassName, dock, children }: {
  label: string; className?: string; cardClassName?: string; dock: SheetDock; children: ReactNode;
}) {
  const keyboard = useVirtualKeyboard(true, 120);
  const card = useRef<HTMLElement>(null);
  const [lift, setLift] = useState(0);
  const [inside, setInside] = useState(false);

  // How far the panel sits above the window's bottom edge: the keyboard, and the editor's formatting row on it.
  useEffect(() => {
    const measure = () => setLift(Math.max(0, Math.round(window.innerHeight - visibleContentBottom())));
    // The editor's row appears a frame after the focus moves.
    const later = () => { requestAnimationFrame(measure); };
    measure();
    document.addEventListener("focusin", later);
    document.addEventListener("focusout", later);
    return () => { document.removeEventListener("focusin", later); document.removeEventListener("focusout", later); };
  }, [keyboard.open, keyboard.inset]);

  // Keep the page's last lines reachable above the panel.
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty("--ui-dock-clearance", `${Math.round(el.getBoundingClientRect().height)}px`);
    publish();
    const stop = observeSize(el, publish);
    return () => { stop(); root.style.removeProperty("--ui-dock-clearance"); };
  }, []);

  const typing = inside && keyboard.open;
  return (
    <section ref={card} aria-label={label} data-height={dock.height} data-typing={typing || undefined} data-keyboard={keyboard.open || undefined}
      className={classNames("ui-sheet-dock", className, cardClassName)} style={{ "--ui-dock-lift": `${lift}px` } as CSSProperties}
      onFocus={() => setInside(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInside(false); }}>
      <SheetDockHandle height={dock.height} onHeightChange={dock.onHeightChange} />
      {dock.height === "bar" && <div className="ui-sheet-dock__bar">{dock.bar}</div>}
      <div className="ui-sheet-dock__body" hidden={dock.height === "bar"}>{children}</div>
    </section>
  );
}
