import { getPrefJson, PREFS, setPrefJson, removePref } from "./prefs";
import type { FoldMark } from "./editorFold";

// Which headings each note has folded, kept on this device only (a view habit,
// not note content: nothing is synced or written into the note). A mark that no
// longer matches a heading is simply ignored when the note opens (editorFold).

/** Notes remembered; the least recently folded ones go first. */
export const REMEMBERED_NOTES = 200;
const MAX_MARKS_PER_NOTE = 300;

type FoldBook = Record<string, FoldMark[]>;

// A list of marks, not text (the text-cut guard is about people's words).
const firstMarks = (marks: readonly FoldMark[]) => marks.filter((_, i) => i < MAX_MARKS_PER_NOTE);

function readBook(): FoldBook {
  const raw = getPrefJson(PREFS.editorFolds);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const book: FoldBook = {};
  for (const [noteKey, marks] of Object.entries(raw)) {
    if (!Array.isArray(marks)) continue;
    const clean = marks.filter((m): m is FoldMark => !!m && typeof m.text === "string" && Number.isInteger(m.nth) && m.nth >= 0);
    if (clean.length) book[noteKey] = firstMarks(clean);
  }
  return book;
}

export function loadFoldMarks(noteKey: string | undefined): FoldMark[] {
  return noteKey ? readBook()[noteKey] ?? [] : [];
}

export function saveFoldMarks(noteKey: string | undefined, marks: readonly FoldMark[]): void {
  if (!noteKey) return;
  const book = readBook();
  delete book[noteKey]; // re-added last: the most recent
  if (marks.length) book[noteKey] = firstMarks(marks);
  const keys = Object.keys(book);
  for (const old of keys.filter((_, i) => i < keys.length - REMEMBERED_NOTES)) delete book[old];
  if (Object.keys(book).length) setPrefJson(PREFS.editorFolds, book);
  else removePref(PREFS.editorFolds);
}
