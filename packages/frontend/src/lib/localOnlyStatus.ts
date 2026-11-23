// When a build keeps the notes only on this device (the browser trial, src/browserApp): what the save line
// says instead of 「已連線」 and what pressing it opens. The shell that owns that storage sets it; SyncStatus,
// useSyncTrouble and the account status read it, so they never import trial code. Tiny external store, like
// localCopyStatus.

import { useSyncExternalStore } from "react";

export type LocalOnlyStatus = {
  /** The calm line: where the notes are and that they are saved. */
  label: string;
  /** Something the person should act on (not saved, no storage, a backup due), or null. */
  trouble: string | null;
  open: () => void;
  /** Open the screen that takes a file from another device into this one (browserApp/BringEntry); only the trial version has it. */
  bringNotes?: () => void;
  /** This copy has one local person and no password (the browser version): confirming a file of all the notes is a timed press, not a password. */
  signsInWithoutPassword?: boolean;
};

/** This page keeps the notes only on this device for its whole life. Unlike the status line (set once the shell's
 *  notice has loaded), this is declared before the app mounts, so the sync engine's first pass already knows it;
 *  lib/hostCapabilities.ts reads it. Never undone: another kind of page is another page load. */
let localOnlyHost = false;

/** The shell that owns the on-device storage (browserApp/BrowserAppShell.tsx), before it mounts the app.
 *  `false` only for tests going back to a page with a server. */
export function declareLocalOnlyHost(localOnly = true): void {
  localOnlyHost = localOnly;
}

export function isLocalOnlyHost(): boolean {
  return localOnlyHost;
}

let status: LocalOnlyStatus | null = null;
const listeners = new Set<() => void>();

export function setLocalOnlyStatus(next: LocalOnlyStatus | null): void {
  status = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLocalOnlyStatus(): LocalOnlyStatus | null {
  return useSyncExternalStore(subscribe, () => status, () => null);
}
