// "Open this note's history": the one call other screens (the note menu, the
// bottom navigation) make. The note editor host listens, selects the note if it
// is not the open one, and shows the history screen over it.

import { setSelectedId } from "../appStore";

/** `day` (YYYY-MM-DD): open on how the note looked at the end of that day. */
type Request = { noteId: string; versionId?: string; day?: string };
let pending: Request | null = null;
const listeners = new Set<() => void>();

export function openNoteHistory(noteId: string, versionId?: string, day?: string): void {
  pending = { noteId, versionId, day };
  setSelectedId(noteId);
  for (const listener of [...listeners]) listener();
}

export function subscribeNoteHistoryRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The waiting request for this note, taken once. */
export function takeNoteHistoryRequest(noteId: string): Request | null {
  if (pending?.noteId !== noteId) return null;
  const request = pending;
  pending = null;
  return request;
}
