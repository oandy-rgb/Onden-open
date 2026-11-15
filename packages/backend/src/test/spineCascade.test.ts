// Spine cascade keystone (P3.2): the by-construction guarantees that let the
// dispatcher route its child writes through mutate() without re-opening an
// authorization hole.
//
//   1. {kind:"cascade"} authority is UNUSABLE as a root — mutate() throws. So it
//      can never be a universal "skip the check" bypass.
//   2. runCascade() is the only authority-checked way to enter a cascade from
//      outside a root mutate: it asserts the real gate, and only then opens the
//      store that {kind:"cascade"} children inherit.
//   3. Inside the store, a child's event inherits the root actor and points
//      triggered_by at the cascade's cause.
//   4. An explicit event.triggeredBy overrides the ambient store (how a rooting
//      TAG_APPLIED links to the upstream user event).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorCtx } from "../types.js";

// Exercise cascade attribution independently of persisted actor lookup; the
// current actor/token contract has real-DB coverage in actorWriteAuthority.
// Write stamps (spine/stamps.ts) need the real node table; this file stands in for the database.
vi.mock("../spine/stamps.js", () => ({ stampTransaction: async () => {}, countWritesWithoutStamp: async () => 0 }));
vi.mock("../spine/currentActor.js", () => ({
  resolveCurrentActor: async (actor: ActorCtx) => actor,
}));

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number };

// The only lookup the review gate makes is "is this actor the workspace
// owner" (spine/authority.ts isWorkspaceOwner): ADMIN is, nobody else is.
const q = vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>(
  async (sql, params) => sql.includes("owner_actor_id") && params?.[0] === "root-owner"
    ? { rows: [{}], rowCount: 1 }
    : { rows: [], rowCount: 1 },
);

type EmitOpts = { triggeredBy?: string; txMeta?: Record<string, unknown>; external?: boolean };
const emits: Array<{ type: string; actorType: string; actorId: string; opts?: EmitOpts; id: string }> = [];
let nextId = 1;
const event = vi.fn(async (
  _ws: string, type: string, _tt: string, _tid: string,
  _payload?: Record<string, unknown>, actorType?: string, actorId?: string, opts?: EmitOpts,
): Promise<string> => {
  const id = String(nextId++);
  emits.push({ type, actorType: actorType ?? "", actorId: actorId ?? "", opts, id });
  return id;
});

vi.mock("../db.js", () => ({
  q,
  event,
  // Identity tx: the keystone logic, not durability, is under test here.
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  withSavepoint: (fn: () => Promise<unknown>) => fn(),
  inTransaction: () => false,
  bumpMembershipEpoch: vi.fn(async () => {}),
}));

let spine: typeof import("../spine/mutate.js");

const ADMIN: ActorCtx = { id: "root-owner", name: "Root", type: "human" }; // the workspace owner
const VIEWER: ActorCtx = { id: "low", name: "Low", type: "human" }; // a plain member
const WS = "ws-1";

beforeEach(async () => {
  emits.length = 0;
  nextId = 1;
  q.mockClear();
  event.mockClear();
  spine = await import("../spine/mutate.js");
});

describe("spine cascade keystone", () => {
  it("rejects {kind:'cascade'} authority used as a root (no enclosing cascade)", async () => {
    await expect(
      spine.mutate({
        actor: ADMIN, workspaceId: WS, authority: { kind: "cascade" },
        event: { type: "ATTRIBUTE_SET", targetType: "node", targetId: "n1" },
        apply: async () => undefined,
      }),
    ).rejects.toMatchObject({ name: "AuthorityError", reason: "cascade" });
    // The hole that would exist if the skip were reachable as a root: NO event
    // may have been emitted.
    expect(emits).toHaveLength(0);
  });

  it("runCascade asserts the gate BEFORE running the body", async () => {
    const body = vi.fn(async () => "ran");
    await expect(
      spine.runCascade(
        { actor: VIEWER, workspaceId: WS, authority: { kind: "review" }, causeEventId: "42" },
        body,
      ),
    ).rejects.toMatchObject({ name: "AuthorityError" });
    expect(body).not.toHaveBeenCalled();
  });

  it("a cascade child inherits the root actor and points triggered_by at the cause", async () => {
    await spine.runCascade(
      { actor: ADMIN, workspaceId: WS, authority: { kind: "review" }, causeEventId: "cause-7" },
      async () => {
        await spine.mutate({
          // A child may CLAIM a different actor; the spine ignores it and uses
          // the cascade root — a behaviour can't act as someone else.
          actor: VIEWER, workspaceId: WS, authority: { kind: "cascade" },
          event: { type: "ATTRIBUTE_SET", targetType: "node", targetId: "n1" },
          apply: async () => undefined,
        });
      },
    );
    expect(emits).toHaveLength(1);
    expect(emits[0]!.type).toBe("ATTRIBUTE_SET");
    expect(emits[0]!.actorId).toBe(ADMIN.id); // root, not the claimed VIEWER
    expect(emits[0]!.opts?.triggeredBy).toBe("cause-7");
  });

  it("explicit event.triggeredBy overrides the ambient cascade cause", async () => {
    await spine.runCascade(
      { actor: ADMIN, workspaceId: WS, authority: { kind: "review" }, causeEventId: "ambient" },
      async () => {
        await spine.mutate({
          actor: ADMIN, workspaceId: WS, authority: { kind: "cascade" },
          event: { type: "TAG_APPLIED", targetType: "node", targetId: "n1", triggeredBy: "explicit" },
          apply: async () => undefined,
        });
      },
    );
    expect(emits[0]!.opts?.triggeredBy).toBe("explicit");
  });

  it("runCascade with an undefined cause still opens the store (children carry no triggered_by)", async () => {
    await spine.runCascade(
      { actor: ADMIN, workspaceId: WS, authority: { kind: "open", why: "test" }, causeEventId: undefined },
      async () => {
        await spine.mutate({
          actor: ADMIN, workspaceId: WS, authority: { kind: "cascade" },
          event: { type: "ATTRIBUTE_SET", targetType: "node", targetId: "n1" },
          apply: async () => undefined,
        });
      },
    );
    expect(emits).toHaveLength(1);
    expect(emits[0]!.opts?.triggeredBy).toBeUndefined();
  });
});
