// Sidebar pointers: a note shown under a second parent. Every surface that pins
// or unpins goes through here, so they agree on what counts as success and how
// a failure is reported (once, through reportWriteFailure).
import { ApiError } from "../api";
import { sendWrite } from "./onlineWrite";
import { addToast, getAppState, setData } from "../appStore";
import { makeWriteLifecycle } from "./writeLifecycle";
import { queuedWriteMessage, reportWriteFailure } from "./writeErrors";

export type PinOutcome = "created" | "exists";

/** The server's code for a pin already at this (parent, target): 409 with
 *  this sentence as `error` (routes/pointers.ts). Any other 409 — a parent of
 *  the wrong kind (parent_kind_mismatch) — is a refusal, not an existing pin. */
const POINTER_EXISTS = "pointer already exists at this location";

/** Pin `targetId` under the note `parentId`. Always under a note: a pin at
 *  the top level is never shown (OverviewSidebar renders pointers under a
 *  parent row), so the parent comes from the pin picker (lib/data
 *  placementCandidates with `pin`). A pin already there (409, POINTER_EXISTS)
 *  is the state the caller asked for; any other refusal is reported once and
 *  rethrown. Not queued offline: a replayed 409 would land in recovery as a
 *  refused change. */
export async function pinPointer(targetId: string, parentId: string): Promise<PinOutcome> {
  try {
    // One online write with an Idempotency-Key: a resent pin applies once.
    await sendWrite("POST", "/api/pointers", { target_id: targetId, parent_id: parentId });
    return "created";
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.code === POINTER_EXISTS) return "exists";
    reportWriteFailure(error, addToast);
    throw error;
  }
}

const commit = makeWriteLifecycle({ get online() { return getAppState().online; }, addToast });

/** Remove a pin. The pin leaves the sidebar at once; a transport or 5xx failure
 *  queues the delete for the reconnect drain (saying so, so the person does not
 *  press again), and a refusal puts the pin back, is reported once and rethrown. */
export async function unpinPointer(pointerId: string): Promise<void> {
  const removed = getAppState().data.pointers?.find((pin) => pin.id === pointerId);
  if (removed) setData((data) => ({ ...data, pointers: data.pointers?.filter((pin) => pin.id !== pointerId) }));
  const result = await commit(`pointer:${pointerId}`, { method: "DELETE", path: `/api/pointers/${pointerId}`, body: null }, {
    rejected: () => {
      if (removed) setData((data) => data.pointers?.some((pin) => pin.id === removed.id) ? data : { ...data, pointers: [...(data.pointers ?? []), removed] });
    },
  });
  if (result.status === "queued") addToast(queuedWriteMessage(), "info");
}
