import { useCallback, useEffect, useRef, useState } from "react";
import { useDismiss } from "./useEscapeKey";

/** Set on <body> while the board is full screen: components/CanvasMode.css hides
 *  the app's top bar and the note's tab row. */
export const BOARD_FULLSCREEN_CLASS = "onden-board-fullscreen";
/** Also on <body> while a phone's board is full screen for good: the app's bottom bar steps aside and the
 *  page itself is fixed (components/CanvasMode.css), so nothing but the board can move. */
export const BOARD_LOCKED_CLASS = "onden-board-locked";

type Options = {
  /** The board's own tool is the plain 選取: Esc first puts the tool back to it, only the next Esc leaves. */
  toolIsSelect: boolean;
  /** The board is on screen. A phone's Info screen or the note list hides it, and with the bars hidden too
   *  the person would have no way back, so full screen ends there. */
  onScreen: boolean;
  /** A phone: the board is always full screen while it is on screen (no button, no Esc), and the person
   *  leaves through the board's own ‹ and title sheet. Only the caller that supplies those may set it. */
  always?: boolean;
};

/**
 * The whiteboard's full-screen state: only the board stays on screen, the
 * app's top bar and the note's tabs are hidden. Not stored: a reload or
 * leaving the board brings the bars back. Esc leaves it — unless that Esc was
 * already spoken for (closing a popover or dialog, ending text input, leaving
 * a PDF's or the board's tool), which is what PdfNodeView's Esc also checks.
 */
export function useBoardFullscreen({ toolIsSelect, onScreen, always = false }: Options) {
  const [chosen, setFullscreen] = useState(false);
  const locked = always && onScreen;
  const fullscreen = locked || chosen;
  // The key handler reads the tool as of the key press, not as of the last render of the effect.
  const toolIsSelectRef = useRef(toolIsSelect);
  toolIsSelectRef.current = toolIsSelect;
  useEffect(() => {
    if (!fullscreen) return;
    document.body.classList.add(BOARD_FULLSCREEN_CLASS);
    if (locked) document.body.classList.add(BOARD_LOCKED_CLASS);
    return () => { document.body.classList.remove(BOARD_FULLSCREEN_CLASS, BOARD_LOCKED_CLASS); };
  }, [fullscreen, locked]);
  useDismiss((via) => {
    // Esc is spoken for by a tool or a text field; Back is not (the tool's own entry is newer and has taken it).
    const target = via !== "back" && via.target instanceof HTMLElement ? via.target : null; // window / document when nothing has focus
    if (via !== "back" && (!toolIsSelectRef.current || (target && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")))) return false;
    setFullscreen(false);
  }, fullscreen && !locked);
  useEffect(() => { if (!onScreen) setFullscreen(false); }, [onScreen]);
  const toggle = useCallback(() => setFullscreen((on) => !on), []);
  return { fullscreen, locked, toggle };
}
