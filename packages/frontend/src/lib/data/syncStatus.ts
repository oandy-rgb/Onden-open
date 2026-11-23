// Reactive pending-writes counter — the missing half of the sync story
// (P0-4): the topbar dot said online/offline but never WHAT is waiting.
// Single source of truth for "N edits not yet on the server": queueWrite
// bumps it, the reconnect drain settles it, boot seeds it from the local DB.
// Tiny external store (same pattern as lib/i18n) — no framework.

import { useSyncExternalStore } from "react";
import { getOldestPendingWriteAt, getPendingWrites, type PendingWrite } from "../localDb";
import { targetIds } from "../pendingWriteTargets";
import { isSendingHere } from "./sendingHere";
import { refusedWriteOwed } from "./storageSteps";

/** After this many failed sends the head of the queue counts as stuck. */
export const STUCK_AFTER_ATTEMPTS = 8;

/** Why the last attempt to send queued changes failed. The one list of reasons:
 *  the screens only turn it into a sentence (components/SyncStatus). */
export type SendFailureReason = "server" | "connection" | "signin" | "unknown";

/** The queue's head keeps failing, so everything behind it waits too:
 *  `count` writes wait, the oldest since `oldestAt` (epoch ms); `noteId` is the
 *  note the first waiting change belongs to (null when it is not about a note). */
export type StuckWrites = { count: number; oldestAt: number | null; reason: SendFailureReason; noteId: string | null };

/** Sending is failing but not yet "stuck": the queue is still retrying. */
export type SendRetry = { reason: SendFailureReason; attempts: number };

/** The queue as "waiting to sync": every pending row but those this page is sending itself (sendingHere.ts): a save on
 *  its way is not "waiting", so the counter, the stuck notice and "sync pending changes first" leave it out. */
export async function waitingWrites(): Promise<PendingWrite[]> {
  return (await getPendingWrites()).filter((write) => !isSendingHere(write.idem_key) && !refusedWriteOwed(write.idem_key));
}

let pendingCount = 0;
let stuck: StuckWrites | null = null;
let stuckReason: SendFailureReason = "unknown";
let retrying: SendRetry | null = null;
let headAttempts = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Why the latest send failed (this page's memory only); null once sending
 *  works again, or the device is offline (that has its own line). */
function noteSendFailure(reason: SendFailureReason | null): void {
  if (reason) stuckReason = reason;
  retrying = reason ? { reason, attempts: headAttempts } : null;
}

async function stuckFrom(writes: PendingWrite[]): Promise<StuckWrites | null> {
  headAttempts = writes[0]?.attempts ?? 0;
  if (retrying && retrying.attempts !== headAttempts) retrying = { ...retrying, attempts: headAttempts };
  if (!writes[0] || writes[0].attempts < STUCK_AFTER_ATTEMPTS) return null;
  // SQLite's datetime('now'): UTC without a zone.
  const queuedAt = await getOldestPendingWriteAt().catch(() => null);
  const oldestAt = queuedAt ? Date.parse(`${queuedAt.replace(" ", "T")}Z`) : NaN;
  return { count: writes.length, oldestAt: Number.isFinite(oldestAt) ? oldestAt : null, reason: stuckReason, noteId: targetIds(writes[0], "node")[0] ?? null };
}

function setStuck(next: StuckWrites | null): void {
  const same = stuck === next || (stuck && next && stuck.count === next.count && stuck.oldestAt === next.oldestAt && stuck.reason === next.reason && stuck.noteId === next.noteId);
  if (same) return;
  stuck = next;
  emit();
}

export function bumpPending(delta: number): void {
  pendingCount = Math.max(0, pendingCount + delta);
  emit();
}

export function setPending(n: number): void {
  pendingCount = Math.max(0, n);
  emit();
}

/** Re-count from the local DB (boot, and after a drain — the drain may stop
 *  mid-list on the first failure, so a recount beats arithmetic). A drain says
 *  how it ended: `sendFailure` is why it could not send, null when it did (or
 *  the device is offline); boot passes nothing and leaves what is known. */
export async function refreshPendingCount(sendFailure?: SendFailureReason | null): Promise<void> {
  if (sendFailure !== undefined) noteSendFailure(sendFailure);
  try {
    const writes = await waitingWrites();
    setPending(writes.length);
    const next = await stuckFrom(writes);
    if (writes.length === 0) retrying = null;
    setStuck(next);
    emit(); // the retry line follows the attempt count
  } catch {
    /* local DB unavailable (SSR/embeds) — leave the counter alone */
  }
}

export function getPendingCount(): number {
  return pendingCount;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingWrites(): number {
  return useSyncExternalStore(subscribe, getPendingCount, () => 0);
}

export function getPendingStuck(): StuckWrites | null {
  return stuck;
}

export function usePendingStuck(): StuckWrites | null {
  return useSyncExternalStore(subscribe, getPendingStuck, () => null);
}

export function usePendingRetry(): SendRetry | null {
  return useSyncExternalStore(subscribe, () => retrying, () => null);
}
