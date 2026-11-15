// D33: the one "can this event be restored at all" rule. Event lists send it
// per row as `restorable`; restoreEvent/previewEventRestore refuse with exactly
// the same reason before touching state. (These cases moved here from the
// deleted frontend lib/eventRestorable.ts.)

import { describe, it, expect } from "vitest";
import {
  BUILT_IN_RESTORED_EVENT_TYPES, DOMAIN_RESTORED_EVENT_TYPES, LEGACY_NODE_EVENT_TYPES,
  isRestorable, restoreBlockedError, restoreBlockedReason,
} from "../services/restoreContract.js";

describe("restoreBlockedReason", () => {
  it("every type with an inverse is restorable", () => {
    for (const type of [...BUILT_IN_RESTORED_EVENT_TYPES, ...DOMAIN_RESTORED_EVENT_TYPES]) {
      const txMeta = type === "NODE_RESTORED" ? { inverse_patch: "" } : {};
      expect(restoreBlockedReason({ event_type: type, external: false, tx_meta: txMeta }), type).toBeNull();
    }
  });

  it("legacy bookmark/canvas history restores as the node event it was", () => {
    for (const type of Object.keys(LEGACY_NODE_EVENT_TYPES)) {
      expect(isRestorable({ event_type: type, external: false }), type).toBe(true);
    }
  });

  it("external events are never restorable (side effect ran outside PG)", () => {
    expect(restoreBlockedReason({ event_type: "NODE_UPDATED", external: true })).toBe("external");
  });

  it("a purge is irreversible", () => {
    expect(restoreBlockedReason({ event_type: "NODE_PURGED", external: false })).toBe("irreversible");
  });

  it("a version restore recorded before undo support is history_incomplete", () => {
    expect(restoreBlockedReason({ event_type: "NODE_RESTORED", tx_meta: {} })).toBe("history_incomplete");
    expect(restoreBlockedReason({ event_type: "NODE_RESTORED", tx_meta: null })).toBe("history_incomplete");
    expect(restoreBlockedReason({ event_type: "NODE_RESTORED", tx_meta: { inverse_patch: "@@" } })).toBeNull();
  });

  it("a version carried in by a backup or a move is never restorable, whatever its kind (the created one would trash the note)", () => {
    const carried = { history_import: { event: "7", actor_type: "ai_agent", actor_name: "Bot" }, inverse_patch: "no-inverse-patch" };
    for (const type of ["NODE_CREATED", "NODE_UPDATED", "NODE_RESTORED"]) {
      expect(restoreBlockedReason({ event_type: type, external: false, tx_meta: carried }), type).toBe("imported_history");
      expect(isRestorable({ event_type: type, tx_meta: carried }), type).toBe(false);
      expect(restoreBlockedError({ event_type: type, tx_meta: carried }), type).toMatchObject({ code: "imported_history", status: 409, force_available: false });
      // The same event without the marker is as restorable as it ever was.
      expect(restoreBlockedReason({ event_type: type, tx_meta: { inverse_patch: "" } }), type).toBeNull();
    }
  });

  it("types without an inverse are unsupported (the ones the old front-end list missed included)", () => {
    for (const type of [
      "COLLECTION_VIEW_CREATED", "COLLECTION_VIEW_UPDATED", "COLLECTION_VIEW_DELETED",
      "COLLECTION_SCHEMA_UPDATED", "PUBLISH_SNAPSHOT_CREATED", "EDGE_CREATED", "EDGE_DELETED",
      "NODE_HIDDEN_CHANGED", "TOKEN_CREATED", "TASK_UPDATED", "SPACE_MEMBER_SET", "MODULE_IMPORTED",
    ]) {
      expect(restoreBlockedReason({ event_type: type, external: false }), type).toBe("unsupported");
    }
    // A collection's schema edit is a TAG_SCHEMA_UPDATED and stays restorable.
    expect(isRestorable({ event_type: "TAG_SCHEMA_UPDATED" })).toBe(true);
  });

  it("the refusal carries the status the restore route has always answered", () => {
    expect(restoreBlockedError({ event_type: "NODE_UPDATED", external: true })).toMatchObject({ code: "external", status: 409 });
    expect(restoreBlockedError({ event_type: "NODE_PURGED" })).toMatchObject({ code: "irreversible", status: 410 });
    expect(restoreBlockedError({ event_type: "NODE_RESTORED" })).toMatchObject({ code: "history_incomplete", status: 409 });
    expect(restoreBlockedError({ event_type: "EDGE_CREATED" })).toMatchObject({ code: "unsupported", status: 422 });
    expect(restoreBlockedError({ event_type: "NODE_UPDATED" })).toBeNull();
  });
});
