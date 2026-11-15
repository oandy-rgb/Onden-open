import type { RestoreError } from "../restoreContract.js";

/** The refusals every inverse handler builds the same way. `force` cannot make
 *  up for either: history_incomplete is a missing base, state_conflict a later
 *  edit that the restore would overwrite. */
export const historyIncomplete = (detail: string): Extract<RestoreError, { code: "history_incomplete" }> =>
  ({ code: "history_incomplete", status: 409, detail, force_available: false });

export const stateConflict = (detail: string): Extract<RestoreError, { code: "state_conflict" }> =>
  ({ code: "state_conflict", status: 409, detail, force_available: false });

/** The restore would write what the node already holds. */
export const alreadyInState = (detail: string): Extract<RestoreError, { code: "already_in_state" }> =>
  ({ code: "already_in_state", status: 409, detail });
