import { highlightSelectionMatches } from "@codemirror/search";
import { EditorView, crosshairCursor, drawSelection, rectangularSelection } from "@codemirror/view";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { isCoarsePointer } from "./mediaQuery";

// Two selection helpers for the note editor.
//
// 1. 選一個詞，同篇相同的字淡淡標出. Matching is literal on the selected text
//    (no word boundaries), so a selected Chinese phrase marks its other
//    occurrences too. From 2 characters up; at most SELECTION_MATCH_CAP marks,
//    and only in the part of the note on screen, so a long note stays light.
//    Look: `.cm-selectionMatch` in editorTools.css (not the find panel's marks).
//
// 2. 多欄選取: Alt + drag selects a rectangle (one range per line), for tidying
//    tables. Not on a touch screen, where none of the below is switched on.
//    More than one range needs allowMultipleSelections, and only the main one is
//    drawn by the browser, so desktop also draws the selection itself
//    (drawSelection; the colours are already in MarkdownEditor's theme).
//    Ctrl/Cmd + click keeps following links: it must not add a cursor instead.
//    Some Linux window managers take Alt + drag for moving windows; Ctrl + Alt +
//    drag works there (it still has Alt held) and shows the same crosshair.
//
//    The drawn selection is only for a mouse. A selection made by finger or pen belongs to the OS: it
//    draws the handles and the cut/copy menu around the *browser's* selection, so a second, editor-drawn
//    one (measured at another moment, hiding the browser's) can sit on other text than the handles.
//    A tablet with a pen or keyboard cover answers `(pointer: fine)` while a finger selects, so what
//    made the selection decides: each pointerdown switches the drawing on (mouse) or off (touch, pen).
//
//    extensions: [..., editorSelectionTools()]   (the column tools are decided once, when the editor is made)

export const SELECTION_MATCH_MIN_CHARS = 2;
export const SELECTION_MATCH_CAP = 100;

/** Holds `drawSelection()` while the last pointer on the editor was a mouse, and nothing otherwise. */
const drawnSelection = new Compartment();
const drawnForMouseOnly = EditorView.domEventHandlers({
  pointerdown(event, view) {
    const want = event.pointerType === "mouse";
    const has = drawnSelection.get(view.state) !== undefined && (drawnSelection.get(view.state) as Extension[]).length > 0;
    if (want !== has) view.dispatch({ effects: drawnSelection.reconfigure(want ? [drawSelection()] : []) });
  },
});

export function editorSelectionTools(): Extension {
  return [
    highlightSelectionMatches({ minSelectionLength: SELECTION_MATCH_MIN_CHARS, maxMatches: SELECTION_MATCH_CAP, wholeWords: false }),
    isCoarsePointer() ? [] : [
      EditorState.allowMultipleSelections.of(true),
      EditorView.clickAddsSelectionRange.of(() => false),
      drawnSelection.of([drawSelection()]),
      drawnForMouseOnly,
      rectangularSelection({ eventFilter: (event) => event.altKey && event.button === 0 }),
      crosshairCursor({ key: "Alt" }),
    ],
  ];
}
