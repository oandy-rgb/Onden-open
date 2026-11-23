import { EditorView, ViewPlugin } from "@codemirror/view";
// One definition of a tap for finger input (how long, how far it may move), shared with the handwriting engine.
import { TAP_MAX_MS, TAP_SLOP_PX } from "./ink";

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
// A single tap ON text is placed the same way (owner 2026-11-20, Tab S9: the browser's own caret scrolling on a tap
// ignored the bar over the editor and left the caret behind it): CodeMirror maps the point, dispatches ONE selection and
// scrolls it into view once with the editor's own margins; the browser does not scroll.
//
// The blank BELOW the editor box (the empty rest of the note column down to the keyboard bar) is not the editor's DOM at all: a tap there
// reaches `.cm-editor` or a container, never the content element, so no CodeMirror handler sees it. `blankTapTracker` below watches
// press and release on the window: a press that did not move and was not cancelled (a scroll cancels the pointer) and is released
// in that blank puts the caret at the end of the note and focuses it, the same as a tap just under the last line. This was the
// job of the empty block after the text (the end room) until #1931 removed it on Android; the tap is the room's, not the layout's.
//
// Left native, on purpose: a long press (selection handles, the magnifier, S Pen handwriting: no mousedown follows it),
// a double or triple tap (word and line selection), anything while an IME composes, and widgets or links that handle
// their own taps (INTERACTIVE below).

/** A compatibility mousedown follows a finger tap this soon after its pointerup. */
const TAP_TO_MOUSEDOWN_MS = 800;

const INTERACTIVE = 'a, button, input, textarea, select, label, [contenteditable="false"], .cm-md-link';

/** A tap the editor places: the editor's own content, scroller or room, or text of a line that is not a link, control or widget. */
const isPlacedByEditor = (view: EditorView, target: EventTarget | null): boolean =>
  target === view.contentDOM || target === view.scrollDOM || target === view.dom
  || (target instanceof Element && (target.classList.contains("cm-end-room")
    || (view.contentDOM.contains(target) && onPlainText(target))));

/** Whether `target` lies in a line with nothing interactive between it and the line (the line's own ancestors do not count). */
function onPlainText(target: Element): boolean {
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (el.matches(INTERACTIVE)) return false;
    if (el.classList.contains("cm-line")) return true;
  }
  return false;
}

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
  if (event.detail > 1 || msSinceTouchUp > TAP_TO_MOUSEDOWN_MS || !isPlacedByEditor(view, event.target)) return false;
  event.preventDefault();
  const head = caretPosForTap(view, event.clientX, event.clientY);
  if (!view.hasFocus) view.focus();
  view.dispatch({ selection: { anchor: head }, scrollIntoView: true, userEvent: "select.pointer" });
  return true;
}

export function editorTouch() {
  let lastTouchUp = -Infinity;
  return [
    EditorView.domEventHandlers({
      pointerup(event) {
        if (event.pointerType !== "mouse") lastTouchUp = event.timeStamp;
        return false;
      },
      mousedown: (event, view) => placeCaretForTap(view, event, event.timeStamp - lastTouchUp),
    }),
    blankTapTracker(),
  ];
}

/** Whether a tap at viewport point (x, y) on `target` is in the blank below this editor's last line: `target` is the editor box or
 *  a container around it (never something inside another block, a link or a control), the point is under the last line and inside the
 *  editor's width, and no other editor sits in that container below it in the same column. */
function isBlankBelowLastLine(view: EditorView, target: EventTarget | null, x: number, y: number): boolean {
  if (!(target instanceof Element) || !view.dom.isConnected) return false;
  if (!view.state.facet(EditorView.editable) || view.state.readOnly) return false;
  if (target !== view.dom && !target.contains(view.dom)) return false;
  if (target.matches(INTERACTIVE)) return false;
  const box = view.dom.getBoundingClientRect();
  if (x < box.left || x > box.right) return false;
  if (y <= view.documentTop + view.lineBlockAt(view.state.doc.length).bottom) return false;
  // Another editor in the same column (below this one, overlapping its width) owns the blank around it; editors in other panes do not matter.
  return ![...target.querySelectorAll(".cm-editor")].some((other) => {
    const r = other.getBoundingClientRect();
    return other !== view.dom && !view.dom.contains(other) && r.top >= box.top && r.left < box.right && r.right > box.left;
  });
}

/** Press-and-release tracking for `isBlankBelowLastLine`: a tap is a release near its press, soon after it, with no cancel between. */
function blankTapTracker() {
  return ViewPlugin.fromClass(class {
    private press: { id: number; x: number; y: number; at: number } | null = null;
    private readonly down = (e: PointerEvent) => {
      this.press = e.isPrimary && e.button === 0 ? { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp } : null;
    };
    private readonly move = (e: PointerEvent) => {
      if (this.press && e.pointerId === this.press.id && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > TAP_SLOP_PX) this.press = null;
    };
    private readonly cancel = () => { this.press = null; };
    // The release only qualifies the tap; the caret is placed on the click that follows it, because the compatibility mouse events
    // after a touch release move focus to the tapped element, and focus set any earlier would be taken away again.
    private qualified = false;
    private clearTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly up = (e: PointerEvent) => {
      const press = this.press;
      this.press = null;
      this.qualified = false;
      if (!press || e.pointerId !== press.id || e.timeStamp - press.at > TAP_MAX_MS) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP_PX) return;
      if (this.view.composing || !isBlankBelowLastLine(this.view, e.target, e.clientX, e.clientY)) return;
      this.qualified = true;
      clearTimeout(this.clearTimer);
      this.clearTimer = setTimeout(() => { this.qualified = false; }, TAP_TO_MOUSEDOWN_MS);
    };
    private readonly click = () => {
      if (!this.qualified) return;
      this.qualified = false;
      if (!this.view.hasFocus) this.view.focus();
      this.view.dispatch({ selection: { anchor: this.view.state.doc.length }, scrollIntoView: true, userEvent: "select.pointer" });
    };
    constructor(private readonly view: EditorView) {
      window.addEventListener("pointerdown", this.down, true);
      window.addEventListener("pointermove", this.move, true);
      window.addEventListener("pointercancel", this.cancel, true);
      window.addEventListener("pointerup", this.up, true);
      window.addEventListener("click", this.click, true);
    }
    destroy() {
      window.removeEventListener("pointerdown", this.down, true);
      window.removeEventListener("pointermove", this.move, true);
      window.removeEventListener("pointercancel", this.cancel, true);
      window.removeEventListener("pointerup", this.up, true);
      window.removeEventListener("click", this.click, true);
      clearTimeout(this.clearTimer);
    }
  });
}
