import { bindAccountStorage } from "../lib/accountStorage";
import { describe, it, expect, vi, beforeEach } from "vitest";

// P2/P0-4 interaction: a server REJECTION (4xx) must never poison the offline
// queue, must roll back the optimistic update, and must tell the user why.

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: apiMock }; // real ApiError class, mocked transport
});
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  addPendingWrite: vi.fn(async () => null),
  getPendingWrites: vi.fn(async () => []),
  upsertAttribute: vi.fn(async () => null),
  removeAttribute: vi.fn(async () => null),
  upsertTask: vi.fn(async () => null),
  removeTask: vi.fn(async () => null),
  getNodeAttributeRecord: vi.fn(async () => null),
  upsertEdge: vi.fn(async () => null),
  removeEdge: vi.fn(async () => null),
  upsertNode: vi.fn(async () => null),
  removeNode: vi.fn(async () => null),
}));

import { ApiError, type Bootstrap } from "../lib/api";
import { noWorkspaceData } from "../lib/api";
import { addPendingWrite } from "../lib/localDb";
import { sendOrQueue } from "../lib/data/writeQueue";
import { setPending, getPendingCount } from "../lib/data/syncStatus";
import { makeTaskWriter } from "../lib/data/taskWriter";
import { makeTagWriter } from "../lib/data/tagWriter";
import { makeRelationWriter } from "../lib/data/relationWriter";
import { makePropertyWriter } from "../lib/data/propertyWriter";
import type { DataCtx } from "../lib/data/types";

const writers = (ctx: DataCtx) => ({
  tasks: makeTaskWriter(ctx), tags: makeTagWriter(ctx), relations: makeRelationWriter(ctx), properties: makePropertyWriter(ctx),
});
import { makeNodeMutations } from "../lib/data/nodeMutations";

// Minimal mutation ctx: a local `state` cell + a setData that reassigns it.
function harness(initial: Bootstrap) {
  let state = initial;
  const setData = (u: Bootstrap | ((p: Bootstrap) => Bootstrap)) => {
    state = typeof u === "function" ? (u as (p: Bootstrap) => Bootstrap)(state) : u;
  };
  const ctx = {
    get data() { return state; }, setData: setData as never, online: true, addToast: vi.fn(),
    scheduleUserFolderSync: () => {}, refresh: async () => {},
  };
  return { ctx, get: () => state };
}
const edge = (id: string) => ({ id, source_node_id: "a", target_node_id: "b", edge_type: "knowledge_link" as const, status: "active" as const });

const reject422 = () => Promise.reject(new ApiError(422, JSON.stringify({ error: "field_invalid", detail: '"rating" must be a number' })));
const fail500 = () => Promise.reject(new ApiError(500, "internal"));

describe("write rejection posture", () => {
  beforeEach(() => {
    apiMock.mockReset();
    vi.mocked(addPendingWrite).mockClear();
    setPending(0);
  });

  it("sendOrQueue: 4xx rethrows (never queued); 5xx queues", async () => {
    apiMock.mockImplementationOnce(reject422);
    await expect(sendOrQueue("PUT", "/api/x", "{}")).rejects.toMatchObject({ status: 422 });
    expect(addPendingWrite).not.toHaveBeenCalled();
    expect(getPendingCount()).toBe(0);

    apiMock.mockImplementationOnce(fail500);
    await expect(sendOrQueue("PUT", "/api/x", "{}")).resolves.toBeUndefined();
    expect(addPendingWrite).toHaveBeenCalledTimes(1);
    expect(getPendingCount()).toBe(1);
  });

  it("upsertAttribute: 422 rolls the optimistic value back and toasts the readable reason", async () => {
    apiMock.mockImplementationOnce(reject422);
    let state: Bootstrap = {
      ...noWorkspaceData,
      nodes: [{ id: "n1", title: "N", slug: "n", markdown: "", source_type: "manual", node_type: "content", attrs: { rating: "3" } }],
    };
    const setData = (updater: Bootstrap | ((p: Bootstrap) => Bootstrap)) => {
      state = typeof updater === "function" ? updater(state) : updater;
    };
    const addToast = vi.fn();
    const m = writers({
      get data() { return state; }, setData: setData as never, online: true, addToast,
      scheduleUserFolderSync: () => {}, refresh: async () => {},
    });
    await expect(m.properties.set("n1", "rating", "not-a-number")).rejects.toMatchObject({ status: 422 });
    expect(state.nodes[0]!.attrs?.rating).toBe("3"); // rolled back
    expect(addToast).not.toHaveBeenCalled(); // the recovery entry shows the reason
    expect(addPendingWrite).not.toHaveBeenCalled();
  });

  it("removeAttribute: 422 (required field) restores the value and toasts", async () => {
    apiMock.mockImplementationOnce(() => Promise.reject(new ApiError(422, JSON.stringify({ error: "field_required", detail: '"status" is required by an applied tag' }))));
    let state: Bootstrap = {
      ...noWorkspaceData,
      nodes: [{ id: "n1", title: "N", slug: "n", markdown: "", source_type: "manual", node_type: "content", attrs: { status: "todo" } }],
    };
    const setData = (updater: Bootstrap | ((p: Bootstrap) => Bootstrap)) => {
      state = typeof updater === "function" ? updater(state) : updater;
    };
    const addToast = vi.fn();
    const m = writers({
      get data() { return state; }, setData: setData as never, online: true, addToast,
      scheduleUserFolderSync: () => {}, refresh: async () => {},
    });
    await expect(m.properties.remove("n1", "status")).rejects.toMatchObject({ status: 422 });
    expect(state.nodes[0]!.attrs?.status).toBe("todo"); // restored
    expect(addToast).toHaveBeenCalledWith('"status" is required by an applied tag', "error");
  });

  // Finding #1: online mutations must go through sendOrQueue — idempotency key on
  // the FIRST attempt, and a TRANSIENT (5xx/network) failure QUEUES instead of
  // rolling back (a commit-but-lost-response must not be wrongly reverted). Only a
  // terminal 4xx rolls the optimistic change back.

  it("task status change: a transient 5xx keeps the flip + queues it with an idempotency key", async () => {
    apiMock.mockImplementationOnce(fail500);
    const h = harness({ ...noWorkspaceData, tasks: [{ id: "tk1", node_id: "n1", title: "T", status: "todo" }] });
    await writers(h.ctx).tasks.patch("tk1", { status: "done" });
    expect(h.get().tasks[0]!.status).toBe("done");        // optimistic flip kept
    expect(addPendingWrite).toHaveBeenCalledTimes(1);     // queued for the drain
    const init = apiMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toEqual(expect.any(String));
  });

  it("task status change: a terminal 4xx rolls the flip back and never queues", async () => {
    apiMock.mockImplementationOnce(reject422);
    const h = harness({ ...noWorkspaceData, tasks: [{ id: "tk1", node_id: "n1", title: "T", status: "todo" }] });
    await expect(writers(h.ctx).tasks.patch("tk1", { status: "done" })).rejects.toMatchObject({ status: 422 });
    expect(h.get().tasks[0]!.status).toBe("todo");        // rolled back
    expect(addPendingWrite).not.toHaveBeenCalled();
  });

  it("deleteEdge: a transient 5xx keeps it deleted + queues it (no wrong restore)", async () => {
    apiMock.mockImplementationOnce(fail500);
    const h = harness({ ...noWorkspaceData, edges: [edge("e1")] });
    await writers(h.ctx).relations.remove("e1");
    expect(h.get().edges.map((e) => e.id)).toEqual([]);   // stays deleted
    expect(addPendingWrite).toHaveBeenCalledTimes(1);
  });

  it("deleteEdge: a terminal 4xx restores the edge", async () => {
    apiMock.mockImplementationOnce(reject422);
    const h = harness({ ...noWorkspaceData, edges: [edge("e1")] });
    await expect(writers(h.ctx).relations.remove("e1")).rejects.toMatchObject({ status: 422 });
    expect(h.get().edges.map((e) => e.id)).toEqual(["e1"]); // restored
    expect(addPendingWrite).not.toHaveBeenCalled();
  });

  it("deleteNode: a transient 5xx keeps it deleted + queues it (no restore of a server-deleted node)", async () => {
    apiMock.mockImplementationOnce(fail500);
    const h = harness({ ...noWorkspaceData, nodes: [{ id: "n1", title: "N", slug: "n", markdown: "", source_type: "manual", node_type: "content" }] });
    await makeNodeMutations(h.ctx).deleteNode("n1", "N");
    expect(h.get().nodes.map((n) => n.id)).toEqual([]);   // stays deleted (drains later)
    expect(addPendingWrite).toHaveBeenCalledTimes(1);
  });

  it("deleteNode: a terminal 4xx restores the node", async () => {
    apiMock.mockImplementationOnce(reject422);
    const h = harness({ ...noWorkspaceData, nodes: [{ id: "n1", title: "N", slug: "n", markdown: "", source_type: "manual", node_type: "content" }] });
    await makeNodeMutations(h.ctx).deleteNode("n1", "N");
    expect(h.get().nodes.map((n) => n.id)).toEqual(["n1"]); // restored
    expect(addPendingWrite).not.toHaveBeenCalled();
  });

  it("deleteNode: a reserved tag is refused before any write or optimistic drop (T1)", async () => {
    const tag = { id: "t-task", title: "Tasks", slug: "tasks", markdown: "", source_type: "manual" as const, node_type: "class_tag" as const };
    const h = harness({ ...noWorkspaceData, nodes: [tag], tags: [{ id: "t-task", name: "Tasks", reserved_key: "task", color: "", schema_id: null }] });
    expect(await makeNodeMutations(h.ctx).deleteNode("t-task", "Tasks")).toBe(false);
    expect(h.get().nodes.map((n) => n.id)).toEqual(["t-task"]);
    expect(apiMock).not.toHaveBeenCalled();
    expect(addPendingWrite).not.toHaveBeenCalled();
    expect(h.ctx.addToast).toHaveBeenCalledWith(expect.stringContaining("System tag"), "error");
  });

  it("ApiError extracts the readable detail from the {error, detail} convention", () => {
    const e = new ApiError(422, JSON.stringify({ error: "field_invalid", detail: "nope" }));
    expect(e.message).toBe("nope");
    expect(e.code).toBe("field_invalid");
    // A body that is not the {error, detail} convention is never shown as sent.
    expect(new ApiError(500, "plain text").message).toBe("Something went wrong on the server.");
  });
});

beforeEach(() => { bindAccountStorage("unit-test-account", ""); });
