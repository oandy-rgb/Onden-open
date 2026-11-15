import type { EditorView } from "@codemirror/view";
import { isCoarsePointer } from "./mediaQuery";
import type { PopoverPoint } from "./popoverPoint";

/** Room the OS keeps for its selection drag handles under a touch selection. */
const TOUCH_HANDLE_CLEARANCE_PX = 36;

/**
 * Where the floating formatting bubble for the selection `from..to` goes (a
 * `usePopover` `at`), or null when it is off screen. With a mouse it sits above
 * the selection start. On a touch screen Android and iOS put their own
 * cut/copy/paste menu exactly there, so the bubble goes below the selection
 * end, past the drag handles. Keeping it inside the window and above the
 * on-screen keyboard is the popover's job.
 */
export function selectionBubblePosition(view: EditorView, from: number, to: number): PopoverPoint | null {
  const touch = isCoarsePointer();
  const start = view.coordsAtPos(from);
  if (!start) return null;
  if (!touch) return { x: start.left, y: start.top, above: true };
  const end = view.coordsAtPos(to) ?? start;
  // Near the bottom (or above the keyboard) the popover pushes it up over the
  // selection's last line, but never onto the OS menu above it.
  return { x: start.left, y: end.bottom + TOUCH_HANDLE_CLEARANCE_PX };
}
