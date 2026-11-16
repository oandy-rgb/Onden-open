// Restore registration (A3): a domain's inverse is registered through
// services/restoreContract.ts, and services/restoreHandlers.ts imports every
// registrant. eventRestore loads that module itself before its first restore
// or preview, so a restore never depends on some other import having loaded
// the domain first.

import { describe, it, expect, vi } from "vitest";
import type { ActorCtx } from "../types.js";

const actor: ActorCtx = { id: "restore-admin", name: "Restore admin", role: "admin", type: "human" };
const probeRow = {
  id: "1", workspace_id: "ws-1", event_type: "LAZY_PROBE", target_type: "probe", target_id: "p-1",
  payload: {}, tx_meta: {}, external: false,
};

// Write stamps (spine/stamps.ts) need the real node table; this file stands in for the database.
vi.mock("../spine/stamps.js", () => ({ stampTransaction: async () => {}, countWritesWithoutStamp: async () => 0 }));
vi.mock("../spine/currentActor.js", () => ({ resolveCurrentActor: async (a: ActorCtx) => a }));
// only the check is replaced; every other export (writesAsPerson, ...) stays real, so a new export does not break this file
vi.mock("../spine/authority.js", async (original) => ({ ...await original<typeof import("../spine/authority.js")>(), assertAuthority: vi.fn(async () => {}) }));
vi.mock("../spine/eventTransaction.js", () => ({
  withEventTransaction: async <T,>(_workspaceId: string, fn: () => Promise<T>): Promise<T> => fn(),
}));
vi.mock("../db.js", () => {
  const query = vi.fn(async (sql: string) => (/FROM domain_events/.test(sql) ? { rows: [probeRow], rowCount: 1 } : { rows: [], rowCount: 0 }));
  return {
    pool: { query }, q: query, event: vi.fn(async () => "500"),
    withTransaction: async <T,>(fn: () => Promise<T>): Promise<T> => fn(),
    inTransaction: () => true,
    bumpMembershipEpoch: async (): Promise<void> => {},
  };
});

// Stand-in registrant list: proves eventRestore loads restoreHandlers.ts on
// its own (nothing in this file imports it before the restore runs).
const probeRestore = vi.fn(async () => ({
  restored: true as const, original_event_id: "1", original_event_type: "LAZY_PROBE",
  restore_event_id: "500", restore_event_type: "LAZY_PROBE_UNDONE",
}));
vi.mock("../services/restoreHandlers.js", async () => {
  const { registerRestoreHandler } = await import("../services/restoreContract.js");
  registerRestoreHandler({
    eventTypes: ["LAZY_PROBE"],
    restore: probeRestore,
    preview: async () => ({ kind: "probe", can_apply_cleanly: true }),
  });
  return {};
});

describe("restore registration", () => {
  it("eventRestore loads the registrant list before its first restore", async () => {
    const { restoreEvent } = await import("../services/eventRestore/index.js");
    expect(await restoreEvent("1", { actor, workspaceId: "ws-1" })).toMatchObject({ restored: true, restore_event_type: "LAZY_PROBE_UNDONE" });
    expect(probeRestore).toHaveBeenCalledOnce();
  });

  it("every event type eventRestore leaves to a domain has a registered handler", async () => {
    await vi.importActual("../services/restoreHandlers.js");
    const { DOMAIN_RESTORED_EVENT_TYPES, registeredRestoreEventTypes, restoreHandlerFor } = await import("../services/restoreContract.js");
    expect(DOMAIN_RESTORED_EVENT_TYPES.length).toBeGreaterThan(0);
    for (const type of DOMAIN_RESTORED_EVENT_TYPES) expect(restoreHandlerFor(type), type).toBeDefined();
    // And nothing is registered that the list does not declare (the probe is
    // this file's stand-in).
    expect(registeredRestoreEventTypes().filter((t) => t !== "LAZY_PROBE").sort()).toEqual([...DOMAIN_RESTORED_EVENT_TYPES].sort());
  });
});
