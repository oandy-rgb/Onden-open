// Is there a local (offline) copy on this device right now? Kept apart from
// localDb.ts, which owns the worker: the state is read by the sync engine and
// the notices, and changes when the worker is replaced or cannot be opened.
//
// "ok"         the worker answers.
// "restarting" it died or hung (or errored): it was terminated, and the next
//              call starts a new one, which replays the snapshot and journal.
// "none"       the copy could not be opened at all (IndexedDB blocked, snapshot
//              unreadable): this page runs from server data only, and says so.
export type LocalCopyState = "ok" | "restarting" | "none";

let state: LocalCopyState = "ok";
const listeners = new Set<(next: LocalCopyState) => void>();

export function getLocalCopyState(): LocalCopyState { return state; }

export function subscribeLocalCopy(listener: (next: LocalCopyState) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setLocalCopy(next: LocalCopyState): void {
  if (state === next) return;
  state = next;
  for (const listener of [...listeners]) listener(next);
}

/** Tests: back to "ok", no listeners. */
export function _resetLocalCopyForTests(): void {
  state = "ok";
  listeners.clear();
}
