import { useEffect, useRef, useState } from "react";

/** A keyboard covers far more than browser chrome or a zoom wobble does. */
const OPEN_THRESHOLD_PX = 150;

/** Bottom edge, in layout px, of what the person can see: the window's bottom
 *  minus the on-screen keyboard. With visibleViewportTop, the one reader of
 *  `visualViewport` besides the hook below. */
export function visibleViewportBottom(): number {
  const vv = window.visualViewport;
  return vv ? vv.offsetTop + vv.height : window.innerHeight;
}

/** Marks a bar fixed on top of the on-screen keyboard (the editor's formatting row). */
export const KEYBOARD_BAR_ATTR = "data-keyboard-bar";

/** visibleViewportBottom, less any bar sitting on the keyboard (KEYBOARD_BAR_ATTR): how far down
 *  a floating surface may reach without going under that bar. */
export function visibleContentBottom(): number {
  let bottom = visibleViewportBottom();
  for (const bar of document.querySelectorAll(`[${KEYBOARD_BAR_ATTR}]`)) {
    const top = bar.getBoundingClientRect().top;
    if (top > 0 && top < bottom) bottom = top;
  }
  return bottom;
}

/** Top edge, in layout px, of what the person can see: 0 unless the browser has
 *  panned the page, as Chrome does to keep the caret above the keyboard. */
export function visibleViewportTop(): number {
  return window.visualViewport?.offsetTop ?? 0;
}

export type VirtualKeyboard = {
  /** The on-screen keyboard is up. Always false without visualViewport or
   *  with a hardware keyboard, so never require it to show something. */
  open: boolean;
  /** Layout px the keyboard hides at the bottom; a `position: fixed` bar at
   *  `bottom: inset` sits on top of it. 0 when the browser resizes the
   *  layout instead (the bar at bottom:0 is then already above it). */
  inset: number;
  /** Layout px the keyboard shrank the visible area by. Unlike `inset` it does not change when the browser only
   *  pans the visual viewport (offsetTop moves, size stays), as Android does while the person scrolls: key
   *  anything that must react to the keyboard, not to a pan, on this. */
  height: number;
};

/**
 * Follows the on-screen keyboard through `window.visualViewport` while
 * `active`. `open` compares the visible height with the tallest one seen at
 * this width (since the hook mounted, active or not), so it works whether the browser shrinks only the visual
 * viewport (Chrome, Safari) or the whole layout (resizes-content).
 *
 * `settleMs`: report only once the viewport has been still that long. While
 * the keyboard rises Chrome also pans the page to bring the focused field into
 * view; a bottom sheet that follows every event moves against the pan and
 * bounces (measured on the owner's phone, 2026-10-30). Settled, it moves once.
 */
export function useVirtualKeyboard(active: boolean, settleMs = 0): VirtualKeyboard {
  const [state, setState] = useState<VirtualKeyboard>({ open: false, inset: 0, height: 0 });
  const baseline = useRef({ width: 0, height: 0 });
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) { setState({ open: false, inset: 0, height: 0 }); return; }
    // The tallest height is learned whether or not anyone is using the keyboard yet: a bar that appears while the
    // keyboard is already up (title tapped first, then the text) would otherwise take the shrunken height as the
    // full one and never see the keyboard close (Android, resizes-content).
    const learn = () => {
      const b = baseline.current;
      // Rotation or a split screen changes the width: start over.
      if (b.width !== window.innerWidth) { b.width = window.innerWidth; b.height = 0; }
      b.height = Math.max(b.height, window.innerHeight, vv.height);
    };
    if (!active) {
      learn();
      setState({ open: false, inset: 0, height: 0 });
      vv.addEventListener("resize", learn);
      return () => vv.removeEventListener("resize", learn);
    }
    const update = () => {
      learn();
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const height = Math.max(0, window.innerHeight - vv.height);
      const open = baseline.current.height - vv.height > OPEN_THRESHOLD_PX;
      setState((prev) => (prev.open === open && prev.inset === inset && prev.height === height ? prev : { open, inset, height }));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = settleMs > 0 ? () => { clearTimeout(timer); timer = setTimeout(update, settleMs); } : update;
    update();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    return () => { clearTimeout(timer); vv.removeEventListener("resize", schedule); vv.removeEventListener("scroll", schedule); };
  }, [active, settleMs]);
  return state;
}
