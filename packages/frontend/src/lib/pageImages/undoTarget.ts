// Which of a page's three stacks the toolbar's undo / redo (and ⌘Z) goes to.
// Strokes, text boxes and pictures are different edits, each with its own
// stack, so the person's current work decides:
//   - a picture is selected (the Hand tool, after inserting or tapping one) and
//     the pictures have steps: the pictures — "undo" takes back the insertion,
//     move or resize they are looking at;
//   - the Text tool: the text boxes (typing, moving, styling them);
//   - the Hand tool otherwise: the text boxes while they have steps, then the
//     pictures while they have, else the drawing;
//   - every other tool (pen, highlighter, eraser, shape): the drawing.
// One pure function, so the page's toolbar button and its keyboard shortcut ask
// the same question and the rule is read in one place.

export type UndoTarget = "text" | "images" | "drawing";

type Stack = { canUndo: boolean; canRedo: boolean } | null;

export function undoTarget(state: {
  tool: string;
  /** The text boxes' stack; null when the page has no text layer. */
  text: Stack;
  /** The pictures' stack; null when the page has no picture layer. */
  images: Stack;
  /** A picture is selected. */
  imageSelected: boolean;
}): UndoTarget {
  const has = (stack: Stack) => stack !== null && (stack.canUndo || stack.canRedo);
  if (state.imageSelected && has(state.images)) return "images";
  if (state.tool === "text" && state.text !== null) return "text";
  if (state.tool === "hand") {
    if (has(state.text)) return "text";
    if (has(state.images)) return "images";
  }
  return "drawing";
}
