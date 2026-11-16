// Which of two copies of one row is the older one. A sync answer is computed on the server at one moment and can
// reach this device after a newer copy of the same row did (the acknowledgement of this device's own save, or a later
// answer): the owner, alone on one tablet, had two saves two seconds apart carry the same base (2026-11-16), because
// an answer asked before the first save was acknowledged replaced the saved text with the one before it.
// The store (lib/data/storeOps applySyncDelta) and the local copy (localDbWorker applySync) both ask here, so an
// answer is dropped for a row in both or in neither.

// What the rule costs, and why it is an interim one: time is not the right yardstick. If the server's clock steps back
// (a correction is enough, or a restore from an older backup), a note changed afterwards carries an earlier time than
// the copy held, and that REAL newer change is not taken until the note changes again. The server has an order that
// needs no clock: the event position an answer was computed at and the event a save was acknowledged with. The rule to
// replace this one with: remember per row the position it was taken at, and skip a row only when the answer's head is
// below it; that also covers what this rule does not (attributes, edges, pointers, tags, anchors in the same answer).

type Dated = { updated_at?: string | null };

/** True when `incoming` is a copy of the row from BEFORE the one held: both carry the server's time and incoming's is
 *  strictly earlier. Equal times, or a side with no time (a row made on this device and not yet answered), say nothing:
 *  the incoming copy is taken, as before. The server sets updated_at itself, so the two times come from one clock. */
export function isOlderCopy(incoming: Dated, held: Dated | undefined): boolean {
  if (!held?.updated_at || !incoming.updated_at) return false;
  const a = Date.parse(incoming.updated_at), b = Date.parse(held.updated_at);
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
}
