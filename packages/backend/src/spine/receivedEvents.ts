// The events a node writes to ITS OWN log when it takes another node's change bundle (docs/architecture/proposals/own-node-transport-2026-11-22.md §2.12.5,
// batch 4b). The log is node-local (spine/syncClasses.json: domain_events), so these rows are this node's record that a change came in: its clients read
// them (/api/sync's delta, History, the day page), and nothing sends them anywhere. What each received change records is services/receivedEvents.ts
// (the map from a unit to an event, the same kinds a local write of it records); HOW it is recorded is decided here, once, for every received event:
//   received: true      tx_meta: the change was made on another node (History and undo tell it from a local one by this)
//   written_at          tx_meta: when it was WRITTEN, the wall clock of its stamp (not when it arrived); readers that show a time prefer it
//   origin              tx_meta: the node that wrote it
//   inverse_patch       NO_INVERSE_PATCH on a body change: "undo this one" is refused (restore.ts), a person restores a version instead (a new local write)
//   base_hash           not known here (the writer's base is not carried): none is recorded, never this node's previous body (db.ts EventOptions.baseHash)
//   actor               the stamp's author when this node holds that actor (a person or an AI agent of this workspace); otherwise UNKNOWN_AUTHOR as the system
//   device              the stamp's device (a uuid), not the request's
// It mints nothing: a merge stands the version triggers aside (migration 220 note_version_exempt 'import'), so no note version is linked to these events.
import { isUuid } from "@onden/markdown";
import { event } from "../db.js";
import { db } from "../dbKysely.js";
import type { Stamp } from "./stampedMerge/index.js";
import { NO_INVERSE_PATCH } from "./inversePatch.js";

/** actor_id of a received event whose author this node does not hold (a temporary session's, whose row never leaves its node; a write outside the roots).
 *  Not uuid-shaped, so the actor check of migration 071 lets it through, like the other signatures that name no actor row. */
const UNKNOWN_AUTHOR = "another-device";

/** One event of a received change: what services/receivedEvents.ts decided it records, and the stamp of the write it records (the latest when several). */
export type ReceivedEvent = {
  type: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  stamp: Stamp;
};

/** Append `events` (in the bundle's transaction, after its rows and their derivation), each marked as received. Returns how many were written. */
export async function appendReceivedEvents(workspaceId: string, events: readonly ReceivedEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const authors = [...new Set(events.map((e) => e.stamp.author).filter((a): a is string => !!a && isUuid(a)))];
  const held = new Map(authors.length === 0 ? [] : (await db.selectFrom("actors").select(["id", "type"]).where("workspace_id", "=", workspaceId)
    .where("id", "in", authors).execute()).map((a) => [a.id, a.type] as const));
  for (const e of events) {
    const kind = e.stamp.author ? held.get(e.stamp.author) : undefined;
    // a person or an AI agent this node holds is named; a session never leaves its node, so it is no one here
    const [actorType, actorId] = kind === "human" ? ["user", e.stamp.author!] as const : kind === "agent" ? ["ai_agent", e.stamp.author!] as const : ["system", UNKNOWN_AUTHOR] as const;
    const body = typeof e.payload.body_hash === "string";
    await event(workspaceId, e.type, e.targetType, e.targetId, e.payload, actorType, actorId, {
      txMeta: {
        received: true, written_at: new Date(e.stamp.wall).toISOString(), origin: e.stamp.origin,
        ...(body ? { inverse_patch: NO_INVERSE_PATCH, base_unknown: true } : {}),
      },
      ...(body ? { baseHash: null } : {}),
      deviceId: e.stamp.device && isUuid(e.stamp.device) ? e.stamp.device : null,
    });
  }
  return events.length;
}
