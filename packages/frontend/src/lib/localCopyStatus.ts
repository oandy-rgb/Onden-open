// Whether this device's offline copy could not be saved (the local database
// worker reports it, see localDbWorker noteSaveFailed). Queued changes are
// still safe in the local journal; what is lost is the cached workspace, and
// it is read from the server again. Tiny external store, like data/syncStatus.

import { useSyncExternalStore } from "react";

let unavailable = false;
const listeners = new Set<() => void>();

export function setLocalCopyUnavailable(next: boolean): void {
  if (unavailable === next) return;
  unavailable = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLocalCopyUnavailable(): boolean {
  return useSyncExternalStore(subscribe, () => unavailable, () => false);
}
