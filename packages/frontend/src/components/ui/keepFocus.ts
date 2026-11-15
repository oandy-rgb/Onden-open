// "Pressing this must not take focus from what the person is typing in" — the one place that says how.
//
// A button, row or surface beside a text field or the editor: a press would focus it (a tabIndex=-1 surface too)
// and close the on-screen keyboard. preventDefault on mousedown keeps focus where it is; the click, a finger
// scroll (no mousedown) and the keyboard are untouched. A text field inside stays focusable.
//   <Pressable onMouseDown={keepFocus} onClick={run}>          or, when the press itself picks:
//   <li onMouseDown={(e) => { keepFocus(e); pick(); }}>
// A popover opened beside text (useInlinePopover) does this for its whole surface; rows inside need nothing.
// Hand-written preventDefault in onMouseDown/onPointerDown is the `fe-focus-steal-guard` rule.

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

export function keepFocus(event: { target: EventTarget | null; preventDefault(): void }): void {
  if (!(event.target instanceof Element) || !event.target.closest(EDITABLE)) event.preventDefault();
}
