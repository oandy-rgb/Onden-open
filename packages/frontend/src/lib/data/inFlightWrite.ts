// The one write this tab has on the wire, kept in sessionStorage (it survives
// a reload of the tab, not its closing) so the next page load knows that a
// request it never saw may still reach the server. See adoptInterruptedWrite
// in writeQueue.ts. Writes are sent one at a time (the lane), so one slot is
// enough; a body too large to keep is left out and goes as it did before.

import { accountStorageKey } from "../accountStorage";
import { readSession, removeSession, SESSION_KEYS, writeSession } from "../sessionPrefs";
import type { OfflineQueueFailedDetail } from "./writeQueue";

const MAX_BODY_CHARS = 400_000;

type InFlight = OfflineQueueFailedDetail & { idemKey: string };

/** The account's slot: a write kept for one account is never replayed as another. */
const slotKey = () => accountStorageKey(SESSION_KEYS.writeInFlight);

export function markInFlight(request: InFlight): void {
  if ((request.body?.length ?? 0) > MAX_BODY_CHARS) return;
  try { writeSession(slotKey(), JSON.stringify({ method: request.method, path: request.path, body: request.body, idemKey: request.idemKey })); }
  catch { /* no account bound yet, storage full or blocked: the write goes without the safeguard */ }
}

/** Leaves the slot alone when it holds another write's: after a reload the old
 *  page's code can still finish and must not clear the new page's entry. */
export function clearInFlight(idemKey: string): void {
  try {
    const raw = readSession(slotKey());
    if (raw && (JSON.parse(raw) as InFlight).idemKey === idemKey) removeSession(slotKey());
  } catch { /* nothing to clear */ }
}

/** The write a previous page load left on the wire, removed from the slot. */
export function takeInterrupted(): InFlight | null {
  try {
    const raw = readSession(slotKey());
    if (!raw) return null;
    removeSession(slotKey());
    const parsed = JSON.parse(raw) as InFlight;
    return parsed.idemKey && parsed.method && parsed.path ? parsed : null;
  } catch { return null; }
}
