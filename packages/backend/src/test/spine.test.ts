import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorCtx } from "../types.js";

// These tests isolate mutation wiring; persisted identity freshness is covered
// by actorWriteAuthority.integration.test.ts rather than scripted DB rows here.
// Write stamps (spine/stamps.ts) need the real node table; this file stands in for the database.
vi.mock("../spine/stamps.js", () => ({ stampTransaction: async () => {}, countWritesWithoutStamp: async () => 0 }));
vi.mock("../spine/currentActor.js", () => ({
  resolveCurrentActor: async (actor: ActorCtx) => actor,
}));

// Mock the db + permission layers the spine composes, so these tests exercise
// the spine's wiring (actor derivation, authority-before-apply, cascade
// inheritance) in isolation from a real database.
const m = vi.hoisted(() => ({
  event: vi.fn(async (..._args: unknown[]): Promise<string> => "evt-1"),
  withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  inTransaction: vi.fn(() => false),
  q: vi.fn(async () => ({ rows: [] as { tag_id: string }[], rowCount: 0 })),
  canActorOnNode: vi.fn(async () => true),
  canActorOnTag: vi.fn(async () => true),
}));

vi.mock("../db.js", () => ({
  event: m.event,
  withTransaction: m.withTransaction,
  inTransaction: m.inTransaction,
  q: m.q,
}));

import {
  mutate,
  requireActor,
  UnauthorizedError,
  AuthorityError,
  spineErrorStatus,
} from "../spine/mutate.js";
import { ScopeError } from "../spine/toolScope.js";

const human: ActorCtx = { id: "u1", name: "Ann", role: "admin", type: "human" };
const agent: ActorCtx = { id: "a1", name: "Bot", role: "editor", type: "agent" };

beforeEach(() => {
  vi.clearAllMocks();
  m.event.mockResolvedValue("evt-1");
  m.withTransaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  m.inTransaction.mockReturnValue(false);
  m.q.mockResolvedValue({ rows: [], rowCount: 0 });
  m.canActorOnNode.mockResolvedValue(true);
  m.canActorOnTag.mockResolvedValue(true);
});

describe("spine — requireActor", () => {
  it("throws on a missing actor, returns it otherwise", () => {
    expect(() => requireActor(null)).toThrow(UnauthorizedError);
    expect(requireActor(human)).toBe(human);
  });
});

describe("spine — mutate emits an attributed event", () => {
  it("always emits, with actor_type/id DERIVED from the actor (not passed)", async () => {
    const apply = vi.fn(async (ctx: { eventId: string }) => ({ ok: ctx.eventId }));
    const out = await mutate({
      actor: agent,
      workspaceId: "w",
      authority: { kind: "open", why: "test" },
      event: { type: "X", targetType: "node", targetId: "n1", payload: { a: 1 } },
      apply,
    });

    expect(out).toEqual({ ok: "evt-1" });
    expect(m.event).toHaveBeenCalledTimes(1);
    // event(ws, type, targetType, targetId, payload, actorType, actorId, opts)
    const args = m.event.mock.calls[0];
    expect(args[5]).toBe("ai_agent"); // agent → ai_agent, derived
    expect(args[6]).toBe("a1");
    expect(m.withTransaction).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ eventId: "evt-1" });
  });
});

describe("spine — authority is checked before apply", () => {
  it("principal_admin: anyone but the workspace owner is rejected, apply + event never run", async () => {
    // The owner lookup (isWorkspaceOwner) finds no row for this actor.
    const apply = vi.fn();
    await expect(
      mutate({
        actor: agent,
        workspaceId: "w",
        authority: { kind: "principal_admin" },
        event: { type: "X", targetType: "workspace", targetId: "w" },
        apply,
      }),
    ).rejects.toBeInstanceOf(AuthorityError);
    expect(apply).not.toHaveBeenCalled();
    expect(m.event).not.toHaveBeenCalled();
  });

  it("review: a member below the reviewer role who is not the owner is refused", async () => {
    const apply = vi.fn();
    await expect(
      mutate({
        actor: human,
        workspaceId: "w",
        authority: { kind: "review" },
        event: { type: "EVENT_APPROVED", targetType: "event", targetId: "e1" },
        apply,
      }),
    ).rejects.toBeInstanceOf(AuthorityError);
    expect(apply).not.toHaveBeenCalled();
  });

  it("any_space_write: an actor with no space it may write is refused; one with a space passes", async () => {
    const apply = vi.fn(async () => "ok");
    const create = () => mutate({
      actor: agent,
      workspaceId: "w",
      authority: { kind: "any_space_write" },
      event: { type: "CANVAS_CREATED", targetType: "canvas", targetId: "c1" },
      apply,
    });
    // No writable space (the lookup finds no row): refused before apply.
    await expect(create()).rejects.toBeInstanceOf(AuthorityError);
    expect(apply).not.toHaveBeenCalled();
    // The writable-space lookup finds a row.
    m.q.mockResolvedValue({ rows: [{ tag_id: "space-row" }], rowCount: 1 });
    await expect(create()).resolves.toBe("ok");
  });

  // Matter scope (scopedTagIds) and token tag scope were removed with spaces;
  // node writes are decided by the actor's role in the note's space.
  it("node: an actor without an editor role in the note's space cannot WRITE it → 403", async () => {
    // No space_members row matches (q returns no rows) → spaceCanWrite is false.
    m.q.mockResolvedValue({ rows: [], rowCount: 0 });
    const apply = vi.fn();
    const err = await mutate({
      actor: agent,
      workspaceId: "w",
      authority: { kind: "node", nodeId: "n1", op: "write_node" },
      event: { type: "NODE_UPDATED", targetType: "node", targetId: "n1" },
      apply,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthorityError);
    expect(spineErrorStatus(err)).toBe(403);
    expect(apply).not.toHaveBeenCalled();
    expect(m.event).not.toHaveBeenCalled();
  });

  it("principal_admin: a delegated token is rejected even when its agent sits in the owner role shorthand", async () => {
    const scopedAdmin: ActorCtx = {
      id: "a1", name: "Bot", role: "admin", type: "agent",
      tokenScope: { tokenId: "t", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
    };
    const apply = vi.fn();
    await expect(
      mutate({
        actor: scopedAdmin, // …but it came from a bearer token → cannot redefine permissions
        workspaceId: "w",
        authority: { kind: "principal_admin" },
        event: { type: "TOKEN_CREATED", targetType: "token", targetId: "tok" },
        apply,
      }),
    ).rejects.toBeInstanceOf(AuthorityError);
    expect(apply).not.toHaveBeenCalled();
    expect(m.event).not.toHaveBeenCalled();
  });

  it("principal_admin: the owner passes even as a type='agent' System actor (no tokenScope) — never locked out", async () => {
    // The owner lookup (isWorkspaceOwner) finds this actor's row.
    m.q.mockResolvedValue({ rows: [{ tag_id: "owner-row" }], rowCount: 1 });
    const nativeOwner: ActorCtx = { id: "system", name: "System", role: "admin", type: "agent" }; // no tokenScope
    const apply = vi.fn().mockResolvedValue(undefined);
    await mutate({
      actor: nativeOwner,
      workspaceId: "w",
      authority: { kind: "principal_admin" },
      event: { type: "ACTOR_CREATED", targetType: "actor", targetId: "x" },
      apply,
    });
    expect(apply).toHaveBeenCalled();
  });
});

describe("spine — timing:after (DB-generated ids)", () => {
  it("runs apply first, then emits with targetId resolved from the result", async () => {
    const apply = vi.fn(async () => ({ id: "db-minted-id" }));
    const out = await mutate({
      actor: human,
      workspaceId: "w",
      authority: { kind: "open", why: "test" },
      timing: "after",
      event: { type: "EDGE_CREATED", targetType: "edge", targetId: (r: { id: string }) => r.id },
      apply,
    });

    expect(out).toEqual({ id: "db-minted-id" });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(m.event).toHaveBeenCalledTimes(1);
    expect(m.event.mock.calls[0][3]).toBe("db-minted-id"); // targetId came from the result
  });
});

describe("spine — cascade safety", () => {
  it("nested mutate inherits the ROOT actor and links via triggered_by", async () => {
    m.event.mockResolvedValueOnce("evt-outer").mockResolvedValueOnce("evt-inner");

    // A behaviour firing inside apply(), claiming to be the agent — the spine
    // must ignore the claim and attribute to the human root.
    const behaviour = () =>
      mutate({
        actor: agent,
        workspaceId: "w",
        authority: { kind: "open", why: "behaviour" },
        event: { type: "DERIVED", targetType: "node", targetId: "n2" },
        apply: async () => "inner-done",
      });

    await mutate({
      actor: human,
      workspaceId: "w",
      authority: { kind: "open", why: "root" },
      event: { type: "ROOT", targetType: "node", targetId: "n1" },
      apply: async () => behaviour(),
    });

    expect(m.event).toHaveBeenCalledTimes(2);
    const inner = m.event.mock.calls[1];
    expect(inner[5]).toBe("user"); // inherited HUMAN root, not the claimed agent
    expect(inner[6]).toBe("u1");
    expect((inner[7] as { triggeredBy?: string }).triggeredBy).toBe("evt-outer");
    // The cascade reuses the root transaction — no second client opened.
    expect(m.withTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("spine — error mapping", () => {
  it("maps spine errors to HTTP status, passes others through", () => {
    expect(spineErrorStatus(new UnauthorizedError())).toBe(401);
    expect(spineErrorStatus(new AuthorityError("role", "x"))).toBe(403);
    expect(spineErrorStatus(new ScopeError("tag_not_allowed", "x"))).toBe(403);
    expect(spineErrorStatus(new Error("other"))).toBeNull();
  });
});
