import { useEffect, useState } from "react";
import { pickColorAt } from "../lib/ink";
import { isEscapeKey } from "../lib/keys";

/** Elements the eyedropper leaves to their own press: the toolbar, its panels
 *  and the hint (marked `data-ink-eyedropper-ui`). */
const OWN_UI = ".ink-note-toolbar, .ui-popover, [data-ink-eyedropper-ui]";

/** The rest of a press the eyedropper took (its moves and its lifting) is kept
 *  from the page, even after the picking is over: the page's ink engine must
 *  not see a pen that is down and moving with no pointerdown before it — that
 *  reads as the side button being pressed and flips the tool. */
function keepFromPage(pointerId: number): void {
  const types = ["pointermove", "pointerup", "pointercancel"] as const;
  const stop = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    e.stopPropagation();
    if (e.type !== "pointermove") release();
  };
  const timer = setTimeout(() => release(), 10_000); // a press that never reports its end
  function release() {
    clearTimeout(timer);
    for (const type of types) document.removeEventListener(type, stop, true);
  }
  for (const type of types) document.addEventListener(type, stop, true);
}

/** The eyedropper while `active`: the next press on the page (a pen, a finger
 *  or a mouse) is not a stroke or a scroll but "take this colour" — the stored
 *  colour of the stroke, shape or text there (lib/ink/colorPick), never a pixel.
 *  A press on nothing keeps it waiting (`missed` says so); Esc ends it. The
 *  presses are caught before the page's own handlers see them, so nothing is
 *  drawn or moved by the press that picks. */
export function useEyedropper(active: boolean, onPick: (color: string) => void, onEnd: () => void): { missed: boolean } {
  const [missed, setMissed] = useState(false);
  useEffect(() => {
    if (!active) { setMissed(false); return; }
    const onPage = (e: Event) => !(e.target instanceof Element && e.target.closest(OWN_UI));
    const swallow = (e: Event) => { if (onPage(e)) { e.preventDefault(); e.stopPropagation(); } };
    const press = (e: PointerEvent) => {
      if (!onPage(e) || e.button > 0) return;
      e.preventDefault();
      e.stopPropagation();
      keepFromPage(e.pointerId);
      const color = pickColorAt(e.clientX, e.clientY);
      if (color) { onPick(color); onEnd(); } else setMissed(true);
    };
    const key = (e: KeyboardEvent) => {
      if (!isEscapeKey(e)) return;
      e.preventDefault();
      e.stopPropagation(); // the panel under it stays open: this Esc only ends the picking
      onEnd();
    };
    document.body.dataset.inkEyedropper = "on";
    // The other events a press makes: a board pans on mouse / touch events, not pointer ones.
    const others = ["mousedown", "touchstart", "click", "dblclick", "contextmenu"] as const;
    document.addEventListener("pointerdown", press, true);
    for (const type of others) document.addEventListener(type, swallow, { capture: true, passive: false });
    window.addEventListener("keydown", key, true);
    return () => {
      delete document.body.dataset.inkEyedropper;
      document.removeEventListener("pointerdown", press, true);
      for (const type of others) document.removeEventListener(type, swallow, true);
      window.removeEventListener("keydown", key, true);
    };
    // onPick / onEnd are the toolbar's current callbacks; the listeners are made once per activation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  return { missed };
}
