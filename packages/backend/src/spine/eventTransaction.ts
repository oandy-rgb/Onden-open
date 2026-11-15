import { q, withSavepoint } from "../db.js";
import { acquireEventAppendLock } from "./eventLock.js";

/** Acquire before changing state or emitting events, inside the write transaction.
 *  Sharing this lock with mutate() keeps event IDs ordered by workspace commit;
 *  acquiring only at event INSERT would invert the state-row/event lock order.
 *  db.ts event() takes the same lock (spine/eventLock.ts), so a standalone
 *  append cannot overtake. */
export async function lockEventAppend(workspaceId: string): Promise<void> {
  await acquireEventAppendLock(q, workspaceId);
}

/** Atomic event operation, including when its caller catches a domain rejection
 *  and continues a batch. The caller must throw to reject; returning an error
 *  object is still a successful transaction. Domain policy stays with the caller. */
export function withEventTransaction<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  return withSavepoint(async () => {
    await lockEventAppend(workspaceId);
    return fn();
  });
}
