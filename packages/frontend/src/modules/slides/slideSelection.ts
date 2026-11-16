// Which slide each note's 「簡報」 tab was on, for this open page only (memory, not the server, not the note, not sync):
// a note's view tabs draw one at a time, so leaving the tab and coming back must not restart at page 1. It is the
// page's key that is remembered, so a page added or removed before it does not move the choice to another slide.

type Remembered = { key: string; index: number };
const chosen = new Map<string, Remembered>();

export function rememberSlide(noteId: string, key: string, index: number): void {
  chosen.set(noteId, { key, index });
}

/** The page to show: the remembered one by key; if it is gone, the place it had (the last page if that is past the end). */
export function slideIndexFor(noteId: string, pages: ReadonlyArray<{ key: string }>): number {
  const was = chosen.get(noteId);
  if (!was) return 0;
  const found = pages.findIndex((p) => p.key === was.key);
  return found >= 0 ? found : Math.min(was.index, pages.length - 1);
}
