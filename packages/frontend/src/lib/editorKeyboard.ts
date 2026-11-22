import { Compartment, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
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
// Short typing layout: while writing with the keyboard up and what is left to see below SHORT_VISIBLE_PX, the shell's top bar
// and the page's tab strip step aside (`html[data-typing-short]`, global.css, set by hooks/useEditorKeyboard from the same keyboard
// state: no second detector) so the text gets their height; the caret's line does not move when they go or come back.
//
// This file is the editor side (extension, margins, room slot); hooks/useEditorKeyboard is the React side that
// feeds it (lib/ may not import hooks/). Both together are the owner:
//   extensions: [..., editorKeyboard()];
//   const kb = useEditorKeyboard({ viewRef, barRef, barUp, writing, onKeyboardClosed });   <div ref={barRef} style={{ "--kb-inset": kb.barInset }} />

export const BAR_GAP_PX = 8;
/** Below this visible height (CSS px) the shell steps aside while writing: the Tab S9 with its keyboard up shows 364 px
 *  (of which the top bar, the tab strip and the bar took 3/4 of the text), a phone in portrait with it up about 540. */
export const SHORT_VISIBLE_PX = 520;
export const TYPING_SHORT_ATTR = "data-typing-short";
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
    // After the others: a tap that a handler of its own claims (a link follows, a widget acts) is not placed here as well.
    Prec.low(editorTouch()),
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

/** Runs `change` (it resizes the page around the editor: a bar leaves, a bar comes back) and scrolls whatever scrolls the editor
 *  by the difference, so the caret's line stays where it was on the screen. Nothing happens if the line is not drawn or did not move. */
export function keepCaretLineStill(view: EditorView, change: () => void): void {
  const head = view.state.selection.main.head;
  const before = view.coordsAtPos(head)?.top;
  change();
  const after = before === undefined ? undefined : view.coordsAtPos(head)?.top;
  if (before === undefined || after === undefined || Math.abs(after - before) < 1) return;
  scrollerOf(view).scrollBy(0, after - before);
}

/** What scrolls the editor: its nearest scrolling ancestor (the note column on a wide screen), else the page itself (a phone). */
export function scrollerOf(view: EditorView): Element {
  let scroller: Element | null = view.dom.parentElement;
  while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
  return scroller ?? document.scrollingElement ?? document.documentElement;
}

/** The margin the caret keeps from the foot of what scrolls the editor: what of that foot the bar covers, plus the gap. The page's
 *  foot is `pageBottom` (what the person can see: above the keyboard). Where the scroller already ends at the bar (a wide screen under
 *  resizes-content: global.css shortens the note column by the bar's height) nothing is covered and only the gap is left, so the
 *  browser's own caret scrolling and CodeMirror's agree. */
export function barClearancePx(view: EditorView, barTop: number, pageBottom: number): number {
  const scroller = scrollerOf(view);
  const isPage = scroller === document.scrollingElement || scroller === document.documentElement;
  // Never below what can be seen: a scroller taller than the screen (or a page-sized box that merely scrolls by a pixel) does not
  // turn the whole of its length into margin.
  const bottom = isPage ? pageBottom : Math.min(pageBottom, scroller.getBoundingClientRect().bottom);
  return Math.max(0, Math.round(bottom - barTop)) + BAR_GAP_PX;
}

/** Runs `run` now, or when the IME composition that is going on ends (decorations stay still meanwhile). */
export function whenNotComposing(view: EditorView, run: () => void): () => void {
  if (!view.composing) { run(); return () => {}; }
  const done = () => { view.contentDOM.removeEventListener("compositionend", done); setTimeout(run, 0); };
  view.contentDOM.addEventListener("compositionend", done);
  return () => view.contentDOM.removeEventListener("compositionend", done);
}

