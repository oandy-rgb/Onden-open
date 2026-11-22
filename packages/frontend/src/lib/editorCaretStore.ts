import { useSyncExternalStore } from "react";

// Where the caret of the editor showing a note is, and a way to scroll that editor, for the panes beside it (the
// slides tab follows the caret and scrolls the text to a page: modules/slides). Not data and not saved: it only
// exists while an editor is open on the note. The editor (components/MarkdownEditor) is the one writer.

type EditorCaret = { from: number; head: number };

const carets = new Map<string, EditorCaret>();
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((fn) => fn());

/** The editor on `noteId` has its caret (selection `from`…, caret end `head`) here, or `null`: it closed. */
export function publishCaret(noteId: string, caret: EditorCaret | null): void {
  const held = carets.get(noteId);
  if (caret === null) { if (carets.delete(noteId)) tell(); return; }
  if (held && held.from === caret.from && held.head === caret.head) return;
  carets.set(noteId, caret);
  tell();
}

type EditorControls = {
  /** Scroll so the offset is at the top; the caret and the focus stay where they are. */
  scrollTo: (offset: number) => void;
  /** Put the caret at the offset and focus the editor. */
  focusAt: (offset: number) => void;
  /** Put the caret at the offset without focusing or scrolling (the focus is where it was). */
  placeCaret: (offset: number) => void;
  /** Change the text as one edit the editor's own undo steps back (Ctrl+Z), saved like typing: `change` gets the text now
   *  and returns the new one. A text `change` leaves as it is changes nothing. */
  replaceText: (change: (current: string) => string) => void;
};
const controls = new Map<string, EditorControls>();

/** The editor on `noteId` takes these requests from other panes; `null` when it closes. */
export function registerEditorControls(noteId: string, handed: EditorControls | null): void {
  if (handed) controls.set(noteId, handed); else controls.delete(noteId);
}

/** Scroll the open editor of `noteId` so `offset` is at the top; false when no editor shows the note. */
export function scrollEditorTo(noteId: string, offset: number): boolean {
  const open = controls.get(noteId);
  open?.scrollTo(offset);
  return !!open;
}

/** Put the caret of the open editor of `noteId` at `offset` and focus it; false when no editor shows the note. */
export function focusEditorAt(noteId: string, offset: number): boolean {
  const open = controls.get(noteId);
  open?.focusAt(offset);
  return !!open;
}

/** Put the caret of the open editor of `noteId` at `offset`, leaving focus and scroll alone; false when no editor shows the note. */
export function placeEditorCaret(noteId: string, offset: number): boolean {
  const open = controls.get(noteId);
  open?.placeCaret(offset);
  return !!open;
}

/** Change the text of the open editor of `noteId` as one undoable edit; false when no editor shows the note (use drafts.editText). */
export function replaceEditorText(noteId: string, change: (current: string) => string): boolean {
  const open = controls.get(noteId);
  open?.replaceText(change);
  return !!open;
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
/** Something read from the caret of the editor open on `noteId` (`read` gets null when none is open). `read` should give a
 *  plain value (a number, a boolean): the component draws again only when that changes, not at every caret move. */
export const useEditorCaret = <T extends string | number | boolean | null>(noteId: string, read: (caret: EditorCaret | null) => T): T =>
  useSyncExternalStore(subscribe, () => read(carets.get(noteId) ?? null), () => read(null));

/** The caret of the open editor of `noteId` right now (null when none): for an action, not for drawing. */
export const caretOf = (noteId: string): EditorCaret | null => carets.get(noteId) ?? null;
