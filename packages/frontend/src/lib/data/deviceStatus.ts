// What the page knows about THIS device, kept in the app store for the notices
// (components/DeviceNotices): whether the offline copy is there, and whether
// the server runs a newer build.

import { setAppState } from "../appStore";
import { subscribeLocalCopy, getLocalCopyState } from "../localCopyState";
import { watchServerBuild } from "../buildVersion";
import { retryLocalSnapshotSave } from "../localDb";

let bound = false;

/** Start mirroring both into the store (idempotent; boot calls it). */
export function bindDeviceStatus(): void {
  if (bound) return;
  bound = true;
  setAppState({ localCopy: getLocalCopyState() });
  subscribeLocalCopy((localCopy) => setAppState({ localCopy }));
  watchServerBuild();
}

/** "Storage is full" notice, Retry: save the offline copy now. Rejects while it
 *  still fails; success clears the notice through the worker's event. */
export function retryLocalCopySave(): Promise<void> { return retryLocalSnapshotSave(); }

/** Tests: forget the binding. */
export function _resetDeviceStatusForTests(): void {
  bound = false;
}
