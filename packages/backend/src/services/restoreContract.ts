// The restore contract between eventRestore/ (which undoes one recorded event)
// and the domains that own an inverse for their own events. A domain registers
// its inverse here at module init, the same way modules register nodeHooks.
// This module is a dependency-free leaf: the registering domain (e.g.
// tagMembership) is itself reachable from eventRestore, so neither may import
// the other.

import type { ActorCtx } from "../types.js";

export interface RestoreResult {
  restored: true;
  original_event_id: string;
  original_event_type: string;
  restore_event_id: string;
  restore_event_type: string;
  /** True when force overwrote body lines edited again after the event
   *  (the merge's conflicts; the overwritten text stays in version history).
   *  NODE_UPDATED only. */
  overwrote_later_edits?: boolean;
  /** When as_new_node=true: the new node's id + slug so the UI can link
   *  to it. The live node was NOT modified. */
  new_node_id?: string;
  new_node_slug?: string;
  /** Cascade-mode summary: descendants restored in reverse-id order.
   *  Each entry mirrors a recursive restoreEvent
   *  call's result. Empty when cascade=false or no children existed. */
  cascade?: Array<{
    event_id: string;
    event_type: string;
    result: "ok" | "skipped";
    detail?: string;
  }>;
}

export type RestoreError =
  | { code: "not_found"; status: 404; detail: string }
  | { code: "external"; status: 409; detail: string }
  | { code: "irreversible"; status: 410; detail: string }
  | { code: "target_gone"; status: 410; detail: string }
  | { code: "already_in_state"; status: 409; detail: string }
  | { code: "patch_conflict"; status: 409; detail: string; force_available: true }
  /** `reason`: the specific rule that refused, when one did (e.g.
   *  tag_name_conflict for a move undone onto a taken name, D102). */
  | { code: "state_conflict"; status: 409; detail: string; force_available: false; reason?: string }
  | { code: "history_incomplete"; status: 409; detail: string; force_available: false }
  | { code: "unsupported"; status: 422; detail: string }
  /** A version carried in from another workspace (spine/importedHistory.ts): the person restores that version instead. */
  | { code: "imported_history"; status: 409; detail: string; force_available: false }
  /** The inverse would trash a reserved tag (services/reservedTags.ts). */
  | { code: "reserved_tag"; status: 409; detail: string };

export type EventRow = {
  id: string;
  workspace_id: string;
  event_type: string;
  target_type: string;
  target_id: string;
  payload: Record<string, unknown>;
  tx_meta: Record<string, unknown>;
  external: boolean;
};

/** What a domain-owned inverse may rely on. restoreEvent has already loaded
 *  and authorized the event, opened the restore transaction and resolved the
 *  current actor before calling the handler. */
export interface RestoreContext {
  /** The current actor: the restore event is attributed to it (mutate derives
   *  actor_type), and hooks that need the full identity get it. */
  actorContext: ActorCtx;
  /** Append the restore event with consistent provenance (triggered_by,
   *  restored_from, inverse_op) and build the success result. Call once,
   *  after applying the state change. */
  record(change: RestoreRecord): Promise<RestoreResult>;
}

export interface RestoreRecord {
  eventType: string;
  payload: Record<string, unknown>;
  /** inverse_op of the new event, so the restore is itself restorable. */
  inverseOp: string;
  previous: Record<string, unknown> | null;
}

/** A preview returned to the diff modal as PreviewResult.preview. kind names
 *  the shape for the UI; the rest is owned by the registering domain. */
export interface RegisteredRestorePreview {
  kind: string;
  can_apply_cleanly: boolean;
}

/** The inverse of one domain's events. The domain owns the event meaning and
 *  conflict rules; eventRestore owns lookup, authorization, transaction,
 *  cascade and idempotency. preview must write nothing. */
export interface RestoreHandler {
  eventTypes: readonly string[];
  restore(row: EventRow, context: RestoreContext): Promise<RestoreResult | RestoreError>;
  preview(row: EventRow): Promise<RegisteredRestorePreview | RestoreError>;
}

const handlers = new Map<string, RestoreHandler>();

/** The event types eventRestore leaves to a registered domain inverse (it has
 *  no built-in case for them). services/restoreHandlers.ts imports every
 *  registrant; a test checks each type here has a handler once it is loaded. */
export const DOMAIN_RESTORED_EVENT_TYPES: readonly string[] = ["TAG_APPLIED", "TAG_REMOVED", "BACKUP_RESTORED", "FUNCTION_REF_ADDED", "FUNCTION_REF_REMOVED", "FUNCTION_REF_CONFIG_CHANGED"];

/** The event types eventRestore inverts itself (services/eventRestore/restore.ts
 *  keys its built-in inverses by exactly this list, so the compiler rejects a
 *  missing or extra case). */
export const BUILT_IN_RESTORED_EVENT_TYPES = [
  "NODE_DELETED", "NODE_UNDELETED", "NODE_CREATED", "NODE_UPDATED", "NODE_RESTORED",
  "ATTRIBUTE_SET", "ATTRIBUTE_DELETED", "TAG_UPDATED", "TAG_SCHEMA_UPDATED",
  "NODE_MOVED_SPACE", "TAG_MERGED",
] as const;
export type BuiltInRestoredEventType = typeof BUILT_IN_RESTORED_EVENT_TYPES[number];

/** History recorded under a path's own type before every create and trash
 *  went through one operation: a bookmark or canvas creation is a node
 *  creation, a canvas delete a node trash. Restore and preview treat them so.
 *  A collection delete still records its own type, and is a node trash too
 *  (its tag, through nodeTrash.ts trashLive): History is the only way back. */
export const LEGACY_NODE_EVENT_TYPES: Readonly<Record<string, string>> = {
  BOOKMARK_CREATED: "NODE_CREATED",
  CANVAS_CREATED: "NODE_CREATED",
  CANVAS_DELETED: "NODE_DELETED",
  COLLECTION_SCHEMA_DELETED: "NODE_DELETED",
};

/** Why an event can never be restored, judged from the row alone.
 *  - external: the side effect ran outside PG (git/github backup);
 *  - irreversible: a purge (CASCADE has wiped dependents), or an event of a
 *    note deleted for good (its content erased: tx_meta {"purged": true});
 *  - history_incomplete: a version restore recorded before undo support;
 *  - unsupported: no inverse exists for this event type (saved views,
 *    snapshots, publish markers, edges, tokens, …);
 *  - imported_history: a version carried in by a backup or workspace move; it was never an edit here, so it has no inverse
 *    (its created kind would otherwise trash the live note). The person restores that version from the version list. */
export type RestoreBlockedReason = "external" | "irreversible" | "history_incomplete" | "unsupported" | "imported_history";

export type RestoreClassifiable = {
  event_type: string;
  external?: boolean | null;
  /** domain_events.tx_meta as stored (an object, or absent). */
  tx_meta?: unknown;
};

const restoredTypes = new Set<string>([...BUILT_IN_RESTORED_EVENT_TYPES, ...DOMAIN_RESTORED_EVENT_TYPES]);

/** The one rule for "can this event be restored at all" (depth audit D33).
 *  Pure and synchronous, so event lists can send it per row. restoreEvent and
 *  previewEventRestore refuse with exactly this reason before they touch any state,
 *  so a list never offers Restore on an event the server always refuses.
 *  State-dependent refusals (target gone, conflicts, authority) are not
 *  judged here; they still surface when the restore is attempted. */
export function restoreBlockedReason(e: RestoreClassifiable): RestoreBlockedReason | null {
  if (e.external === true) return "external";
  const type = LEGACY_NODE_EVENT_TYPES[e.event_type] ?? e.event_type;
  if (type === "NODE_PURGED" || type === "NODES_PURGED") return "irreversible";
  // An event of a note deleted for good, its content erased (migration 118).
  if ((e.tx_meta as { purged?: unknown } | null | undefined)?.purged === true) return "irreversible";
  // One rule for every kind of an imported version, the created one included (checked before the per-type rules below).
  if ((e.tx_meta as { history_import?: unknown } | null | undefined)?.history_import != null) return "imported_history";
  // DOMAIN_RESTORED_EVENT_TYPES answers before the registrants have loaded
  // (restoreEvent loads them itself); a registered handler counts too.
  if (!restoredTypes.has(type) && !handlers.has(type)) return "unsupported";
  // Restoring a version recorded its inverse (services/nodeUpdate.ts) since
  // 2026-10-14; older ones did not and cannot be undone exactly.
  if (type === "NODE_RESTORED" &&
      typeof (e.tx_meta as { inverse_patch?: unknown } | null | undefined)?.inverse_patch !== "string") {
    return "history_incomplete";
  }
  return null;
}

export function isRestorable(e: RestoreClassifiable): boolean {
  return restoreBlockedReason(e) === null;
}

/** The refusal restoreEvent/previewEventRestore answer for a blocked event. */
export function restoreBlockedError(e: RestoreClassifiable): RestoreError | null {
  switch (restoreBlockedReason(e)) {
    case null: return null;
    case "external":
      return { code: "external", status: 409,
        detail: "event has external side effects (git/github backup); restore from backup target instead" };
    case "irreversible":
      return { code: "irreversible", status: 410, detail: "purge events are irreversible from PG; check external backups" };
    case "history_incomplete":
      return { code: "history_incomplete", status: 409, force_available: false,
        detail: "this version restore predates undo support" };
    case "imported_history":
      return { code: "imported_history", status: 409, force_available: false,
        detail: "this version came from a backup or workspace move; restore that version from the version list instead" };
    case "unsupported":
      return { code: "unsupported", status: 422, detail: `restore not implemented for event_type=${e.event_type}` };
  }
}

/** Make restoreEvent/previewEventRestore dispatch these event types to the owning
 *  domain. Call at module init of the owner, and import the owner from
 *  services/restoreHandlers.ts, which eventRestore loads before its first
 *  restore or preview. An event type has one owner; registering it twice is a
 *  programming error. An event type with no handler restores as `unsupported`. */
export function registerRestoreHandler(handler: RestoreHandler): void {
  for (const eventType of handler.eventTypes) {
    if (handlers.has(eventType)) throw new Error(`restore handler already registered for ${eventType}`);
    handlers.set(eventType, handler);
  }
}

/** The event types with a registered inverse, for the registry test. */
export function registeredRestoreEventTypes(): string[] {
  return [...handlers.keys()];
}

export function restoreHandlerFor(eventType: string): RestoreHandler | undefined {
  return handlers.get(eventType);
}
