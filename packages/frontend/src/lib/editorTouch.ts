import { EditorView } from "@codemirror/view";

// Part of the editor's touch owner (lib/editorKeyboard says what the owner owns; this file is its caret rule).
//
// CARET placement belongs to the editor. A finger tap that is not on text (the room under the last line, the
// padding and margins around the lines, the gap beside a block widget) used to be left to the browser, which
// put its native selection on the content element itself, outside any line; CodeMirror then corrected it to a
// line, sometimes once on pointerdown and again on pointerup, so the caret jumped to another line and back
// (measured over adb, 2026-11-09). Here such a tap is mapped by CodeMirror itself, clamped to the nearest line
// (below the last line: its end) and dispatched ONCE as the selection; the native default is prevented, so the
// native caret never lands outside a line.
//
// Left alone, on purpose: a tap on text (Android needs the native path for the IME, long-press selection
// handles and the magnifier), anything while an IME composes, and widgets that handle their own taps (images,
// embeds, checkboxes and links sit inside a line or are their own elements: only taps whose target is the
// editor's own content, scroller or room are claimed).

/** A compatibility mousedown follows a finger tap this soon after its pointerup. */
const TAP_TO_MOUSEDOWN_MS = 800;

const isOutsideLine = (view: EditorView, target: EventTarget | null): boolean =>
  target === view.contentDOM || target === view.scrollDOM || target === view.dom
  || (target instanceof Element && target.classList.contains("cm-end-room"));

/** Where a tap at viewport point (x, y) puts the caret when it is not on text: the nearest line, below the last line its end. */
export function caretPosForTap(view: EditorView, x: number, y: number): number {
  const doc = view.state.doc;
  if (y > view.documentTop + view.lineBlockAt(doc.length).bottom) return doc.length;
  if (y < view.documentTop + view.lineBlockAt(0).top) return 0;
  return view.posAtCoords({ x, y }, false);
}

/** Claims a finger tap's compatibility mousedown when it is not on text: places the caret once and prevents the native default. */
export function placeCaretForTap(view: EditorView, event: MouseEvent, msSinceTouchUp: number): boolean {
  if (view.composing || event.button !== 0) return false;
  if (msSinceTouchUp > TAP_TO_MOUSEDOWN_MS || !isOutsideLine(view, event.target)) return false;
  event.preventDefault();
  const head = caretPosForTap(view, event.clientX, event.clientY);
  if (!view.hasFocus) view.focus();
  view.dispatch({ selection: { anchor: head }, scrollIntoView: true, userEvent: "select.pointer" });
  return true;
}

export function editorTouch() {
  let lastTouchUp = -Infinity;
  return EditorView.domEventHandlers({
    pointerup(event) {
      if (event.pointerType !== "mouse") lastTouchUp = event.timeStamp;
      return false;
    },
    mousedown: (event, view) => placeCaretForTap(view, event, event.timeStamp - lastTouchUp),
  });
}
