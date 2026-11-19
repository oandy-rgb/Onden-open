// Where a request's writes landed in the workspace's event order: the id of the last domain_events row they committed.
//
// db.ts insertEvent() is the one funnel every event passes, and it runs under the workspace's event append lock
// (spine/eventLock.ts), which also covers the commit: so for one workspace, id order is commit order, and a sync
// answer read in a snapshot whose MAX(id) is at least this id already contains the write (services/sync/delta.ts).
// The id is noted only AFTER COMMIT (db.ts hands the returned callback to txHooks afterCommit, like the realtime tick):
// a rolled-back write leaves no position. eventPositionHeader.ts puts it on the response; frontend lib/answerPositions.ts reads it.

import { createContextSlot } from "../requestContext.js";

/** `replayed`: a replay of an idempotency key already used answers with the position that key's write committed. */
type PositionCell = { position: bigint | null; replayed: bigint | null };
const slot = createContextSlot<PositionCell>();

/** Run one request's work, collecting the position of what it committed — or, for a replay of a key already used, the
 *  position that key's first write committed. `position` is null when nothing committed an event (a refusal, a no-op, a
 *  replay of a key whose write had none or that predates migration 212). */
export async function collectEventPosition<T>(fn: () => Promise<T>): Promise<{ result: T; position: string | null }> {
  const cell: PositionCell = { position: null, replayed: null };
  const result = await slot.run(cell, fn);
  const position = cell.position ?? cell.replayed;
  return { result, position: position === null ? null : position.toString() };
}

/** Called by db.ts insertEvent() with the id it just inserted; returns what to run once it commits (db.ts passes it to
 *  afterCommit), or null outside a request (background work: no cell, nothing to note). Several events (a cascade,
 *  several root writes in one request): the largest committed id is the last one, since ids are handed out in order
 *  under the lock. */
export async function noteInsertedEvent(id: string): Promise<(() => void) | null> {
  if (!/^\d+$/.test(id)) return null;
  // Kept with the request's idempotency key in this same transaction, so a replay answers with it (migration 212).
  await claimPositionRecorder?.(id);
  const cell = slot.getStore();
  if (!cell) return null;
  const position = BigInt(id);
  return () => { if (cell.position === null || position > cell.position) cell.position = position; };
}

/** A replay of a key already used (spine/idempotency.ts): the position its first write committed, or nothing for a key
 *  from before migration 212 or one whose write committed no event. Never the current head. */
export function noteReplayedPosition(position: string | null): void {
  const cell = slot.getStore();
  if (cell && position !== null && /^\d+$/.test(position)) cell.replayed = BigInt(position);
}

/** spine/idempotency.ts installs how an event's id is kept with the claimed key (it imports db.ts; db.ts imports this
 *  file, so the recorder is handed in rather than imported). */
let claimPositionRecorder: ((eventId: string) => Promise<void>) | null = null;
export function setClaimPositionRecorder(recorder: (eventId: string) => Promise<void>): void {
  claimPositionRecorder = recorder;
}
