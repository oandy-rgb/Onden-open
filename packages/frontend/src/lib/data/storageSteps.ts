// A storage step whose failure the code after it must not ignore: a durable write (the local copy, the queue, the
// user's folder) that something later relies on. The one rule for the whole class (docs/agents/mistakes.md
// 「儲存失敗被吞掉」): such a step runs through `storageStep`, and when it fails the step is *owed* until the same
// step succeeds, or the caller settles it by another route that restores what it protected. A failure is never
// "nothing happened". What "owed" means is the caller's invariant, stated where it reads `storageStepOwed`:
//
//   "folderCopy"     the copy in the person's folder is not current. Settings says so in plain words and never says it
//                    is saved there (settings/registry.tsx). The next successful folder write clears it.
//   "copyCursor"     the local copy's sync cursor may be past what the screen holds (a refused answer's rewind failed,
//                    writePositions.takeAnswer). The next sync pass reads the whole state instead (syncEngine.sync).
//   refused(<key>)   the server refused this write and its queued row could not be taken out of the queue
//                    (writeQueue.sendRecorded). The row is never sent again from this page; the drain retries the clear.
//
// Owed steps are page memory. After a reload the local copy is read again from its own storage (it holds the rows a
// failed rewind would have re-sent; the queue holds a refused row only if neither the clear nor recovery's mark was
// stored), and the folder is written again on the next save.
//
// Not for steps whose failure is already reported (they reject to a caller that tells the person) or harmless by
// construction (a sent row whose removal failed: its idempotency key makes the resend an echo).

import { useSyncExternalStore } from "react";

type StorageStep = "folderCopy" | "copyCursor" | `refused:${string}`;

/** The step that takes a refused write (by its idempotency key) out of the queue. */
export function refusedWriteStep(idemKey: string): StorageStep {
  return `refused:${idemKey}`;
}

/** A refused write whose row is still in the queue: not work waiting (the counter, the drain), never sent again. */
export function refusedWriteOwed(idemKey: string | null | undefined): boolean {
  return !!idemKey && owed.has(refusedWriteStep(idemKey));
}

const owed = new Set<StorageStep>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Run `run`. True when it held (an owed step of the same name is settled); false when it failed: the step is owed
 *  from then on. Never throws: the caller's invariant for an owed step is the answer to the failure. */
export async function storageStep(step: StorageStep, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
  } catch (cause) {
    storageStepFailed(step, cause);
    return false;
  }
  settleStorageStep(step);
  return true;
}

/** The step could not even be tried (the folder is gone, its permission was taken back): owed, as if it failed. */
export function storageStepFailed(step: StorageStep, cause: unknown): void {
  // The cause is for the console only: the person is told in plain words where the step's owner says so.
  console.warn(`[onden] a storage step failed (${step.startsWith("refused:") ? "refused write" : step})`, cause);
  if (owed.has(step)) return;
  owed.add(step);
  emit();
}

export function storageStepOwed(step: StorageStep): boolean {
  return owed.has(step);
}

/** What the owed step protected holds again by another route (a whole read replaced the screen and the cursor). */
export function settleStorageStep(step: StorageStep): void {
  if (owed.delete(step)) emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useStorageStepOwed(step: StorageStep): boolean {
  return useSyncExternalStore(subscribe, () => owed.has(step), () => false);
}
