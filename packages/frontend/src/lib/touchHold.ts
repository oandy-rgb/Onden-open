import { vibrate } from "./haptics";
// The touch / pen "hold a row" gesture, shared by the note rows (hooks/useSidebarDrag), the tag rows
// (components/SidebarTagTree) and the view tabs (components/viewTabs/ViewTabs): hold → the row lifts; move it → it drags; let go in place → its menu.

/** How far a finger may wander (px, CSS) while it is still counted as "held in place": before the
 *  lift, moving further means the list is being scrolled (abort); after the lift, moving further
 *  means a drag, and less is "let go in place" (the menu). A fingertip on a tablet jitters well past
 *  4px just by resting, so this follows Android's touch slop (8dp) and dnd-kit's TouchSensor
 *  tolerance, rounded up to 10 for the larger tablet pad. */
export const HOLD_SLOP = 10;
/** How long a still finger must stay down before the row lifts (ms). */
export const HOLD_MS = 300;

/** Edge auto-scroll of a list while a held row is dragged near its edge. Defaults to the sidebar
 *  list (vertical); a horizontal row of tabs passes its own `list` and `axis: "x"`. */
export function createEdgeAutoScroll(
  isDragging: () => boolean,
  onScrolled: (x: number, y: number) => void,
  { list: findList = () => document.querySelector<HTMLElement>(".obsidian-page-list"), axis = "y" }: { list?: () => HTMLElement | null; axis?: "x" | "y" } = {},
) {
  const state: { x: number | null; y: number | null; frame: number | null } = { x: null, y: null, frame: null };
  const stop = () => {
    state.x = null;
    state.y = null;
    if (state.frame !== null) {
      window.cancelAnimationFrame(state.frame);
      state.frame = null;
    }
  };
  const start = (clientX: number, clientY: number) => {
    state.x = clientX;
    state.y = clientY;
    if (state.frame !== null) return;
    const tick = () => {
      if (!isDragging() || state.x === null || state.y === null) {
        state.frame = null;
        return;
      }
      const list = findList();
      if (!list) {
        state.frame = window.requestAnimationFrame(tick);
        return;
      }
      const rect = list.getBoundingClientRect();
      const edge = 64;
      const maxSpeed = 18;
      let speed = 0;
      const at = axis === "x" ? state.x : state.y;
      const near = axis === "x" ? rect.left : rect.top;
      const far = axis === "x" ? rect.right : rect.bottom;
      if (at < near + edge) speed = -Math.round(((near + edge - at) / edge) * maxSpeed);
      else if (at > far - edge) speed = Math.round(((at - (far - edge)) / edge) * maxSpeed);
      if (speed !== 0) {
        if (axis === "x") list.scrollLeft += speed; else list.scrollTop += speed;
        onScrolled(state.x, state.y);
      }
      state.frame = window.requestAnimationFrame(tick);
    };
    state.frame = window.requestAnimationFrame(tick);
  };
  return { start, stop };
}

/** Marks a touch press (and a moment after it) so the browser's own long-press contextmenu, which
 *  belongs to the press, can be swallowed: the press opens the menu itself when the finger lifts. */
export function createTouchPressGuard() {
  let pressed = false;
  return {
    begin: () => { pressed = true; },
    // The browser's contextmenu can trail the lift a little.
    end: () => { window.setTimeout(() => { pressed = false; }, 400); },
    swallow(e: { preventDefault(): void }): boolean {
      if (!pressed) return false;
      e.preventDefault();
      return true;
    },
  };
}

/** After a lifted press ends, the browser still sends the click that belongs
 *  to the touch, at the finger. The menu (or drop) has just opened there, so
 *  that click would pick its first item: swallow the next click, briefly. */
export function swallowNextClick(ms = 500) {
  // The timer can outlive the page that started it (a test's window is torn down 500 ms later: `window` is gone
  // or has lost its methods). So the end of the wait calls nothing on the window: the listener carries an
  // AbortSignal, and aborting it is what takes the listener off, whatever state the window is in by then.
  const host = window;
  const ended = new AbortController();
  const timer = host.setTimeout(() => ended.abort(), ms);
  host.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); host.clearTimeout(timer); ended.abort(); }, { capture: true, signal: ended.signal });
}

/** How long a press must stay still to count as a long press (opens a menu or shows an embed's
 *  source). Not the row lift above (HOLD_MS): that one starts a drag and is shorter on purpose. */
export const LONG_PRESS_MS = 500;
/** How long a finger must stay still on the board's bare pane before its drag draws a selection box instead
 *  of moving the board (lib/boardTouchGestures). Longer than the row lift (HOLD_MS) because a pan starts at
 *  the same spot and must not be mistaken for it; shorter than LONG_PRESS_MS, which would open a menu. */
export const BOX_SELECT_HOLD_MS = 400;

export interface LongPressPointer {
  pointerType: string;
  button: number;
  clientX: number;
  clientY: number;
}

/** The one long-press timer: a press held still for LONG_PRESS_MS (wandering at most HOLD_SLOP px)
 *  calls `onLongPress`, and the click that ends it is swallowed with `consumeClick` so the row does
 *  not also open. `mouse: false` leaves the mouse out (the caller has its own mouse behaviour). */
export function createLongPress(onLongPress: () => void, { mouse = true }: { mouse?: boolean } = {}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;
  let fired = false;
  const cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; origin = null; };
  const fire = () => { cancel(); fired = true; onLongPress(); };
  return {
    down(e: LongPressPointer) {
      fired = false;
      if (e.button > 0 || (!mouse && e.pointerType === "mouse")) return; // a right or middle press is the contextmenu's
      origin = { x: e.clientX, y: e.clientY };
      timer = setTimeout(fire, LONG_PRESS_MS);
    },
    move(e: Pick<LongPressPointer, "clientX" | "clientY">) {
      if (origin && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > HOLD_SLOP) cancel();
    },
    cancel,
    /** The browser's own long-press / right-click contextmenu: it counts as the long press. */
    contextMenu() { if (!fired) fire(); },
    /** True (and the click is stopped) when this click is the tail of a long press. */
    consumeClick(e: Pick<Event, "preventDefault" | "stopPropagation">): boolean {
      if (!fired) return false;
      fired = false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
  };
}

export interface TouchHoldHandlers {
  /** The row lifted (finger still for HOLD_MS). */
  onLift: () => void;
  /** The finger moved more than HOLD_SLOP after the lift, or is still moving. */
  onDrag: (x: number, y: number) => void;
  /** The finger lifted. `moved`: it had left the hold slop (a drop); otherwise let go in place. */
  onRelease: (x: number, y: number, moved: boolean) => void;
  /** The gesture ended without a release (scroll started before the lift, or the browser cancelled). */
  onAbort: () => void;
}

/** Finger and S Pen share the hold route: both are scrolled by the browser in a scrollable list,
 *  so neither can start a drag by moving (only the mouse can). */
export function isHoldPointer(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

const noopTouchStart = () => {};
/** Ref callback for a container whose rows use the hold gesture (note list, tag list, view tabs).
 *  Chromium decides at `touchstart` whether a touch sequence has a blocking listener; if none is there
 *  then, every later `touchmove` is non-cancelable and the list scrolls away under a held row, whatever
 *  listener `beginTouchHold` adds on pointerdown. So a no-op `{ passive: false }` touchstart must already
 *  sit on the container. It stays off window/body: there it would make all scrolling wait on the main thread. */
export function holdSurface(el: HTMLElement | null) {
  el?.addEventListener("touchstart", noopTouchStart, { passive: false });
}

/** Starts the hold gesture for a touch / pen pointerdown; no-op for the mouse. Returns whether it took the press. */
export function beginTouchHold(e: PointerEvent | React.PointerEvent, guard: ReturnType<typeof createTouchPressGuard>, h: TouchHoldHandlers): boolean {
  if (!isHoldPointer(e.pointerType) || e.button !== 0) return false;
  const startX = e.clientX;
  const startY = e.clientY;
  // The element that took the press. If it is gone from the page by the time the hold would lift (its row was
  // removed or its screen closed mid-press), the gesture ends instead of lifting something that no longer exists.
  const owner = (e.currentTarget ?? e.target) as Node | null;
  let lifted = false;
  let moved = false;
  guard.begin();
  const onTouchMove = (te: TouchEvent) => {
    // Last line of defence (holdSurface should make this rare): not cancelable = the browser has already
    // taken the gesture to scroll the list, so a drag now would run alongside the scroll: give up.
    if (!te.cancelable) { finish(); h.onAbort(); return; }
    // Before the lift a move is a scroll (let it); after the lift it is the drag (stop the scroll).
    if (lifted) te.preventDefault();
  };
  window.addEventListener("touchmove", onTouchMove, { passive: false });
  const timer = window.setTimeout(() => {
    if (owner && !owner.isConnected) { finish(); h.onAbort(); return; }
    lifted = true; vibrate(10); h.onLift();
  }, HOLD_MS);
  const finish = () => {
    window.clearTimeout(timer);
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    guard.end();
  };
  function onMove(ev: PointerEvent) {
    if (!lifted) {
      // Moved past the slop before the hold fired: the list is being scrolled, not dragged.
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) >= HOLD_SLOP) { finish(); h.onAbort(); }
      return;
    }
    ev.preventDefault();
    if (!moved) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < HOLD_SLOP) return;
      moved = true;
    }
    h.onDrag(ev.clientX, ev.clientY);
  }
  function onUp(ev: PointerEvent) {
    const wasLifted = lifted;
    finish();
    if (!wasLifted) return; // a plain tap: the click handles it
    ev.preventDefault();
    swallowNextClick();
    h.onRelease(ev.clientX, ev.clientY, moved);
  }
  function onCancel() { finish(); h.onAbort(); }
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp, { passive: false });
  window.addEventListener("pointercancel", onCancel);
  return true;
}
