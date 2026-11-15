import { inTransaction } from "../../db.js";
import { mutateRestore } from "../../spine/mutate.js";
import type { ActorCtx } from "../../types.js";
import type { EventRow, RestoreRecord, RestoreResult } from "../restoreContract.js";

/** Inverse handlers join restoreEvent's authorized transaction. A standalone
 *  call must fail before changing state rather than emitting a partial restore. */
export function requireRestoreTransaction(): void {
  if (!inTransaction()) throw new Error("inverse handler requires a restore transaction");
}

/** Record the inverse's actual before/after values with consistent provenance.
 *  The domain owns its event meaning; mutateRestore owns attribution, linkage
 *  and the transaction. Call after applying state in the same transaction. */
export async function recordRestore(
  original: EventRow,
  actor: ActorCtx,
  change: RestoreRecord,
): Promise<RestoreResult> {
  requireRestoreTransaction();
  // The handler already applied the state; the event is all that is left to write.
  const restoreEventId = await mutateRestore({
    actor,
    original,
    event: {
      type: change.eventType, targetType: original.target_type, targetId: original.target_id,
      payload: change.payload,
      txMeta: { inverse_op: change.inverseOp, prev_field_values: change.previous },
    },
    apply: async ({ eventId }) => eventId,
  });
  return {
    restored: true,
    original_event_id: original.id,
    original_event_type: original.event_type,
    restore_event_id: restoreEventId,
    restore_event_type: change.eventType,
  };
}
