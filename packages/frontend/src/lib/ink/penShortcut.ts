// Pen shortcut → "pen ↔ eraser" toggle, whichever device it came from.
//
// A shortcut is "the user pressed the pen's own button / gesture"; the host
// answers it the same way everywhere (usePenShortcutTool). Sources:
//
//   1. S Pen side button in a browser (below: signals A and B; C is not a
//      toggle). Handled by PenShortcutDetector, fed by the engine's pointer events.
//   2. A native shell (not built yet) that can see what the web cannot:
//      the S Pen button through the Samsung SDK, and Apple Pencil double-tap
//      (Pencil 2) / squeeze (Pencil Pro) through UIPencilInteraction. The
//      shell calls `window.ondenPenShortcut(source)` or dispatches the
//      `onden:pen-shortcut` CustomEvent (lib/penShortcutBridge.ts). Without a shell
//      nothing ever calls it.
//   iPad Safari itself gives pages no Apple Pencil button signal at all, so on
//   iPad the detector must stay silent (see "Never a shortcut" below).
//
// The web never receives the S Pen button itself: Chromium's stylus_text_selector
// swallows any touch that lands with the button held (it selects text). What a
// page can see is one of two indirect signals (measured on a Galaxy Tab S9,
// 2026-10-25), and both are handled — we never sniff the browser, we act on
// whichever signal arrives:
//
//   A. Hover click (Samsung Internet only): while the pen hovers, a pen
//      `pointermove` whose `buttons` goes 0 → non-0 with no pointerdown before
//      it; releasing sends another move with `buttons` 0. A real tip contact
//      always starts with pointerdown, so "no pen is down" makes it the button.
//   B. Press-and-hold click or stroke (Chrome and Samsung Internet): the whole
//      stroke is eaten, only a `contextmenu` arrives ~150 ms after the pen
//      lifts, with pointerType "mouse" (sometimes "") and no pointerdown before
//      it. A finger long-press is "touch" after a touch pointerdown; a pen
//      long-press (no button) follows a pen pointerdown. Neither is the button.
//   C. Button pressed mid-stroke (Samsung Internet): `pointercancel` (pen) after
//      ~160 ms. That is not a toggle by itself; the engine keeps the part drawn
//      so far (see inputPolicy: a cancelled pen stroke is kept).
//
// Never a shortcut (iPad Safari, untested on a device): Safari's contextmenu is
// a MouseEvent without `pointerType`, so its type can't tell a finger or
// Pencil long-press (magnifier / callout) from the S Pen button. What does:
// a long-press always has a pen or touch pointerdown before it, and iOS may
// cancel that pointer (`pointercancel`) before the menu fires, later than the
// quiet window. So B also stays silent for PEN_SHORTCUT_CANCEL_MS after a
// pen / touch contact that ended in pointercancel. Pencil hover is only
// pen `pointermove` with buttons 0, which is not signal A either.
//
// Samsung Internet sends A and B for one press, so B does not toggle again
// while A's press is still held or happened within PEN_SHORTCUT_DOUBLE_MS.
// Chrome repeats B about every 200 ms while the held pen moves on the glass
// (measured 2026-10-27): B within PEN_SHORTCUT_REPEAT_MS of the last B is the
// same press, swallowed without toggling.
//
// Pure state machine like inputPolicy.ts: no DOM, the engine feeds it events.

import type { InkActiveTool } from "./types";

/** A contextmenu while a pointer is down on the element, or this soon after
 *  one went down or up, belongs to that pointer (a long-press fires while the
 *  finger or pen is still down, a right-click right after its pointerdown),
 *  not to the side button. The button's own stroke sends no pointer events at
 *  all, so an earlier stroke only blocks it when it ended this recently. */
export const PEN_SHORTCUT_QUIET_MS = 600;
/** A contextmenu this soon after a hover toggle is the same press again. */
export const PEN_SHORTCUT_DOUBLE_MS = 3000;
/** A contextmenu this soon after a pen / touch contact was cancelled by the
 *  browser is that contact's long-press menu, not the side button. */
export const PEN_SHORTCUT_CANCEL_MS = 2000;

/** A contextmenu this soon after the previous side-button one is the same
 *  press, still held (Chrome repeats them while the pen moves). */
export const PEN_SHORTCUT_REPEAT_MS = 700;

/** After a pen contact the hover buttons are unknown until a move reports them. */
const BUTTONS_UNKNOWN = -1;
/** A hovering S Pen reports moves continuously (jitter included); a gap this
 *  long means it left the digitizer's range. A pen that comes back with the
 *  button already down was pressed while away: that counts as a press. */
export const PEN_SHORTCUT_ABSENT_MS = 500;

export interface PenShortcutContextMenuResult {
  /** The engine should preventDefault (no native menu / text selection). */
  swallow: boolean;
  /** The side button was pressed: switch tools. */
  toggle: boolean;
}

export class PenShortcutDetector {
  private readonly pensDown = new Set<number>();
  /** Every pointer down on the element, any kind. */
  private readonly down = new Set<number>();
  private hoverButtons = 0;
  private lastPointerT = -Infinity;
  /** The last pen event of any kind (down, move, up). */
  private lastPenT = -Infinity;
  private hoverToggleT = -Infinity;
  /** When a pen / touch contact last ended in pointercancel. */
  private contactCancelT = -Infinity;
  /** A toggled by this press and its release (buttons 0) has not come yet. */
  private holdToggled = false;
  /** The last contextmenu taken as the side button (signal B). */
  private lastMenuT = -Infinity;

  /** Any pointerdown on the element (every kind: a mouse right-click is a
   *  pointerdown, the side button never is). */
  pointerDown(kind: string, id: number, t: number): void {
    this.lastPointerT = t;
    this.down.add(id);
    if (kind === "pen") {
      this.lastPenT = t;
      this.pensDown.add(id);
      this.hoverButtons = BUTTONS_UNKNOWN;
    }
  }

  /** `cancelled`: the end was a pointercancel, not a pointerup. */
  pointerEnd(kind: string, id: number, t: number, cancelled = false): void {
    this.lastPointerT = t;
    if (cancelled && kind !== "mouse") this.contactCancelT = t;
    this.down.delete(id);
    if (kind === "pen") {
      this.lastPenT = t;
      this.pensDown.delete(id);
      // The side button may still be held as the tip lifts (Samsung Internet
      // passes a held-button tap through as an ordinary pen down/up): only a
      // hover move with no buttons re-arms signal A.
      this.hoverButtons = BUTTONS_UNKNOWN;
    }
  }

  /** A pointermove; true = the side button was pressed (signal A). */
  pointerMove(kind: string, buttons: number, t: number): boolean {
    if (kind !== "pen") return false;
    const returned = t - this.lastPenT > PEN_SHORTCUT_ABSENT_MS;
    this.lastPenT = t;
    if (this.pensDown.size > 0) return false;
    // Back in range after being away: whatever was held before is over.
    if (returned) {
      this.hoverButtons = 0;
      this.holdToggled = false;
    }
    const pressed = this.hoverButtons === 0 && buttons !== 0;
    this.hoverButtons = buttons;
    if (buttons === 0) {
      this.holdToggled = false;
      return false;
    }
    if (!pressed) return false;
    this.holdToggled = true;
    this.hoverToggleT = t;
    return true;
  }

  /** A contextmenu on the element (signal B). Touch / pen menus are not ours. */
  contextMenu(pointerType: string, t: number): PenShortcutContextMenuResult {
    const none = { swallow: false, toggle: false };
    if (pointerType === "touch" || pointerType === "pen") return none;
    if (this.down.size > 0 || t - this.lastPointerT < PEN_SHORTCUT_QUIET_MS) return none;
    if (t - this.contactCancelT < PEN_SHORTCUT_CANCEL_MS) return none;
    const repeat = t - this.lastMenuT < PEN_SHORTCUT_REPEAT_MS;
    this.lastMenuT = t;
    const sameAsHover = this.holdToggled || t - this.hoverToggleT < PEN_SHORTCUT_DOUBLE_MS;
    return { swallow: true, toggle: !sameAsHover && !repeat };
  }

  reset(): void {
    this.pensDown.clear();
    this.down.clear();
    this.hoverButtons = 0;
    this.holdToggled = false;
    this.lastPointerT = -Infinity;
    this.lastPenT = -Infinity;
    this.hoverToggleT = -Infinity;
    this.lastMenuT = -Infinity;
    this.contactCancelT = -Infinity;
  }
}

/** The tool a pen shortcut switches to: the eraser ↔ the last tool that
 *  was not the eraser (pen, highlighter, hand; pen when none). */
export function penShortcutTool(current: InkActiveTool, lastNonEraser: InkActiveTool | null): InkActiveTool {
  if (current === "eraser") return lastNonEraser ?? "pen";
  return "eraser";
}
