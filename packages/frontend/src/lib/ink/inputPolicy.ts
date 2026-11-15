// Ink input policy — which pointer draws, which pans, which zooms.
//
// A pure state machine (no DOM, no timers): the engine feeds it one pointer
// sample per pointer event and applies the actions it returns. Keeping the
// rules here means every host (handwriting page, whiteboard, PDF) gets the
// same finger/pen split, and the rules are testable with synthetic sequences.
//
// The rules (T1-1, tools model 2026-10-21):
//
//   Which pointers draw comes from the SELECTED TOOL, never from a hidden
//   "a pen was seen" latch:
//
//   | input                | Pen / Highlighter / Eraser     | Hand tool                    |
//   |----------------------|--------------------------------|------------------------------|
//   | pen (stylus)         | draws                          | pans (grab)                  |
//   | 1 finger             | draws (erases)                 | pans                         |
//   | 2 fingers            | pinch-zoom + pan               | pinch-zoom + pan             |
//   | 2-finger tap         | undo                           | undo                         |
//   | 3-finger tap         | redo                           | redo                         |
//   | mouse (left button)  | draws; with space held: pans   | pans                         |
//
//   - The device's two input settings (hooks/useInkInputPrefs.ts), the only
//     place a person chooses who draws:
//       finger — `stylusOnly` "only scroll": the Pen / Highlighter / Eraser
//         column's one-finger row becomes "pans" (off = follows the tool).
//         The ⋯ menu's 「手指也能畫」 switches it. A device switches it on by
//         itself the first time a pen touches it.
//       pen — `penDraws` "draws on touch" (default): the pen's row is "draws"
//         in EVERY tool column (Hand, and the host's Select / Text, included),
//         with the last drawing tool; the engine keeps that tool apart from
//         Hand (InkEngine `hand`). Off = the pen follows the table like a finger.
//     With the pen drawing everywhere, fingers scroll and zoom everywhere.
//   - Palm rejection: a pen always wins. A pen landing while a finger draws or
//     pans cancels that finger (its stroke is discarded, never committed);
//     touches that land while a pen draws, or that were active when it
//     landed, are ignored until they lift. Touches that land within
//     PALM_GRACE_MS of the last pen event are ignored too (a palm put down
//     between two words).
//   - Where a stroke may start (`inArea`, decided by the engine): anywhere in
//     the page's width and at any depth below its top, so the page can grow
//     ("infinite down"). Outside that (left/right of the paper, above it) a
//     finger pans instead.
//   - A cancelled PEN stroke is kept: Samsung Internet cancels the pen ~160 ms
//     after the side button goes down mid-stroke (penShortcut.ts, signal C), so
//     `draw-cancel` carries `keep` and the engine commits the part drawn so
//     far (>= 2 points; an eraser drag commits what it already erased). A
//     finger cancelled by a pen, a second finger or the browser stays
//     discarded.
//   - Read-only drawings: nothing draws and the tap gestures do nothing; the
//     pen and fingers pan / zoom, the mouse does nothing (wheel still scrolls).
//   - Native touch (`nativeTouch`, the PDF): fingers that do not draw belong
//     to the browser and the host. One finger scrolls natively (the engine
//     sets touch-action to match, see InkEngine) and two fingers pinch in the
//     host's touch layer (touchSplit.ts), so the policy emits no pan, zoom or
//     fling for touches. It still tracks them: a second finger still cancels
//     a finger's stroke, and 2-/3-finger taps still undo / redo.
//   - A host without pan/zoom (`gestures: false`) gets
//     the pre-T1-1 behaviour: the first pointer draws, other pointers are
//     ignored, and once a pen has been used touches are ignored entirely (an
//     in-memory latch of that host only; it is not a preference).
//
// Coordinates are client CSS px (only deltas and the pinch centre leave the
// policy); `t` is a monotonic ms timestamp (PointerEvent.timeStamp).

import { flingVelocity, pushFlingSample, type FlingSample } from "./glide";

/** A tap: every finger lifted within TAP_MAX_MS of the first one landing… */
export const TAP_MAX_MS = 300;
/** …and no finger moved further than TAP_SLOP_PX from where it landed. The
 *  same slop delays panning, so a resting palm or a tap never scrolls. */
export const TAP_SLOP_PX = 12;
/** Touches landing this soon after the last pen event are taken as a palm. */
export const PALM_GRACE_MS = 400;

export type InkPointerKind = "pen" | "touch" | "mouse";

export interface InkPointerSample {
  id: number;
  kind: InkPointerKind;
  /** Client CSS px. */
  x: number;
  y: number;
  /** ms, monotonic. */
  t: number;
  /** PointerEvent.button on pointerdown (0 = primary). */
  button?: number;
  /** pointerdown only: may a stroke start here? (false = left/right of the
   *  paper or above it; a finger then pans instead.) */
  inArea?: boolean;
}

export type InkInputAction =
  | { type: "draw-start"; id: number }
  | { type: "draw-move"; id: number }
  | { type: "draw-end"; id: number }
  /** Drop the in-progress stroke without committing it — except `keep`: the
   *  PEN itself was cancelled (side button pressed mid-stroke), so the engine
   *  commits what was drawn so far when it is at least a stroke. */
  | { type: "draw-cancel"; id: number; keep?: true }
  /** Move the content by (dx, dy) client px (content follows the fingers). */
  | { type: "pan"; dx: number; dy: number }
  /** Multiply the zoom by `factor`, keeping client point (x, y) fixed. */
  | { type: "zoom"; factor: number; x: number; y: number }
  /** A pan ended with this velocity (client px/ms) — host may glide. */
  | { type: "fling"; vx: number; vy: number }
  | { type: "undo" }
  | { type: "redo" };

export interface InkInputPolicyOptions {
  /** The Hand tool is selected: one finger, the pen or the mouse pans. */
  handTool?: boolean;
  /** The finger setting "only scroll": with a drawing tool, one finger pans
   *  (the pen draws). Off = a finger follows the toolbar. */
  stylusOnly?: boolean;
  /** The pen setting "draws on touch" (the default of the device): the pen
   *  draws with the last drawing tool whatever the toolbar's tool is — Hand
   *  included. Off = the pen follows the toolbar like a finger does. */
  penDraws?: boolean;
  readOnly?: boolean;
  /** The host can pan and zoom. False = legacy single-pointer drawing. */
  gestures?: boolean;
  /** Fingers scroll natively and pinch in the host (see the header). */
  nativeTouch?: boolean;
}

/** Whether one finger draws under these settings. */
export function fingerDraws(handTool: boolean, stylusOnly: boolean): boolean {
  return !handTool && !stylusOnly;
}

type Touch = { x: number; y: number; startX: number; startY: number };

type Mode =
  | { kind: "idle" }
  | { kind: "draw"; id: number; pointer: InkPointerKind }
  /** One pointer pans. `engaged` once it left the slop; `glide` = may fling. */
  | { kind: "pan"; id: number; lastX: number; lastY: number; engaged: boolean; glide: boolean; samples: FlingSample[] }
  | { kind: "pinch"; a: number; b: number; lastDist: number; lastMidX: number; lastMidY: number };

export class InkInputPolicy {
  private handTool: boolean;
  private stylusOnly: boolean;
  private penDraws: boolean;
  private readOnly: boolean;
  private readonly gestures: boolean;
  private readonly nativeTouch: boolean;
  private spaceHeld = false;
  /** gestures:false hosts only: a pen has drawn here, touches are palms. */
  private penUsedLegacy = false;

  private mode: Mode = { kind: "idle" };
  /** Live touches taking part in the current gesture. */
  private readonly touches = new Map<number, Touch>();
  /** Pointers we decided to ignore until they lift (palms, extra pointers). */
  private readonly ignored = new Set<number>();
  /** The current touch gesture, for tap detection (null = not a tap). */
  private tap: { start: number; fingers: number; moved: boolean } | null = null;
  private lastPenT = -Infinity;

  constructor(options: InkInputPolicyOptions = {}) {
    this.handTool = options.handTool ?? false;
    this.stylusOnly = options.stylusOnly ?? false;
    this.penDraws = options.penDraws ?? false;
    this.readOnly = options.readOnly ?? false;
    this.gestures = options.gestures ?? false;
    this.nativeTouch = options.nativeTouch ?? false;
  }

  configure(options: { handTool?: boolean; stylusOnly?: boolean; penDraws?: boolean; readOnly?: boolean }): void {
    if (options.handTool !== undefined) this.handTool = options.handTool;
    if (options.stylusOnly !== undefined) this.stylusOnly = options.stylusOnly;
    if (options.penDraws !== undefined) this.penDraws = options.penDraws;
    if (options.readOnly !== undefined) this.readOnly = options.readOnly;
  }

  /** Space held: mouse and pen drags pan instead of drawing (desktop habit).
   *  The Hand tool does the same for as long as it is selected. */
  setSpaceHeld(held: boolean): void { this.spaceHeld = held; }

  /** The pen draws whatever the toolbar's tool is. */
  get penDrawsAlways(): boolean { return this.penDraws; }

  /** Whether one finger would draw right now. */
  get fingerDraws(): boolean {
    return fingerDraws(this.handTool, this.stylusOnly);
  }

  /** The pointer currently drawing, if any. */
  get drawingPointer(): number | null {
    return this.mode.kind === "draw" ? this.mode.id : null;
  }

  /** Whether this pointer takes part in drawing or a gesture (false =
   *  ignored, e.g. a palm). */
  tracks(id: number): boolean {
    return this.touches.has(id) || this.isModePointer(id);
  }

  /** Touches currently taking part in a gesture. */
  get activeTouches(): number { return this.touches.size; }

  down(p: InkPointerSample): InkInputAction[] {
    // A pointerdown for an id we still track means we missed its up/cancel.
    const stale = this.touches.has(p.id) || this.ignored.has(p.id) || this.isModePointer(p.id)
      ? this.cancel(p)
      : [];
    const next = p.kind === "pen" ? this.penDown(p) : p.kind === "mouse" ? this.mouseDown(p) : this.touchDown(p);
    return stale.length > 0 ? [...stale, ...next] : next;
  }

  move(p: InkPointerSample): InkInputAction[] {
    if (p.kind === "pen") this.lastPenT = p.t;
    if (this.ignored.has(p.id)) return [];
    const mode = this.mode;
    const touch = this.touches.get(p.id);
    if (touch) {
      touch.x = p.x;
      touch.y = p.y;
      if (this.tap && Math.hypot(p.x - touch.startX, p.y - touch.startY) > TAP_SLOP_PX) {
        this.tap.moved = true;
      }
    }
    if (mode.kind === "draw" && mode.id === p.id) return [{ type: "draw-move", id: p.id }];
    if (mode.kind === "pan" && mode.id === p.id) return this.panMove(mode, p);
    if (mode.kind === "pinch" && (mode.a === p.id || mode.b === p.id)) return this.pinchMove(mode);
    return [];
  }

  up(p: InkPointerSample): InkInputAction[] {
    return this.release(p, false);
  }

  cancel(p: InkPointerSample): InkInputAction[] {
    return this.release(p, true);
  }

  /** Drop everything in flight (host lost focus, engine torn down). */
  reset(): InkInputAction[] {
    const out: InkInputAction[] = [];
    if (this.mode.kind === "draw") out.push({ type: "draw-cancel", id: this.mode.id });
    this.mode = { kind: "idle" };
    this.touches.clear();
    this.ignored.clear();
    this.tap = null;
    return out;
  }

  // ── pen ───────────────────────────────────────────────────────────────────

  private penDown(p: InkPointerSample): InkInputAction[] {
    const out: InkInputAction[] = [];
    this.lastPenT = p.t;
    this.penUsedLegacy = true;
    if (p.button !== undefined && p.button !== 0) { this.ignored.add(p.id); return out; }
    if (this.mode.kind === "draw" && this.mode.pointer !== "touch") {
      this.ignored.add(p.id); // a second pen / pen + mouse: the first one keeps going
      return out;
    }
    // The pen is authoritative: whatever the fingers were doing stops.
    out.push(...this.dropTouches());
    const penPans = this.handTool && !this.penDraws;
    if (this.readOnly || this.spaceHeld || penPans || p.inArea === false) {
      if (this.gestures && (this.readOnly || this.spaceHeld || penPans)) {
        this.mode = panMode(p, true, false);
      } else {
        this.ignored.add(p.id);
      }
      return out;
    }
    this.mode = { kind: "draw", id: p.id, pointer: "pen" };
    out.push({ type: "draw-start", id: p.id });
    return out;
  }

  // ── mouse ─────────────────────────────────────────────────────────────────

  private mouseDown(p: InkPointerSample): InkInputAction[] {
    if ((p.button ?? 0) !== 0 || this.mode.kind !== "idle" || this.touches.size > 0) {
      this.ignored.add(p.id);
      return [];
    }
    if ((this.spaceHeld || this.handTool) && this.gestures) {
      this.mode = panMode(p, true, false);
      return [];
    }
    if (this.readOnly || p.inArea === false) { this.ignored.add(p.id); return []; }
    this.mode = { kind: "draw", id: p.id, pointer: "mouse" };
    return [{ type: "draw-start", id: p.id }];
  }

  // ── touch ─────────────────────────────────────────────────────────────────

  private touchDown(p: InkPointerSample): InkInputAction[] {
    const penBusy = this.mode.kind === "draw" && this.mode.pointer !== "touch";
    const mouseBusy = this.mode.kind === "pan" && !this.touches.has(this.mode.id);
    if (penBusy || mouseBusy || p.t - this.lastPenT < PALM_GRACE_MS) {
      this.ignored.add(p.id);
      return [];
    }
    if (!this.gestures) return this.legacyTouchDown(p);

    this.touches.set(p.id, { x: p.x, y: p.y, startX: p.x, startY: p.y });
    const count = this.touches.size;
    if (count === 1) {
      this.tap = { start: p.t, fingers: 1, moved: false };
      if (!this.readOnly && this.fingerDraws && p.inArea !== false) {
        this.mode = { kind: "draw", id: p.id, pointer: "touch" };
        return [{ type: "draw-start", id: p.id }];
      }
      this.mode = panMode(p, false, true);
      return [];
    }
    if (this.tap) this.tap.fingers = Math.max(this.tap.fingers, count);
    const out: InkInputAction[] = [];
    if (this.mode.kind === "draw") {
      // The first finger's stroke was the start of a two-finger gesture.
      out.push({ type: "draw-cancel", id: this.mode.id });
    }
    if (this.mode.kind !== "pinch") this.startPinch();
    return out;
  }

  /** Pre-T1-1 behaviour for hosts that cannot pan or zoom. */
  private legacyTouchDown(p: InkPointerSample): InkInputAction[] {
    if (this.penUsedLegacy || this.readOnly || this.mode.kind !== "idle" || p.inArea === false) {
      this.ignored.add(p.id);
      return [];
    }
    this.mode = { kind: "draw", id: p.id, pointer: "touch" };
    return [{ type: "draw-start", id: p.id }];
  }

  private startPinch(): void {
    const [a, b] = [...this.touches.keys()];
    const ta = this.touches.get(a)!;
    const tb = this.touches.get(b)!;
    this.mode = {
      kind: "pinch", a, b,
      lastDist: Math.max(1, Math.hypot(ta.x - tb.x, ta.y - tb.y)),
      lastMidX: (ta.x + tb.x) / 2,
      lastMidY: (ta.y + tb.y) / 2,
    };
  }

  private panMove(mode: Extract<Mode, { kind: "pan" }>, p: InkPointerSample): InkInputAction[] {
    if (this.nativeTouch && this.touches.has(mode.id)) return []; // the browser scrolls
    if (!mode.engaged) {
      if (this.tap && !this.tap.moved) return [];
      mode.engaged = true;
    }
    const dx = p.x - mode.lastX;
    const dy = p.y - mode.lastY;
    mode.lastX = p.x;
    mode.lastY = p.y;
    pushFlingSample(mode.samples, p.t, p.x, p.y);
    if (dx === 0 && dy === 0) return [];
    return [{ type: "pan", dx, dy }];
  }

  private pinchMove(mode: Extract<Mode, { kind: "pinch" }>): InkInputAction[] {
    if (this.nativeTouch) return []; // the host's touch layer pinches
    // Hold the camera until the gesture leaves the slop: a two- or
    // three-finger tap must not nudge the page.
    if (this.tap && !this.tap.moved) return [];
    const ta = this.touches.get(mode.a)!;
    const tb = this.touches.get(mode.b)!;
    const dist = Math.max(1, Math.hypot(ta.x - tb.x, ta.y - tb.y));
    const midX = (ta.x + tb.x) / 2;
    const midY = (ta.y + tb.y) / 2;
    const out: InkInputAction[] = [];
    const dx = midX - mode.lastMidX;
    const dy = midY - mode.lastMidY;
    if (dx !== 0 || dy !== 0) out.push({ type: "pan", dx, dy });
    const factor = dist / mode.lastDist;
    if (factor !== 1) out.push({ type: "zoom", factor, x: midX, y: midY });
    mode.lastDist = dist;
    mode.lastMidX = midX;
    mode.lastMidY = midY;
    return out;
  }

  // ── lifting ───────────────────────────────────────────────────────────────

  private release(p: InkPointerSample, cancelled: boolean): InkInputAction[] {
    if (p.kind === "pen") this.lastPenT = p.t;
    if (this.ignored.delete(p.id)) return [];
    const out: InkInputAction[] = [];
    const mode = this.mode;
    const wasTouch = this.touches.delete(p.id);

    if (mode.kind === "draw" && mode.id === p.id) {
      out.push(
        !cancelled ? { type: "draw-end", id: p.id }
        : p.kind === "pen" && mode.pointer === "pen" ? { type: "draw-cancel", id: p.id, keep: true }
        : { type: "draw-cancel", id: p.id },
      );
      this.mode = { kind: "idle" };
    } else if (mode.kind === "pan" && mode.id === p.id) {
      if (!cancelled && !this.nativeTouch && mode.glide && mode.engaged && this.touches.size === 0 && (this.tap?.fingers ?? 1) === 1) {
        const fling = flingOf(mode.samples, p.t);
        if (fling) out.push(fling);
      }
      this.mode = { kind: "idle" };
    } else if (mode.kind === "pinch" && (mode.a === p.id || mode.b === p.id)) {
      if (this.touches.size >= 2) {
        this.startPinch();
      } else if (this.touches.size === 1) {
        // Back to one finger after a pinch: it keeps panning, never draws.
        const [id, t] = [...this.touches.entries()][0];
        this.mode = { kind: "pan", id, lastX: t.x, lastY: t.y, engaged: true, glide: false, samples: [] };
      } else {
        this.mode = { kind: "idle" };
      }
    }

    if (wasTouch && this.touches.size === 0) {
      const tap = this.tap;
      this.tap = null;
      if (!cancelled && tap && !tap.moved && p.t - tap.start <= TAP_MAX_MS && !this.readOnly) {
        if (tap.fingers === 2) out.push({ type: "undo" });
        else if (tap.fingers === 3) out.push({ type: "redo" });
      }
    } else if (wasTouch && cancelled) {
      this.tap = null; // the browser took a finger: no tap from this gesture
    }
    return out;
  }

  /** A pen landed: every live touch stops (its stroke is discarded) and is
   *  ignored until it lifts. */
  private dropTouches(): InkInputAction[] {
    const out: InkInputAction[] = [];
    if (this.mode.kind === "draw" && this.mode.pointer === "touch") {
      out.push({ type: "draw-cancel", id: this.mode.id });
    }
    if (this.mode.kind !== "draw" || this.mode.pointer === "touch") this.mode = { kind: "idle" };
    for (const id of this.touches.keys()) this.ignored.add(id);
    this.touches.clear();
    this.tap = null;
    return out;
  }

  private isModePointer(id: number): boolean {
    const mode = this.mode;
    if (mode.kind === "draw" || mode.kind === "pan") return mode.id === id;
    return false;
  }
}

function panMode(p: InkPointerSample, engaged: boolean, glide: boolean): Mode {
  return { kind: "pan", id: p.id, lastX: p.x, lastY: p.y, engaged, glide, samples: [[p.t, p.x, p.y]] };
}

function flingOf(samples: FlingSample[], now: number): InkInputAction | null {
  const v = flingVelocity(samples, now);
  return v && { type: "fling", ...v };
}
