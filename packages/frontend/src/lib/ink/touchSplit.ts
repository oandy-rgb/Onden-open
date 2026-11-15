// Touch split — who gets a touch before the browser decides to scroll.
//
// Hosts that let the browser scroll natively (InkEngine `nativeTouch`) still
// need three things from the browser's touch stream, and the only lever is
// cancelling touch events (pointer events can't stop a scroll):
//
//   | contact                       | here                                      |
//   |-------------------------------|-------------------------------------------|
//   | pen (while `penOwned`)        | cancelled: no scroll, the engine draws    |
//   | finger while a pen writes,    | cancelled: a resting palm never scrolls   |
//   |   or PALM_GRACE_MS after it   |                                           |
//   | one finger                    | left alone: the browser scrolls           |
//   | two fingers                   | cancelled: `pinch` (live preview + commit) |
//
// The pen is recognised by Touch.touchType "stylus" (Safari / Apple Pencil) or
// by the pen pointerdown that browsers dispatch just before the contact's
// touchstart (Chrome and Samsung Internet have no touchType). A touch that
// starts while the browser is already scrolling (a fling) can't be cancelled,
// so the pen's touchmoves are cancelled too — that is what stops the scroll
// from taking a stroke that begins mid-fling (measured on a Galaxy Tab S9).
//
// A touchend can miss the container: pdf.js redraws a page when a pinch
// commits, which detaches the touch target, and the event then fires on a node
// that no longer bubbles here. So every event is first checked against
// `TouchEvent.touches` (what the browser still holds down) and anything we
// remember that is not in it is forgotten; without that, a stale finger plus
// the next real one would read as two fingers and turn scrolling into zoom.
//
// DOM listeners only; the rules a pointer follows once it reaches the engine
// stay in inputPolicy.ts.

import { PALM_GRACE_MS } from "./inputPolicy";

/** A pen pointerdown older than this has no touchstart coming. */
const PEN_DOWN_MATCH_MS = 150;

export interface PinchHost {
  /** Two fingers landed; (x, y) is their midpoint in client px. */
  start(x: number, y: number): void;
  /** `scale` since start (1 = unchanged); (x, y) = the midpoint now. */
  move(scale: number, x: number, y: number): void;
  /** Fewer than two fingers again: apply what the preview showed. */
  end(): void;
}

export interface TouchSplitOptions {
  /** An ink tool is on: the pen draws instead of scrolling. */
  penOwned: () => boolean;
  pinch?: PinchHost;
}

/** Install on the scroll container (every page and the gaps between them).
 *  Returns dispose. */
export function installTouchSplit(el: HTMLElement, opts: TouchSplitOptions): () => void {
  const penTouches = new Set<number>();
  const fingers = new Map<number, { x: number; y: number }>();
  let pendingPenDowns: number[] = [];
  let lastPenT = -Infinity;
  let pinch: { a: number; b: number; dist: number } | null = null;

  // Pen contacts only: a hovering pen (Samsung Internet reports it) must not
  // turn the next finger scroll into a palm.
  const onPointer = (e: PointerEvent) => {
    if (e.pointerType !== "pen" || (e.type === "pointermove" && e.buttons === 0)) return;
    lastPenT = performance.now();
    if (e.type === "pointerdown") pendingPenDowns.push(lastPenT);
  };

  const isPen = (t: Touch, now: number): boolean => {
    pendingPenDowns = pendingPenDowns.filter((at) => now - at < PEN_DOWN_MATCH_MS);
    const matched = pendingPenDowns.length > 0;
    if (matched) pendingPenDowns.shift();
    return (t as Touch & { touchType?: string }).touchType === "stylus" || matched;
  };

  const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    [(a.x + b.x) / 2, (a.y + b.y) / 2] as const;

  // Forget every contact the browser no longer holds down, and end a pinch
  // that lost one of its two fingers.
  const reconcile = (e: TouchEvent) => {
    if (e.touches) {
      const down = new Set(Array.from(e.touches, (t) => t.identifier));
      for (const id of [...fingers.keys()]) if (!down.has(id)) fingers.delete(id);
      for (const id of [...penTouches]) if (!down.has(id)) penTouches.delete(id);
    }
    if (pinch && !(fingers.has(pinch.a) && fingers.has(pinch.b))) endPinch();
  };

  const startPinch = () => {
    const [a, b] = [...fingers.keys()];
    const pa = fingers.get(a)!;
    const pb = fingers.get(b)!;
    pinch = { a, b, dist: Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y)) };
    opts.pinch?.start(...midpoint(pa, pb));
  };

  const endPinch = () => {
    if (!pinch) return;
    pinch = null;
    opts.pinch?.end();
  };

  const onTouchStart = (e: TouchEvent) => {
    reconcile(e);
    const now = performance.now();
    let cancel = false;
    for (const t of Array.from(e.changedTouches)) {
      if (isPen(t, now)) {
        if (opts.penOwned()) { penTouches.add(t.identifier); cancel = true; }
        continue;
      }
      if (opts.penOwned() && (penTouches.size > 0 || now - lastPenT < PALM_GRACE_MS)) {
        cancel = true; // a palm
        continue;
      }
      fingers.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
    // Only a cancellable start can claim the fingers: once the browser
    // scrolls, it keeps them (two-finger scroll), and so does the preview.
    if (fingers.size >= 2 && !pinch && opts.pinch && e.cancelable) {
      startPinch();
      cancel = true;
    }
    if (cancel && e.cancelable) e.preventDefault();
  };

  const onTouchMove = (e: TouchEvent) => {
    reconcile(e);
    let cancel = pinch !== null;
    for (const t of Array.from(e.changedTouches)) {
      if (penTouches.has(t.identifier)) cancel = true;
      const f = fingers.get(t.identifier);
      if (f) { f.x = t.clientX; f.y = t.clientY; }
    }
    if (pinch) {
      const pa = fingers.get(pinch.a);
      const pb = fingers.get(pinch.b);
      if (pa && pb) {
        const dist = Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y));
        opts.pinch?.move(dist / pinch.dist, ...midpoint(pa, pb));
      }
    }
    if (cancel && e.cancelable) e.preventDefault();
  };

  const onTouchEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      penTouches.delete(t.identifier);
      fingers.delete(t.identifier);
    }
    reconcile(e);
  };

  const capture = { capture: true } as const;
  const active = { capture: true, passive: false } as const;
  el.addEventListener("pointerdown", onPointer, capture);
  el.addEventListener("pointermove", onPointer, capture);
  el.addEventListener("pointerup", onPointer, capture);
  el.addEventListener("touchstart", onTouchStart, active);
  el.addEventListener("touchmove", onTouchMove, active);
  el.addEventListener("touchend", onTouchEnd, capture);
  el.addEventListener("touchcancel", onTouchEnd, capture);
  // Backup for a lift whose target moved elsewhere in the document.
  const doc = el.ownerDocument;
  doc.addEventListener("touchend", onTouchEnd, capture);
  doc.addEventListener("touchcancel", onTouchEnd, capture);
  return () => {
    endPinch();
    el.removeEventListener("pointerdown", onPointer, capture);
    el.removeEventListener("pointermove", onPointer, capture);
    el.removeEventListener("pointerup", onPointer, capture);
    el.removeEventListener("touchstart", onTouchStart, active);
    el.removeEventListener("touchmove", onTouchMove, active);
    el.removeEventListener("touchend", onTouchEnd, capture);
    el.removeEventListener("touchcancel", onTouchEnd, capture);
    doc.removeEventListener("touchend", onTouchEnd, capture);
    doc.removeEventListener("touchcancel", onTouchEnd, capture);
  };
}
