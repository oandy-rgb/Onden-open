// The other half of "is sync moving": the browser is online, but the server's
// newer content is not arriving (the delta sync or the refresh keeps failing).
// The send side — changes still waiting on this device — is data/syncStatus.
// Tiny external store, same pattern; the engine sets it, components/SyncStatus reads it.

import { useSyncExternalStore } from "react";

/** The server cannot be reached, or it answered with a refusal or an error. */
export type IncomingProblem = "unreachable" | "refused";

let problem: IncomingProblem | null = null;
const listeners = new Set<() => void>();

/** null: the latest sync brought the server's content in. */
export function setIncomingProblem(next: IncomingProblem | null): void {
  if (problem === next) return;
  problem = next;
  for (const listener of listeners) listener();
}

export function getIncomingProblem(): IncomingProblem | null { return problem; }

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useIncomingProblem(): IncomingProblem | null {
  return useSyncExternalStore(subscribe, getIncomingProblem, () => null);
}
