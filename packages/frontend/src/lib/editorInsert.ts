// The note editor that is open registers how to insert text at its caret, so
// an action started from a menu or dialog (a citation, a link) lands where the
// writer was, not at the end of the note. One editor at a time; keyed by note.

/** `endIfNoCaret`: the writer never put the caret in the text (it is still at the very start), so the text goes at the end. */
export type InsertOptions = { endIfNoCaret?: boolean };
type Inserter = (text: string, options?: InsertOptions) => void;
let active: { nodeId: string; insert: Inserter } | null = null;

/** Called by the open editor; returns the unregister function. */
export function registerNoteEditor(nodeId: string, insert: Inserter): () => void {
  const entry = { nodeId, insert };
  active = entry;
  return () => { if (active === entry) active = null; };
}

/** Insert at the caret of `nodeId`'s open editor. False when it is not open. */
export function insertIntoNoteEditor(nodeId: string, text: string, options?: InsertOptions): boolean {
  if (!active || active.nodeId !== nodeId) return false;
  active.insert(text, options);
  return true;
}
