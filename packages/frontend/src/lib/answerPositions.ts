// An answer read before one of this device's acknowledged writes must not be applied (owner, 2026-11-16: a person alone
// on one tablet typed and was told the note had been merged). The order to judge by is the server's, not a clock:
// every successful write carries its event position (EVENT_POSITION_HEADER, the id of the last event it committed),
// every answer that carries rows says where it was read (a sync delta's `head_event_id`, a bootstrap's `last_event_id`,
// a membership page's `event_cursor`), and ids are handed out and committed under the workspace's event lock, read in
// one snapshot with the rows. So head ≥ P ⇔ the answer contains every row write P touched, derived ones included: an
// answer is either after all of this device's acknowledged writes or it is not. There is nothing finer to work out.
//
// The rule, for one server identity: the WATERMARK is the highest position this device knows of — every acknowledged
// write's, and the head of every answer it applied (so an older answer arriving after a newer one is refused too). An
// answer whose head is below the watermark is not applied at all, and is asked for again. The same function decides in
// the local copy (localDbWorker: applySync, persistBootstrap) and in the page (lib/data/writePositions.ts takeAnswer).
// Loaded by the local-DB worker: no imports.

/** True when an answer read at `head` may be applied over what this device knows up to `watermark` (decimal strings;
 *  `watermark` null or "0": nothing known yet). An answer that says nothing about where it was read is current only
 *  while nothing is known: every answer of a protocol-5 server says it (CLIENT_PROTOCOL). */
export function isCurrentAnswer(head: string | number | null | undefined, watermark: string | null): boolean {
  const known = positionOf(watermark) ?? 0n;
  const read = positionOf(head);
  return read === null ? known === 0n : read >= known;
}

/** A position as a number, or null when it is none (null, undefined, not a decimal). */
function positionOf(value: string | number | null | undefined): bigint | null {
  return value != null && /^\d+$/.test(String(value)) ? BigInt(value) : null;
}

/** The higher of two positions (decimal strings; null is none). */
export function higherPosition(a: string | null, b: string | null): string | null {
  const x = positionOf(a), y = positionOf(b);
  return x === null ? (y === null ? null : b) : y === null || x >= y ? a : b;
}

/** How often in a row answers may be refused before this device holds its next write until an answer is taken
 *  (lib/data/writePositions.ts): a person drawing sends a write every second, and each acknowledgement would otherwise
 *  make the answer already on its way stale, forever. */
export const STALE_ANSWERS_BEFORE_WRITES_WAIT = 3;
/** How often a bootstrap, a membership check or a single note read asks again for an answer refused as late, before it
 *  gives up (the sync pass asks again by itself, within its hop cap). Not a test of whether the server went back: one
 *  answer decides that (lib/data/writePositions.ts serverWentBack). */
export const ASK_AGAIN_AT_MOST = 3;
