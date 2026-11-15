import { useEffect, useRef, type RefObject } from "react";
import { EditorView } from "@codemirror/view";
import { barClearance, BAR_GAP_PX, baseRoomPx, roomSlot, setBarClearance, whenNotComposing } from "../lib/editorKeyboard";
import { collapseEndRoom, endRoom } from "../lib/editorEndRoom";
import { observeSize } from "../lib/observeSize";
import { useVirtualKeyboard, visibleViewportBottom } from "./useVirtualKeyboard";

// React side of the editor's keyboard owner; the caret rule and the why are in lib/editorKeyboard.

/** Switching keyboards or IME panels can drop the keyboard for a moment; only one that stays closed this long counts. */
const KEYBOARD_CLOSE_MS = 350;
/** The keyboard's rise is an animation; its size is read once it has been still this long. */
const KEYBOARD_SETTLE_MS = 250;

export interface EditorKeyboardOptions {
  viewRef: RefObject<EditorView | null>;
  barRef: RefObject<HTMLElement | null>;
  /** The bar is shown (touch layout, editor focused). */
  barUp: boolean;
  /** The person is writing: the editor has focus and is editable. */
  writing: boolean;
  /** A keyboard that was open under a focused editor stayed closed (Android Back, iOS ⌄): leave the editor. */
  onKeyboardClosed: () => void;
}

export function useEditorKeyboard({ viewRef, barRef, barUp, writing, onKeyboardClosed }: EditorKeyboardOptions): { barInset: string } {
  const keyboard = useVirtualKeyboard(barUp);
  const insetRef = useRef(0);
  insetRef.current = keyboard.inset;
  const closedRef = useRef(onKeyboardClosed);
  closedRef.current = onKeyboardClosed;

  // Margin: the caret stays clear of the bar. Follows the bar's own height (it changes with a selection), never the keyboard.
  useEffect(() => {
    const view = viewRef.current;
    const bar = barRef.current;
    if (!view) return;
    const apply = () => {
      const px = barUp && bar ? Math.round(bar.getBoundingClientRect().height) + BAR_GAP_PX : 0;
      if (view.state.field(barClearance, false) !== px) view.dispatch({ effects: setBarClearance.of(px) });
    };
    apply();
    return barUp ? observeSize(bar, apply) : undefined;
  }, [viewRef, barRef, barUp]);

  // Room under the last line: decided when writing starts and left alone while it lasts. Without resizes-content the
  // page cannot be scrolled so far that the end clears keyboard + bar, so once the keyboard has settled the room grows
  // to cover them (grow-only, once per writing session).
  const room = useRef(0);
  const roomApply = useRef<(px: number) => void>(() => {});
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancel = () => {};
    const apply = (px: number) => {
      if (px === room.current) return;
      room.current = px;
      cancel();
      cancel = whenNotComposing(view, () => {
        if (room.current !== px) return;
        const set = () => view.dispatch({ effects: roomSlot.reconfigure(px > 0 ? endRoom(px, visibleViewportBottom) : []) });
        // Taking the room away waits for a pressed pointer (it may be on something the room holds down).
        if (px === 0) collapseEndRoom(view, () => { if (room.current === 0) set(); }); else set();
      });
    };
    roomApply.current = apply;
    apply(writing ? baseRoomPx(visibleViewportBottom()) : 0);
    return () => { cancel(); roomApply.current = () => {}; };
  }, [viewRef, writing]);

  // The keyboard has finished opening (once per opening): grow the room if it must, then ask "nearest" once.
  useEffect(() => {
    if (!writing || !barUp || !keyboard.open) return;
    const timer = setTimeout(() => {
      const view = viewRef.current;
      if (!view) return;
      const cover = Math.round(insetRef.current + (barRef.current?.getBoundingClientRect().height ?? 0) + BAR_GAP_PX);
      if (insetRef.current > 0) roomApply.current(Math.max(room.current, cover));
      whenNotComposing(view, () => {
        if (view.hasFocus) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "nearest" }) });
      });
    }, KEYBOARD_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [viewRef, barRef, writing, barUp, keyboard.open]);

  // A keyboard that closes under a focused editor, without a blur, strands the bar: report it.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (keyboard.open) { wasOpen.current = true; return; }
    if (!wasOpen.current || !writing) return;
    const timer = setTimeout(() => { wasOpen.current = false; closedRef.current(); }, KEYBOARD_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [keyboard.open, writing]);

  return { barInset: `${keyboard.inset}px` };
}
