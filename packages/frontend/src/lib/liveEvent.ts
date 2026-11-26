// One row of the event history as the server returns it (GET /api/events); read by hooks/useLiveEventLog.
export type LiveEvent = {
  id: number;
  actor_type: "user" | "ai_agent" | "system";
  actor_id: string;
  event_type: string;
  target_type: string;
  target_id: string;
  payload: Record<string, unknown>;
  created_at: string;
  // ER7: surfaced for the Restore button + cascade preview.
  tx_meta?: Record<string, unknown>;
  external?: boolean;
  triggered_by_event_id?: string | number | null;
  /** D33: the server's answer to "is Restore offered" (GET /api/events, by the
   *  rule restore itself refuses with). Absent — an event that did not come
   *  from that route, e.g. a cached copy or an older server — means not
   *  restorable: the button stays disabled rather than guessing. A click can
   *  still be refused for the current state (conflict, target gone). */
  restorable?: boolean;
  /** History's Deleted view only: the deleted note's space, which decides
   *  who may delete it for good (lib/capabilities.ts canPurgeDeleted). */
  target_space_id?: string | null;
  /** Why restorable is false; null when it is true. */
  restore_blocked_reason?: "external" | "irreversible" | "history_incomplete" | "unsupported" | "imported_history" | "made_elsewhere" | null;
};
