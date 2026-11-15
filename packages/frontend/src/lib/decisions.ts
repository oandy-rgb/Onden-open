// What waits for the owner's decision, grouped by the note it is about. The same
// records the old review queue listed (agent changes awaiting review, edit
// conflicts), only read per note: the note shows its own line (NoteDecisions) and
// the inbox lists the notes (modules/capture DecideSection). Nothing here writes.

import type { InboxEvent } from "./api";
import type { BodyConflictPayload } from "./bodyConflict";
import type { LiveEvent } from "./liveEvent";

export type NoteDecision = {
  nodeId: string;
  /** Changes an agent made and the owner has not yet kept or undone. */
  agentChanges: number;
  /** Places in the body both sides changed (kept text and left-out text). */
  bodyConflicts: number;
  /** Fields changed on two devices at once. */
  fieldConflicts: number;
  /** All of the above: the 「有 N 處等你決定」 count. */
  total: number;
};

export type Decisions = {
  byNote: ReadonlyMap<string, NoteDecision>;
  /** Agent changes that are not about a note in this workspace's list. */
  otherEvents: InboxEvent[];
  /** Everything waiting: notes' places plus the other events and held requests. */
  total: number;
};

/** Places in one body-conflict event: a conflict too long to list still counts once. */
export function bodyConflictPlaces(event: LiveEvent): number {
  const regions = (event.payload as unknown as BodyConflictPayload).conflicts ?? [];
  return Math.max(1, regions.length);
}

export function collectDecisions(input: {
  events: readonly InboxEvent[];
  heldRequests: number;
  fieldConflicts: readonly LiveEvent[];
  bodyConflicts: readonly LiveEvent[];
  /** Whether a note id is a note the person can open from here. */
  hasNote: (id: string) => boolean;
}): Decisions {
  const byNote = new Map<string, NoteDecision>();
  const entry = (nodeId: string): NoteDecision => {
    let found = byNote.get(nodeId);
    if (!found) { found = { nodeId, agentChanges: 0, bodyConflicts: 0, fieldConflicts: 0, total: 0 }; byNote.set(nodeId, found); }
    return found;
  };
  const otherEvents: InboxEvent[] = [];
  for (const e of input.events) {
    if (input.hasNote(e.target_id)) { entry(e.target_id).agentChanges += 1; } else otherEvents.push(e);
  }
  for (const e of input.fieldConflicts) if (input.hasNote(e.target_id)) entry(e.target_id).fieldConflicts += 1;
  for (const e of input.bodyConflicts) if (input.hasNote(e.target_id)) entry(e.target_id).bodyConflicts += bodyConflictPlaces(e);
  let total = otherEvents.length + input.heldRequests;
  for (const d of byNote.values()) {
    d.total = d.agentChanges + d.bodyConflicts + d.fieldConflicts;
    total += d.total;
  }
  return { byNote, otherEvents, total };
}
