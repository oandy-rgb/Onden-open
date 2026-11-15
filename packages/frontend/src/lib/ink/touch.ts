import { isHoldPointer } from "../touchHold";

/** This device takes touch input (phone, tablet, touch laptop). The one place
 *  that asks — device checks stay inside lib/ink (guards/ink.guard.test.ts). */
export function deviceHasTouch(): boolean {
  return typeof navigator !== "undefined" && (navigator.maxTouchPoints ?? 0) > 0;
}

/** This pointerdown is a finger or a pen on the screen (not a mouse): for components, which may not read
 *  `pointerType` themselves. */
export function pressedOnScreen(e: { pointerType: string }): boolean {
  return isHoldPointer(e.pointerType);
}
