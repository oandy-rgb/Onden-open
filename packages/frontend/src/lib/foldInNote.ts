// Window events the command palette sends to the open note's editor, kept free
// of CodeMirror so eager code can use them (same split as lib/findInNote.ts).

/** 「全部收起」: fold every heading's section in the open note. */
export const FOLD_ALL_HEADINGS_EVENT = "onden-fold-all-headings";
/** 「全部展開」: unfold everything in the open note. */
export const UNFOLD_ALL_HEADINGS_EVENT = "onden-unfold-all-headings";
