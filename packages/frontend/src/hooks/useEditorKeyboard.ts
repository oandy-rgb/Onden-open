import { useEffect, useRef, type RefObject } from "react";
import { EditorView } from "@codemirror/view";
import { barClearance, BAR_GAP_PX, barClearancePx, baseRoomPx, keepCaretLineStill, roomSlot, scrollerOf, setBarClearance, SHORT_VISIBLE_PX, TYPING_SHORT_ATTR, whenNotComposing } from "../lib/editorKeyboard";
import { setRootAttribute, setRootStyle } from "../lib/documentAccess";
import { collapseEndRoom, endRoom } from "../lib/editorEndRoom";
import { observeSize } from "../lib/observeSize";
import { useVirtualKeyboard, visibleViewportBottom } from "./useVirtualKeyboard";

// React side of the editor's keyboard owner; the caret rule and the why are in lib/editorKeyboard.

/** Switching keyboards or IME panels can drop the keyboard for a moment; only one that stays closed this long counts. */
const KEYBOARD_CLOSE_MS = 350;
/** The keyboard's rise is an animation (on a tablet with a tall top row it comes in steps). It is over when what scrolls the
 *  editor has not changed size, and the keyboard's size has not changed, for this many frames; no fixed time. Pans never count. */
const QUIET_FRAMES = 6;

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

  // Where the bar is not over the scroller's foot, the page makes room for it instead: the note column ends at the bar (global.css,
  // `html[data-kb-bar]`), so the browser's own caret scrolling stops above it too. Only where the browser resizes the layout for the
  // keyboard (inset 0, bar at bottom 0); iOS places the bar by the inset and keeps the margin below.
  const shortenColumn = barUp && keyboard.inset === 0;
  useEffect(() => {
    const bar = barRef.current;
    if (!shortenColumn || !bar) return;
    const publish = () => setRootStyle("--ac-kb-bar-height", `${Math.round(bar.getBoundingClientRect().height)}px`);
    publish();
    setRootAttribute("data-kb-bar", "");
    const stop = observeSize(bar, publish);
    return () => { stop(); setRootAttribute("data-kb-bar", null); setRootStyle("--ac-kb-bar-height", null); };
  }, [barRef, shortenColumn]);

  // Margin: the caret stays clear of the bar: what of the scroller's foot the bar covers (lib/editorKeyboard barClearancePx).
  // Follows the bar's own height (it changes with a selection) and the scroller's, never the keyboard's rise itself.
  useEffect(() => {
    const view = viewRef.current;
    const bar = barRef.current;
    if (!view) return;
    const apply = () => {
      const px = barUp && bar ? barClearancePx(view, bar.getBoundingClientRect().top, visibleViewportBottom()) : 0;
      if (view.state.field(barClearance, false) !== px) view.dispatch({ effects: setBarClearance.of(px) });
    };
    apply();
    return barUp ? observeSize([bar, scrollerOf(view)], apply) : undefined;
  }, [viewRef, barRef, barUp, shortenColumn]);

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

  // The keyboard has finished opening (once per opening, the size still for KEYBOARD_SETTLE_MS): grow the room if it must,
  // then ask "nearest" once. Keyed on the size, so growth after the first resize restarts the wait (Tab S9, 2026-11-20).
  useEffect(() => {
    if (!writing || !barUp || !keyboard.open) return;
    const view = viewRef.current;
    if (!view) return;
    let quiet = 0;
    let frame = 0;
    let stop = () => {};
    const settled = () => {
      // Once per opening: later changes of the scroller's height (a picture finishing, a hand scroll's rubber band) are not the
      // keyboard and must not pull the page back to the caret. A keyboard that GROWS re-runs this effect (`keyboard.size`).
      stop();
      const cover = Math.round(insetRef.current + (barRef.current?.getBoundingClientRect().height ?? 0) + BAR_GAP_PX);
      if (insetRef.current > 0) roomApply.current(Math.max(room.current, cover));
      whenNotComposing(view, () => {
        if (view.hasFocus) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "nearest" }) });
      });
    };
    const tick = () => { frame = ++quiet >= QUIET_FRAMES ? 0 : requestAnimationFrame(tick); if (!frame) settled(); };
    const restart = () => { quiet = 0; if (!frame) frame = requestAnimationFrame(tick); };
    restart();
    stop = observeSize(scrollerOf(view), restart);
    return () => { cancelAnimationFrame(frame); stop(); };
  }, [viewRef, barRef, writing, barUp, keyboard.open, keyboard.size]);

  // Short typing layout: the shell's top bar and tab strip step aside while the visible height is small (lib/editorKeyboard).
  // Decided once per keyboard size, not per frame; leaving (keyboard closed, focus left, unmount) puts them back.
  const short = writing && barUp && keyboard.open && visibleViewportBottom() < SHORT_VISIBLE_PX;
  useEffect(() => {
    if (!short) return;
    const view = viewRef.current;
    const set = (on: boolean) => setRootAttribute(TYPING_SHORT_ATTR, on ? "" : null);
    if (view) keepCaretLineStill(view, () => set(true)); else set(true);
    return () => { if (view?.dom.isConnected) keepCaretLineStill(view, () => set(false)); else set(false); };
  }, [viewRef, short]);

  // A keyboard that closes under a focused editor, without a blur, strands the bar: report it. "Was open" belongs to the
  // writing session it was seen in: a keyboard that closed while nobody was writing must not make the NEXT tap, with the keyboard
  // still on its way up, count as a close (it left the editor 350 ms after the tap).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!writing) { wasOpen.current = false; return; }
    if (keyboard.open) { wasOpen.current = true; return; }
    if (!wasOpen.current) return;
    const timer = setTimeout(() => { wasOpen.current = false; closedRef.current(); }, KEYBOARD_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [keyboard.open, writing]);

  return { barInset: `${keyboard.inset}px` };
}
