// Cursor-handoff: when one surface navigates to a node and wants the editor to
// land the caret at a SPECIFIC offset (not the note top / last caret), it writes
// onden.pendingCursor.<nodeId> here. MarkdownEditor's mount-restore reads this
// key FIRST (preferring it over the last-caret stash onden.cursor.<nodeId>),
// scrolls it to center, focuses, and removes it — a one-shot handoff.
//
// This is the wiring that makes "click a backlink/mention → open the source ON
// the referencing line" work (the offsets were already computed in backlinks.ts;
// the restore consumer already existed in MarkdownEditor; only the WRITE side
// was missing across the in-app traversal paths). RestorePreviewModal already
// writes the same key for version-restore; this centralises the format.
// `end` (optional) makes the handoff land a SELECTION of [anchor, end) instead of
// a collapsed caret — so clicking a backlink/mention arrives with the exact
// referencing text highlighted (Notion/Tana "jump-to-and-highlight"), not a bare
// caret you still have to hunt for. The editor restore already reads {anchor,head}
// and scrolls to head, so a range Just Works with no consumer change.
import { hasPendingFind, takePendingFind } from "./findInNote";
import { readSession, removeSession, SESSION_KEYS, writeSession } from "./sessionPrefs";

export function setPendingCursor(nodeId: string, offset: number, end?: number): void {
  if (!nodeId || offset == null || offset < 0) return;
  writeSession(
    SESSION_KEYS.pendingCursor(nodeId),
    JSON.stringify({ anchor: offset, head: end != null && end >= offset ? end : offset }),
  );
}

/** A handoff waits for this note's editor (set, not yet taken): an explicit place to land, which a remembered scroll position never overrides. */
export const hasPendingCursor = (nodeId: string): boolean => readSession(SESSION_KEYS.pendingCursor(nodeId)) !== null;

/** Something is waiting to land in this note's text: a caret (a backlink, a task's line) or words to find (a search result, a
 *  paragraph's citation). One idea, one answer: the page asks this when the note's 「內容」 may not be on screen. */
export const hasPendingTextJump = (nodeId: string): boolean => hasPendingCursor(nodeId) || hasPendingFind(nodeId);

/** The jump will not happen (the person said no, may not add the tab, or went elsewhere): nothing is left for a later visit. */
export function dropPendingTextJump(nodeId: string): void {
  removeSession(SESSION_KEYS.pendingCursor(nodeId));
  takePendingFind(nodeId);
}
