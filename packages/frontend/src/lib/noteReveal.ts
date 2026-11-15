// Opening a note at one of its lines: the Tasks page's 「打開筆記」 names the
// task's line (its anchor id), and the note's editor scrolls to it once the note is
// on screen. A request waits here for the note it names; nothing else reads it.

type Reveal = { noteId: string; ref: string; at: number };
/** A request not met within this long was not for this opening: it lapses. */
const LAPSE_MS = 10_000;
let pending: Reveal | null = null;
const watchers = new Set<() => void>();

/** Ask the next opening of `noteId` to scroll to the line of the paragraph with anchor id `ref`. */
export function revealBlockInNote(noteId: string, ref: string): void {
  pending = { noteId, ref, at: Date.now() };
  for (const watcher of [...watchers]) watcher();
}

/** Called when a request is made, so a note that is already open can act on it now. Returns the unsubscribe. */
export function watchReveal(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => { watchers.delete(watcher); };
}

/** The anchor id waiting for `noteId`, or null. */
export function pendingReveal(noteId: string): string | null {
  return pending?.noteId === noteId && Date.now() - pending.at < LAPSE_MS ? pending.ref : null;
}

/** The request is done (or can no longer be done): forget it. */
export function clearReveal(): void {
  pending = null;
}

/** The 0-based line of `markdown` where the paragraph with anchor id `ref` starts (`anchors`: the note's, read against
 *  `markdown`: blockAnchorStore anchorSpansOf), or -1. */
export function lineOfBlock(markdown: string, ref: string, anchors: readonly { id: string; from: number }[]): number {
  const anchor = anchors.find((a) => a.id === ref);
  if (!anchor || anchor.from > markdown.length) return -1;
  let line = 0;
  for (let at = markdown.indexOf("\n"); at !== -1 && at < anchor.from; at = markdown.indexOf("\n", at + 1)) line++;
  return line;
}
