// Which queued writes a live page is sending itself.
//
// Every save is a queue row from the moment it is made (writeQueue.recordWrite): the row is its durable copy, so a
// page killed at any instant leaves it queued. While the page that made it lives, the row is that page's to send, in
// its own write lane: this page's drain stops at it (it is next in the lane), and so does ANOTHER live tab's, because
// each such write holds a Web Lock named by its key. The lock is let go when the page has sent it, given it to the
// queue (a failure: then any tab's drain sends it), or died (the browser releases a dead page's locks). A drain that
// stopped at another tab's row drains again once that lock is free.
import { heldLockNames, holdLockUntilReleased, whenLockFree } from "../webLock";

const WRITE_LOCK = "onden-write:";
/** One entry per key this page is sending, shared by every save of that key now on its way here. Two saves of one key
 *  can overlap (the day's note created from two places at once, a focus session resending its attempt): each takes a
 *  share and lets go of its own, and the lock goes when the last share does. A second lock per save would wait for
 *  the first save's release, which comes only after the lane reaches that save; a later save already in the lane would
 *  wait on it for good. */
const sendingHere = new Map<string, { held: Promise<() => void>; shares: number }>();

/** Resolves once the write's lock is held, so no other tab can take its row from the moment the row exists.
 *  Every call takes one share, given back by one stopSendingHere. */
export function startSendingHere(idemKey: string): Promise<void> {
  const entry = sendingHere.get(idemKey);
  if (entry) { entry.shares += 1; return entry.held.then(() => {}); }
  const held = holdLockUntilReleased(WRITE_LOCK + idemKey);
  sendingHere.set(idemKey, { held, shares: 1 });
  return held.then(() => {});
}

export function stopSendingHere(idemKey: string): void {
  const entry = sendingHere.get(idemKey);
  if (!entry || --entry.shares > 0) return;
  sendingHere.delete(idemKey);
  void entry.held.then((release) => release());
}

export function isSendingHere(idemKey: string | null): boolean { return idemKey !== null && sendingHere.has(idemKey); }

/** Keys of queued writes another live tab is sending itself (their lock is held, and not by this page). */
export async function sendingElsewhere(): Promise<Set<string>> {
  const names = await heldLockNames(WRITE_LOCK);
  return new Set([...names].map((name) => name.slice(WRITE_LOCK.length)).filter((key) => !sendingHere.has(key)));
}

/** Resolves when no other tab holds this write's lock any more. */
export function whenSentElsewhere(idemKey: string): Promise<void> { return whenLockFree(WRITE_LOCK + idemKey); }
