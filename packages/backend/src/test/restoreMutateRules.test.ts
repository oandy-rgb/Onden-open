// A restore's inverse events are written by the same gate as every other
// write (spine mutate, via runRestore + mutateRestore), so the rules that gate
// owns hold for them too:
//   - actor_type / actor_id are derived from the CURRENT actor, never passed;
//   - the membership epoch is bumped in the same transaction exactly when the
//     write declares affectsMembership;
//   - the restore's provenance (triggered_by, restored_from) is added by the
//     gate, and the unit cannot be entered without runRestore.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorCtx } from "../types.js";

const stale: ActorCtx = { id: "agent-1", name: "Bot", type: "agent" };
const current: ActorCtx = { id: "agent-1", name: "Bot", type: "agent" };

// Write stamps (spine/stamps.ts) need the real node table; this file stands in for the database.
vi.mock("../spine/stamps.js", () => ({ stampTransaction: async () => {}, countWritesWithoutStamp: async () => 0 }));
vi.mock("../spine/currentActor.js", () => ({
  resolveCurrentActor: vi.fn(async () => current),
}));

type EmitOpts = { triggeredBy?: string; txMeta?: Record<string, unknown> };
const emits: Array<{ actorType: string; actorId: string; opts?: EmitOpts }> = [];
const bump = vi.fn(async (_workspaceId: string) => {});
vi.mock("../db.js", () => ({
  q: vi.fn(async () => ({ rows: [], rowCount: 1 })),
  event: vi.fn(async (
    _ws: string, _type: string, _tt: string, _tid: string, _payload: unknown,
    actorType: string, actorId: string, opts?: EmitOpts,
  ) => { emits.push({ actorType, actorId, opts }); return String(emits.length); }),
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  withSavepoint: (fn: () => Promise<unknown>) => fn(),
  inTransaction: () => false,
  bumpMembershipEpoch: (workspaceId: string) => bump(workspaceId),
}));

const { mutate, mutateRestore, runRestore } = await import("../spine/mutate.js");

const WS = "ws-1";
const original = { id: "7", workspace_id: WS };
const restoreEvent = { type: "NODE_UPDATED", targetType: "node", targetId: "n1", payload: {}, txMeta: { inverse_op: "x" } };

beforeEach(() => {
  emits.length = 0;
  bump.mockClear();
});

describe("restore events follow mutate's rules", () => {
  it("derives actor_type from the current actor, the same as an ordinary mutate", async () => {
    await mutate({
      actor: current, workspaceId: WS, authority: { kind: "open", why: "test" },
      event: { type: "NODE_UPDATED", targetType: "node", targetId: "n1" },
      apply: async () => undefined,
    });
    await runRestore({ actor: stale, workspaceId: WS }, () =>
      mutateRestore({ actor: stale, original, event: restoreEvent, apply: async () => undefined }));

    expect(emits).toHaveLength(2);
    expect(emits[1]).toMatchObject({ actorType: emits[0]!.actorType, actorId: emits[0]!.actorId });
    expect(emits[1]!.actorType).toBe("ai_agent");
  });

  it("attributes the event to the actor runRestore resolved, not the one passed", async () => {
    const { resolveCurrentActor } = await import("../spine/currentActor.js");
    vi.mocked(resolveCurrentActor).mockResolvedValueOnce({ id: "someone-else", name: "S", type: "human" });
    await runRestore({ actor: stale, workspaceId: WS }, () =>
      mutateRestore({ actor: stale, original, event: restoreEvent, apply: async () => undefined }));
    expect(emits[0]).toMatchObject({ actorType: "user", actorId: "someone-else" });
  });

  it("bumps the membership epoch exactly when the write declares affectsMembership", async () => {
    const run = (affectsMembership?: boolean) => runRestore({ actor: current, workspaceId: WS }, () =>
      mutateRestore({ actor: current, original, event: restoreEvent, affectsMembership, apply: async () => undefined }));
    await run();
    await run(false);
    expect(bump).not.toHaveBeenCalled();
    await run(true);
    expect(bump).toHaveBeenCalledTimes(1);
    expect(bump).toHaveBeenCalledWith(WS);

    // The ordinary gate bumps by the same declaration.
    bump.mockClear();
    await mutate({
      actor: current, workspaceId: WS, authority: { kind: "open", why: "test" },
      event: { type: "NODE_UPDATED", targetType: "node", targetId: "n1" },
      affectsMembership: true, apply: async () => undefined,
    });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it("adds the restore provenance and links triggered_by to the original event", async () => {
    await runRestore({ actor: current, workspaceId: WS }, () =>
      mutateRestore({ actor: current, original, event: restoreEvent, apply: async () => undefined }));
    expect(emits[0]!.opts).toMatchObject({
      triggeredBy: "7",
      txMeta: { inverse_op: "x", restored_from: "7", ui_context: "event.restore" },
    });
  });

  it("refuses to write a restore event outside runRestore, and emits nothing", async () => {
    await expect(
      mutateRestore({ actor: current, original, event: restoreEvent, apply: async () => undefined }),
    ).rejects.toMatchObject({ name: "AuthorityError", reason: "cascade" });
    expect(emits).toHaveLength(0);
  });
});
