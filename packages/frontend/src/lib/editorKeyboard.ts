import { Compartment, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { endRoomMargin } from "./editorEndRoom";
import { editorTouch } from "./editorTouch";

// The one owner of "while writing on a touch screen, focus, caret and scrolling belong to the editor":
//   scrolling: the caret stays above the on-screen keyboard and the bar (this file, below);
//   focus: nothing floating beside the editor takes it on a press (components/ui keepFocus, usePopover's `keepFocus`
//          surfaces; hand-written preventDefault elsewhere is the `fe-focus-steal-guard` rule);
//   caret: a tap that is not on text is placed once by CodeMirror, not by the browser (lib/editorTouch, installed below).
// One owner file set, not three owners: the three are the same session of writing, installed once with editorKeyboard().
//
// Android (Chrome, Brave, Edge, Firefox) gets `interactive-widget=resizes-content` from appShell/head.ts: the keyboard
// shrinks the layout like a native app's, a `bottom: 0` bar sits on it, and useVirtualKeyboard's inset is 0.
// Browsers without it (iOS Safari) only shrink the visual viewport; there the inset is used for ONE thing, to
// place the bar (`--kb-inset`). Nothing in the editor scrolls because the visual viewport moved.
//
// The caret rule, the only one: the caret is brought into view by transactions the person caused (typing, moving
// the caret, toolbar and menu commands, paste, IME commit), by CodeMirror's own scrollIntoView, with the margins
// below. A viewport resize, a keyboard inset change or a visual-viewport pan never scrolls: the browser pans
// that viewport itself while a hand scroll is going on, and a scroll answering it feeds back (measured on a real
// phone, 2026-11-09: offsetTop bounced every frame while scrollY stood still). The one extra scroll is
// "nearest" once when the keyboard has finished opening, which moves nothing if the caret is already in view.
// Nothing here changes text or decorations while an IME is composing.
//
// This file is the editor side (extension, margins, room slot); hooks/useEditorKeyboard is the React side that
// feeds it (lib/ may not import hooks/). Both together are the owner:
//   extensions: [..., editorKeyboard()];
//   const kb = useEditorKeyboard({ viewRef, barRef, barUp, writing, onKeyboardClosed });   <div ref={barRef} style={{ "--kb-inset": kb.barInset }} />

export const BAR_GAP_PX = 8;
const ROOM_MIN_PX = 64;
const ROOM_MAX_PX = 220;

export const setBarClearance = StateEffect.define<number>();
export const barClearance = StateField.define<number>({
  create: () => 0,
  update(px, tr) { for (const e of tr.effects) if (e.is(setBarClearance)) return e.value; return px; },
});
export const roomSlot = new Compartment();

/** The editor's scroll margins and the slot for the room under the last line. Install once. */
export function editorKeyboard(): Extension {
  return [
    barClearance,
    roomSlot.of([]),
    editorTouch(),
    EditorView.scrollMargins.of((view) => {
      const bottom = Math.max(view.state.field(barClearance), endRoomMargin(view));
      return bottom > 0 ? { bottom } : null;
    }),
  ];
}

/** Typewriter scroll (zen): keeps the caret's line near the vertical centre, as a large symmetric margin plus a nudge
 *  after each edit or caret move. Empty while zen is off, so normal editing keeps the browser's own scroll. */
export const typewriterScroll: Extension = [
  EditorView.scrollMargins.of((view) => {
    const m = Math.max(0, Math.round(view.scrollDOM.clientHeight * 0.4));
    return { top: m, bottom: m };
  }),
  EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.selectionSet) return;
    update.view.dispatch({ effects: EditorView.scrollIntoView(update.state.selection.main.head, { y: "center" }) });
  }),
];

/** The room under the last line while writing: a third of what can be seen, 64–220 px. */
export function baseRoomPx(visibleBottom: number): number {
  return Math.min(ROOM_MAX_PX, Math.max(ROOM_MIN_PX, Math.round(visibleBottom * 0.3)));
}

/** Runs `run` now, or when the IME composition that is going on ends (decorations stay still meanwhile). */
export function whenNotComposing(view: EditorView, run: () => void): () => void {
  if (!view.composing) { run(); return () => {}; }
  const done = () => { view.contentDOM.removeEventListener("compositionend", done); setTimeout(run, 0); };
  view.contentDOM.addEventListener("compositionend", done);
  return () => view.contentDOM.removeEventListener("compositionend", done);
}

