// Shared state of 「在本篇找字」 that must stay free of CodeMirror, so eager code
// (the command palette, global shortcuts) can use it without pulling the editor.

/** Window event the editor listens for; the ⋯ menu and the global Cmd+F
 *  dispatch it so every entry opens the same panel. */
export const FIND_IN_NOTE_EVENT = "onden-find-in-note";


// What Ctrl+F pre-fills: the last thing searched for in a note, or the words
// the person used in Ctrl+K when they opened this note from the results.
let lastFindText = "";
export function rememberFindText(text: string): void { if (text.trim()) lastFindText = text; }
export function lastFindQuery(): string { return lastFindText; }

// Words from the search that opened a note. One-shot per note: consumed by the
// editor once that note's text is on screen.
const pendingFromSearch = new Map<string, string>();
export function setPendingFind(nodeId: string, query: string): void {
  const text = query.trim();
  if (!text) { pendingFromSearch.delete(nodeId); return; }
  pendingFromSearch.set(nodeId, text);
  rememberFindText(text);
}
export function takePendingFind(nodeId: string): string | null {
  const text = pendingFromSearch.get(nodeId) ?? null;
  pendingFromSearch.delete(nodeId);
  return text;
}
