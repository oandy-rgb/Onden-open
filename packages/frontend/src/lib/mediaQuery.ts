// Screen-width and pointer questions, answered without React: the ONE place that calls window.matchMedia
// (hooks/useIsMobile wraps it for components). lib/ and hooks/ files ask here.

/** The only three widths the app switches layout at, in CSS `@media` and here
 *  (guarded by dup-b2-ui.guard.test.ts): phone sheets, the mobile layout, wide desktop.
 *  CSS cannot read these, so a stylesheet writes the same number
 *  (`@media (max-width: 900px)` / `(min-width: 901px)`). */
export const BREAKPOINT_PX = { phone: 600, mobile: 900, wide: 1280 } as const;
export const MOBILE_QUERY = `(max-width: ${BREAKPOINT_PX.mobile}px)`;
/** A phone held upright: a 16:9 slide is about 360px wide there (hooks/usePresentLandscape). */
export const PORTRAIT_PHONE_QUERY = `(max-width: ${BREAKPOINT_PX.phone}px) and (orientation: portrait)`;
/** A finger, not a mouse: the OS draws its own selection handles and
 *  copy/paste menu, and targets need 44px of reach. This is the *primary*
 *  input. Not the same as `deviceHasTouch()` (lib/ink/touch.ts: any touch
 *  screen, a touch laptop too, for the pen layer) or a single event's
 *  `pointerType === "touch"`; ask the one that matches the question. */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

/** Whether the query holds right now; false where matchMedia is missing. */
export function matchesMedia(query: string): boolean {
  return mediaQueryList(query)?.matches ?? false;
}

/** One-off check for event handlers and layout maths (no re-render). */
export function isMobileLayout(): boolean { return matchesMedia(MOBILE_QUERY); }
export function isCoarsePointer(): boolean { return matchesMedia(COARSE_POINTER_QUERY); }
/** Some pointer of this device is a finger (an iPad with a trackpad attached still has its screen). */
export function hasAnyCoarsePointer(): boolean { return matchesMedia("(any-pointer: coarse)"); }
/** The app was opened from the Home Screen / as an installed app, not in a browser tab. */
export function runsStandalone(): boolean { return matchesMedia("(display-mode: standalone)"); }

/** The query's live MediaQueryList (to listen for changes), or null where matchMedia is missing (SSR, jsdom). */
export function mediaQueryList(query: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

/** A page wide enough for three columns (the 今天 page): at least the wide breakpoint. */
export const WIDE_QUERY = `(min-width: ${BREAKPOINT_PX.wide}px)`;
