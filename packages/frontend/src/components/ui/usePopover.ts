import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { keepFocus as keepFocusOnPress } from "./keepFocus";
import { isEscapeKey } from "../../lib/keys";
import { useDismiss } from "../../hooks/useEscapeKey";
import { observeSize } from "../../lib/observeSize";
import { visibleContentBottom, visibleViewportTop } from "../../hooks/useVirtualKeyboard";

// One floating surface: placed next to a trigger (or at a pointer position for
// a context menu), clamped to the viewport, closed by Esc, Back or a pointer press
// outside, focused on open and handing focus back on close. Arrow keys, Home
// and End move between the surface's buttons and links.
//
// The caller owns `open`. It attaches `anchor` to the trigger (or the wrapper
// around it) and renders <Popover> or <Menu> with the returned state; a press
// on the anchor is not "outside", so the trigger's own click can toggle.

export type PopoverPlacement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

export type PopoverOptions = {
  open: boolean;
  onClose: () => void;
  /** Where the surface sits relative to the anchor (top-*: above it, for a
   *  trigger on a bar at the bottom of the screen). Default: bottom-end. */
  placement?: PopoverPlacement;
  /** Open at this viewport point instead of below the anchor (context menus, the
   *  bubble at a text selection). With a top-* placement the surface's bottom edge sits at `y`.
   *  `lineTop`: the top of the line being typed in, which stays clear: the surface takes the room
   *  under `y`, or the room above the line when there is little under it. */
  at?: { x: number; y: number; lineTop?: number };
  /** Leave focus where it is (the surface does not take it, nor give it back). Only useInlinePopover sets this: nothing then hears Esc on the surface. */
  keepFocus?: boolean;
};

export type PopoverState<A extends HTMLElement = HTMLElement> = {
  anchor: React.RefObject<A | null>;
  popup: React.RefObject<HTMLDivElement | null>;
  /** Viewport coordinates of the surface's top-left corner. */
  /** `room`: the height that can be seen (CSS length, --popover-room), once placed. */
  position: { left: number; top: number; room?: string };
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  /** On the surface: a press in a popover opened from this one bubbles here through React, so it is not "outside". */
  onPointerDown: () => void;
  /** On the surface: with `keepFocus`, a press anywhere on it (not on a text field) does not move focus off the text being typed in. */
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  close: () => void;
};

const MARGIN = 8;
/** Under this much room below the line, a surface beside it opens above it instead. */
const MIN_ROOM_BESIDE = 200;
const GAP = 6;
const FOCUSABLE = "button:not(:disabled), a[href]";

export function usePopover<A extends HTMLElement = HTMLDivElement>({ open, onClose, placement = "bottom-end", at, keepFocus }: PopoverOptions): PopoverState<A> {
  const anchor = useRef<A>(null);
  const popup = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState<PopoverState["position"]>({ left: at?.x ?? MARGIN, top: at?.y ?? MARGIN });
  // Read while rendering: by the effect, an autoFocus field in the content has
  // already taken focus and would be remembered as the "previous" element.
  const opener = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opener.current = document.activeElement;
  wasOpen.current = open;
  const atX = at?.x;
  const atY = at?.y;
  const lineTop = at?.lineTop;

  useLayoutEffect(() => {
    if (!open || !popup.current) return;
    const place = () => {
      const element = popup.current;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const viewWidth = document.documentElement.clientWidth;
      // Not under the on-screen keyboard, nor the editor's bar on top of it.
      const viewHeight = visibleContentBottom();
      const viewTop = visibleViewportTop();
      const up = placement.startsWith("top");
      // What can be seen, unless the surface has to stay clear of a line.
      let room = viewHeight - viewTop - 2 * MARGIN;
      let left: number;
      let top: number;
      if (atX !== undefined && atY !== undefined) {
        left = atX; top = atY - (up ? bounds.height : 0);
        if (lineTop !== undefined) {
          const under = viewHeight - atY - MARGIN;
          const over = lineTop - viewTop - MARGIN;
          const flips = under < MIN_ROOM_BESIDE && over > under;
          room = flips ? over : under;
          if (flips) top = lineTop - Math.min(bounds.height, room);
        }
      } else if (anchor.current) {
        const trigger = anchor.current.getBoundingClientRect();
        left = placement.endsWith("end") ? trigger.right - bounds.width : trigger.left;
        top = up ? trigger.top - bounds.height - GAP : trigger.bottom + GAP;
      } else return;
      setPosition({
        left: Math.max(MARGIN, Math.min(left, viewWidth - bounds.width - MARGIN)),
        top: Math.max(viewTop + MARGIN, Math.min(top, viewHeight - Math.min(bounds.height, room) - MARGIN)),
        // A surface taller than this would lose an edge or cover the line: it scrolls inside instead.
        room: `${room}px`,
      });
    };
    place();
    const stopObserving = observeSize(popup.current, place);
    window.addEventListener("resize", place);
    // A point-placed menu stays where the pointer was; an anchored one follows its trigger.
    const follows = atX === undefined;
    if (follows) window.addEventListener("scroll", place, true);
    return () => {
      stopObserving();
      window.removeEventListener("resize", place);
      if (follows) window.removeEventListener("scroll", place, true);
    };
  }, [open, placement, atX, atY, lineTop]);

  useEffect(() => {
    if (!open) return;
    const element = popup.current;
    const trigger = anchor.current;
    // A field inside that took focus on mount (autoFocus) keeps it.
    if (!keepFocus && !element?.contains(document.activeElement)) element?.focus({ preventScroll: true });
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (pressedInside.current) { pressedInside.current = false; return; }
      if (!anchor.current?.contains(target) && !element?.contains(target)) close.current();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      if (keepFocus || (document.activeElement !== document.body && !element?.contains(document.activeElement))) return;
      // An opener inside the surface is gone with it; fall back to the trigger.
      const before = opener.current;
      const target = before instanceof HTMLElement && before !== document.body && before.isConnected && !element?.contains(before) ? before
        : trigger?.matches(FOCUSABLE) ? trigger : trigger?.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus({ preventScroll: true });
    };
  }, [open, keepFocus]);

  // Back (and Esc when focus is not on the surface) closes the newest surface only: a menu inside a modal first.
  useDismiss(() => { close.current(); }, open);

  // React runs before this document listener, so a nested surface's press has set it by then.
  const pressedInside = useRef(false);
  const onPointerDown = () => { pressedInside.current = true; };

  // The surface is tabIndex=-1, so a tap on its padding would focus it and close the keyboard under the editor
  // (measured on Android, 2026-11-09). Preventing the mousedown default keeps focus for the whole surface, rows
  // included; a finger scroll fires no mousedown, so it is untouched. A real field inside stays focusable.
  const onMouseDown = (event: ReactMouseEvent<HTMLElement>) => {
    if (keepFocus) keepFocusOnPress(event);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (isEscapeKey(event)) { event.preventDefault(); close.current(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    // Arrow keys inside a text field move the caret, not the focus.
    const target = event.target as HTMLElement;
    if (target.matches("input, textarea, [contenteditable='true']")) return;
    event.preventDefault();
    const items = Array.from(popup.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[index]?.focus();
  };

  return {
    anchor,
    popup,
    position,
    onKeyDown,
    onPointerDown,
    onMouseDown,
    close: () => close.current(),
  };
}
