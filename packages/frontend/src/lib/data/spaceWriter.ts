import type { DeletedNotesChoice, SpaceCapability, SpacePermission } from "@onden/contract";
import { sendWrite } from "./onlineWrite";

// What a person does to spaces and to who is in them. Online only: each call is the server's decision, nothing is queued.
// Callers keep their own reload (lib/spaces `refreshSpaces`) and error reporting (`writeErrors`).
export const spaceWriter = {
  create: (name: string) => sendWrite<{ id: string }>("POST", "/api/spaces", { name }),
  update: (id: string, changes: { name?: string; capabilities?: Partial<Record<SpaceCapability, boolean>> }) =>
    sendWrite("PATCH", `/api/spaces/${id}`, changes),
  /** `expectedDeletedIds`: the preview's deleted_ids, required for "purge" (the server refuses with 409 plan_changed if they changed). */
  remove: (id: string, deletedNotes?: DeletedNotesChoice, expectedDeletedIds?: string[]) =>
    sendWrite<{ ok: true; purged: number; moved: number }>("DELETE", `/api/spaces/${id}`, deletedNotes
      ? { deleted_notes: deletedNotes, ...(deletedNotes === "purge" ? { expected_deleted_ids: expectedDeletedIds } : {}) }
      : undefined),
  /** `null` takes the person out of the space. */
  setMember: (id: string, actorId: string, permission: SpacePermission | null) => permission === null
    ? sendWrite("DELETE", `/api/spaces/${id}/members/${actorId}`)
    : sendWrite("PUT", `/api/spaces/${id}/members/${actorId}`, { permission }),
  moveNote: (nodeId: string, toSpaceId: string, membershipEpoch: number) =>
    sendWrite<{ moved: number }>("POST", "/api/spaces/move", { node_id: nodeId, to_space_id: toSpaceId, membership_epoch: String(membershipEpoch) }),
};
