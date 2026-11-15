// Offline creates still in the queue are unknown to the server, not revoked:
// a membership reconcile must leave their local rows alone (the queue stuck on
// its first write is the usual way to reach this). Once the create has been
// sent and the server still refuses to show it, the next reconcile removes it.
import { describe, expect, it, vi } from "vitest";
import { reconcileMembership, type MembershipPage, type ReconcileDeps } from "../lib/data/membershipReconcile";
import { pendingCreateIds, withoutPendingCreates, type TargetedWrite } from "../lib/pendingWriteTargets";

const T = "task-1", N = "note-1";
const createTask: TargetedWrite = { method: "POST", path: "/api/nodes/note-1/tasks", body: JSON.stringify({ id: T }) };
const createNote: TargetedWrite = { method: "POST", path: "/api/nodes", body: JSON.stringify({ id: N, title: "N", parent_id: "p" }) };
const editNote: TargetedWrite = { method: "PATCH", path: "/api/nodes/other", body: "{}" };
const attrOnNote: TargetedWrite = { method: "POST", path: "/api/nodes/other/attributes", body: "{}" };

describe("pendingCreateIds", () => {
  it("names entities whose create is queued, not ones merely edited", () => {
    expect([...pendingCreateIds([createTask, createNote, editNote, attrOnNote])].sort()).toEqual([N, T].sort());
  });
});

/** Same filter syncEngine's isolateRevoked applies. */
function reconcileWith(queue: TargetedWrite[], local: string[], readable: string[]) {
  const deleted: string[] = [];
  const page = async (): Promise<MembershipPage> => ({ ids: readable, next_cursor: null, epoch: 1, event_cursor: "1" });
  const deps: ReconcileDeps = {
    startEpoch: 1, fetchPage: page, getLocalKnown: async () => local,
    isolateRevoked: async (revoked) => {
      deleted.push(...withoutPendingCreates(revoked, queue));
    },
    fetchProjection: vi.fn(async (ids: string[], epoch: number) => ({ epoch, event_cursor: "1", nodes: ids.map((id) => ({ id })) as never,
      attributes: { upsert: [], delete: [] }, edges: [], tasks: [] })),
    applyProjection: async () => {}, saveEpoch: async () => {},
  };
  return reconcileMembership(deps).then(() => deleted);
}

describe("reconcile with queued offline creates", () => {
  it("keeps a queued task and note that the server does not know yet", async () => {
    expect(await reconcileWith([createTask, createNote], [T, N, "gone"], [])).toEqual(["gone"]);
  });
  it("removes them on the next reconcile once the creates were sent and are still unreadable", async () => {
    expect(await reconcileWith([], [T, N], [])).toEqual([T, N]);
  });
});
