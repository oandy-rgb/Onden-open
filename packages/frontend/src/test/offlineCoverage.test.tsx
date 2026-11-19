import { bindAccountStorage } from "../lib/accountStorage";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Offline-coverage: the everyday writes the product review flagged
// ("並非所有寫入都支援離線") must, when offline, (1) NOT throw, (2) queue a
// pending_write so the reconnect drain can replay it, and (3) mirror
// optimistically so the UI reflects the change immediately. When online they
// must still reach the network. Mirrors writeRejection.test.tsx's harness.

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: apiMock }; // real ApiError, mocked transport
});
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  addPendingWrite: vi.fn(async () => null),
  getPendingWrites: vi.fn(async () => []),
  upsertWorkspace: vi.fn(async () => null),
  upsertNode: vi.fn(async () => null),
  removeNode: vi.fn(async () => null),
  upsertEdge: vi.fn(async () => null),
  removeEdge: vi.fn(async () => null),
  upsertTask: vi.fn(async () => null),
  removeTask: vi.fn(async () => null),
  getNodeAttributeRecord: vi.fn(async () => null),
  upsertAttribute: vi.fn(async () => null),
  removeAttribute: vi.fn(async () => null),
  upsertCanvas: vi.fn(async () => null),
  removeCanvas: vi.fn(async () => null),
  loadCanvas: vi.fn(async () => null),
  loadCanvases: vi.fn(async () => []),
}));

import { type Bootstrap, type Canvas, noWorkspaceData, ApiError } from "../lib/api";
import { addPendingWrite, upsertTask, upsertNode, removeNode, upsertCanvas, removeCanvas, loadCanvas } from "../lib/localDb";
import { setPending } from "../lib/data/syncStatus";
import { makeTaskWriter } from "../lib/data/taskWriter";
import { makeTagWriter } from "../lib/data/tagWriter";
import { makeRelationWriter } from "../lib/data/relationWriter";
import { makePropertyWriter } from "../lib/data/propertyWriter";
import type { DataCtx } from "../lib/data/types";

const writers = (ctx: DataCtx) => ({
  tasks: makeTaskWriter(ctx), tags: makeTagWriter(ctx), relations: makeRelationWriter(ctx), properties: makePropertyWriter(ctx),
});
import { makeNodeMutations } from "../lib/data/nodeMutations";
import { makeCanvasWriter } from "../lib/data/canvasWriter";
import { canvasList } from "../lib/canvasList";

function makeStore(initial: Bootstrap) {
  let state = initial;
  const setData = (u: Bootstrap | ((p: Bootstrap) => Bootstrap)) => {
    state = typeof u === "function" ? (u as (p: Bootstrap) => Bootstrap)(state) : u;
  };
  return { get: () => state, setData };
}

const baseNode = {
  id: "n1", title: "N", slug: "n", markdown: "# N\n", source_type: "manual" as const,
  node_type: "content" as const,
};
const tagNode = {
  id: "t1", title: "toread", slug: "toread", markdown: "", source_type: "manual" as const,
  node_type: "class_tag" as const,
};

function bootstrapWith(nodes: Bootstrap["nodes"]): Bootstrap {
  return { ...noWorkspaceData, nodes };
}

beforeEach(() => {
  apiMock.mockReset();
  vi.mocked(addPendingWrite).mockClear();
  vi.mocked(upsertTask).mockClear();
  vi.mocked(upsertNode).mockClear();
  vi.mocked(removeNode).mockClear();
  vi.mocked(upsertCanvas).mockClear();
  vi.mocked(removeCanvas).mockClear();
  vi.mocked(loadCanvas).mockReset();
  setPending(0);
});

describe("domain writer offline coverage", () => {
  it("addTask offline: queues the POST with a CLIENT-MINTED id + mirrors an optimistic task (stable id, no dup)", async () => {
    const store = makeStore(bootstrapWith([{ ...baseNode }]));
    const m = writers({
      get data() { return store.get(); }, setData: store.setData as never, online: false,
      addToast: vi.fn(), scheduleUserFolderSync: () => {}, refresh: async () => {},
    });
    await expect(m.tasks.create("n1", "buy milk")).resolves.toEqual({ status: "queued" });
    expect(store.get().tasks).toHaveLength(1);
    const task = store.get().tasks[0]!;
    expect(task.title).toBe("buy milk");
    // The queued POST carries the SAME client-minted id as the optimistic task,
    // and reuses it as the idempotency key — so the drain + the next /api/sync
    // delta reconcile the SAME row by id, never showing a server-minted dup.
    const call = vi.mocked(addPendingWrite).mock.calls.find((c) => c[1] === "/api/nodes/n1/tasks");
    expect(call, "the offline task create was queued").toBeTruthy();
    expect(call![0]).toBe("POST");
    expect(JSON.parse(call![2] as string)).toEqual({ id: task.id, title: "buy milk" });
    expect(call![3]).toBe(task.id); // idempotency key === the client-minted node id
    expect(upsertTask).toHaveBeenCalled();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("addTask online: sends the POST and mirrors the server task", async () => {
    const serverTask = { id: "srv", node_id: "n1", title: "buy milk", status: "todo" };
    apiMock.mockResolvedValueOnce(serverTask);
    const store = makeStore(bootstrapWith([{ ...baseNode }]));
    const m = writers({
      get data() { return store.get(); }, setData: store.setData as never, online: true,
      addToast: vi.fn(), scheduleUserFolderSync: () => {}, refresh: async () => {},
    });
    await m.tasks.create("n1", "buy milk");
    expect(apiMock).toHaveBeenCalledWith("/api/nodes/n1/tasks", expect.objectContaining({ method: "POST" }));
    expect(store.get().tasks[0]!.id).toBe("srv");
    expect(addPendingWrite).not.toHaveBeenCalled();
  });

  it("applyTag offline: queues PUT + mirrors membership (label tag → label_tag_ids)", async () => {
    const store = makeStore(bootstrapWith([{ ...baseNode }, { ...tagNode }]));
    const m = writers({
      get data() { return store.get(); }, setData: store.setData as never, online: false,
      addToast: vi.fn(), scheduleUserFolderSync: () => {}, refresh: async () => {},
    });
    await expect(m.tags.apply("n1", "t1")).resolves.toEqual({ status: "queued" });
    expect(addPendingWrite).toHaveBeenCalledWith("PUT", "/api/nodes/n1/tags/t1", "{}", expect.anything());
    const node = store.get().nodes.find((n) => n.id === "n1")!;
    expect(node.label_tag_ids).toContain("t1");
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("applyTag online: sends the PUT", async () => {
    apiMock.mockResolvedValueOnce(undefined);
    const store = makeStore(bootstrapWith([{ ...baseNode }, { ...tagNode }]));
    const m = writers({
      get data() { return store.get(); }, setData: store.setData as never, online: true,
      addToast: vi.fn(), scheduleUserFolderSync: () => {}, refresh: async () => {},
    });
    await m.tags.apply("n1", "t1");
    expect(apiMock).toHaveBeenCalledWith("/api/nodes/n1/tags/t1", expect.objectContaining({ method: "PUT" }));
    expect(addPendingWrite).not.toHaveBeenCalled();
  });

  it("removeTag offline: queues DELETE + drops membership", async () => {
    const store = makeStore(bootstrapWith([{ ...baseNode, label_tag_ids: ["t1"] }, { ...tagNode }]));
    const m = writers({
      get data() { return store.get(); }, setData: store.setData as never, online: false,
      addToast: vi.fn(), scheduleUserFolderSync: () => {}, refresh: async () => {},
    });
    await m.tags.remove("n1", "t1");
    expect(addPendingWrite).toHaveBeenCalledWith("DELETE", "/api/nodes/n1/tags/t1", null, expect.anything());
    expect(store.get().nodes.find((n) => n.id === "n1")!.label_tag_ids).not.toContain("t1");
  });

  it("createTag offline: queues POST /api/tags with a CLIENT-MINTED id + optimistically inserts the tag (node + Tag row)", async () => {
    const store = makeStore(bootstrapWith([{ ...baseNode }]));
    const m = writers({
      get data() { return store.get(); }, setData: store.setData as never, online: false,
      addToast: vi.fn(), scheduleUserFolderSync: () => {}, refresh: async () => {},
    });
    const r = await m.tags.create("physics");
    expect(r.queued).toBe(true);
    // Optimistic DUAL insert — the schema lens needs both the class_tag node…
    const node = store.get().nodes.find((n) => n.id === r.id);
    expect(node?.node_type).toBe("class_tag");
    expect(node?.title).toBe("physics");
    // …and the Tag row.
    const tg = (store.get().tags ?? []).find((x) => x.id === r.id);
    expect(tg?.name).toBe("physics");
    // Queued with the client id in the body AND reused as the idempotency key.
    const call = vi.mocked(addPendingWrite).mock.calls.find((c) => c[1] === "/api/tags");
    expect(call, "the offline tag create was queued").toBeTruthy();
    expect(call![0]).toBe("POST");
    expect(JSON.parse(call![2] as string)).toEqual({ id: r.id, name: "physics" });
    expect(call![3]).toBe(r.id);
    expect(upsertNode).toHaveBeenCalled();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("createTag online: sends POST /api/tags (not the owner-only pack import) and returns queued=false", async () => {
    apiMock.mockResolvedValueOnce({ id: "srv-echo", name: "physics", color: "#888888" });
    const store = makeStore(bootstrapWith([{ ...baseNode }]));
    const refresh = vi.fn(async () => {});
    const m = writers({
      get data() { return store.get(); }, setData: store.setData as never, online: true,
      addToast: vi.fn(), scheduleUserFolderSync: () => {}, refresh,
    });
    const r = await m.tags.create("physics");
    expect(r.queued).toBe(false);
    expect(apiMock).toHaveBeenCalledWith("/api/tags", expect.objectContaining({ method: "POST" }));
    expect(apiMock).not.toHaveBeenCalledWith("/api/tags/import", expect.anything());
    expect(addPendingWrite).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled(); // reconcile with server truth
  });

  it("createTag 4xx (name conflict / read-only): rolls the optimistic tag back and rethrows", async () => {
    apiMock.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: "tag_name_conflict" })));
    const store = makeStore(bootstrapWith([{ ...baseNode }]));
    const m = writers({
      get data() { return store.get(); }, setData: store.setData as never, online: true,
      addToast: vi.fn(), scheduleUserFolderSync: () => {}, refresh: async () => {},
    });
    await expect(m.tags.create("physics")).rejects.toBeInstanceOf(ApiError);
    // Optimistic tag fully removed (node + Tag row) — no phantom class_tag left behind.
    expect(store.get().nodes.some((n) => n.node_type === "class_tag")).toBe(false);
    expect((store.get().tags ?? []).length).toBe(0);
    expect(addPendingWrite).not.toHaveBeenCalled(); // a 4xx is never queued
  });

  it("createTag refuses a name with \"/\" before writing anything, reported once", async () => {
    const store = makeStore(bootstrapWith([{ ...baseNode }]));
    const addToast = vi.fn();
    const m = writers({
      get data() { return store.get(); }, setData: store.setData as never, online: true,
      addToast, scheduleUserFolderSync: () => {}, refresh: async () => {},
    });
    await expect(m.tags.create("course/week1")).rejects.toThrow(/nested tag/);
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(store.get().nodes.some((n) => n.node_type === "class_tag")).toBe(false);
    expect(apiMock).not.toHaveBeenCalled();
    expect(addPendingWrite).not.toHaveBeenCalled();
  });
});

describe("nodeMutations offline coverage", () => {
  function ctx(store: ReturnType<typeof makeStore>, online: boolean) {
    return {
      get data() { return store.get(); }, setData: store.setData as never, online,
      addToast: vi.fn(), scheduleUserFolderSync: () => {}, refresh: async () => {},
    };
  }

  it("duplicateNode offline: queues POST with client id + mirrors the copy", async () => {
    const store = makeStore(bootstrapWith([{ ...baseNode }]));
    const m = makeNodeMutations(ctx(store, false));
    await m.duplicateNode({ ...baseNode });
    expect(addPendingWrite).toHaveBeenCalledTimes(1);
    const [method, path] = vi.mocked(addPendingWrite).mock.calls[0]!;
    expect(method).toBe("POST");
    expect(path).toBe("/api/nodes/n1/duplicate");
    expect(JSON.parse(vi.mocked(addPendingWrite).mock.calls[0]![2]!)).toEqual({
      id: expect.any(String),
    });
    expect(store.get().nodes.some((n) => n.title === "N (Copy)")).toBe(true);
  });

  it("setHomeNode offline: queues workspace PATCH + mirrors home_node_id", async () => {
    const store = makeStore(bootstrapWith([{ ...baseNode }]));
    const m = makeNodeMutations(ctx(store, false));
    await m.setHomeNode("n1");
    expect(addPendingWrite).toHaveBeenCalledWith("PATCH", "/api/workspace", JSON.stringify({ home_node_id: "n1" }), expect.any(String));
    expect(store.get().workspace.home_node_id).toBe("n1");
  });

  it("assignToGroup offline: queues node PATCH + mirrors parent_id", async () => {
    const store = makeStore(bootstrapWith([{ ...baseNode }]));
    const m = makeNodeMutations(ctx(store, false));
    await m.assignToGroup("n1", "p1");
    expect(addPendingWrite).toHaveBeenCalledWith("PATCH", "/api/nodes/n1", JSON.stringify({ parent_id: "p1" }), expect.anything());
    expect(store.get().nodes.find((n) => n.id === "n1")!.parent_id).toBe("p1");
  });

  it("promoteNode offline: queues promote POST + clears hidden", async () => {
    const store = makeStore(bootstrapWith([{ ...baseNode, hidden: true }]));
    const m = makeNodeMutations(ctx(store, false));
    await m.promoteNode("n1");
    expect(addPendingWrite).toHaveBeenCalledWith("POST", "/api/nodes/n1/promote", null, expect.anything());
    expect(store.get().nodes.find((n) => n.id === "n1")!.hidden).toBe(false);
  });

  it("restoreVersion offline: guarded — throws (needs a server-computed body), nothing queued", async () => {
    const store = makeStore(bootstrapWith([{ ...baseNode }]));
    const m = makeNodeMutations(ctx(store, false));
    await expect(m.restoreVersion("n1", "v1", { restoreTitle: false })).rejects.toThrow(/connection/);
    expect(addPendingWrite).not.toHaveBeenCalled();
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe("canvasWriter offline coverage", () => {
  // A canvas is a node: the board list is the store's canvas nodes.
  const boardNode = { id: "c1", title: "Board", slug: "canvas-c1", markdown: "", source_type: "manual" as const, node_type: "canvas" as const, created_at: "t0", updated_at: "t0" };
  function canvasCtx(online: boolean, store = makeStore(bootstrapWith([{ ...boardNode }]))) {
    let active: Canvas | null = null;
    return {
      online, addToast: vi.fn(),
      get data() { return store.get(); }, setData: store.setData as never,
      get activeCanvas() { return active; },
      setActiveCanvas: vi.fn((update: Canvas | null | ((row: Canvas | null) => Canvas | null)) => { active = typeof update === "function" ? update(active) : update; }),
    };
  }
  /** The one rename/delete path for a canvas: the note's (nodeMutations → noteWriter). */
  function canvasNotes(store: ReturnType<typeof makeStore>) {
    return makeNodeMutations({ get data() { return store.get(); }, setData: store.setData as never, online: false, addToast: vi.fn(), scheduleUserFolderSync: () => {}, refresh: async () => {} });
  }

  it("saveCanvasData offline: queues the PATCH (no throw)", async () => {
    const a = makeCanvasWriter(canvasCtx(false));
    const card = { nodeId: "n1", x: 1, y: 2 };
    await expect(a.save("c1", { nodes: [card] })).resolves.toMatchObject({ status: "queued" });
    expect(addPendingWrite).toHaveBeenCalledWith("PATCH", "/api/boards/c1", JSON.stringify({ cards: { upsert: [card] } }), expect.any(String));
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("renameCanvas offline: queues the note PATCH and the list shows the new title at once", async () => {
    const store = makeStore(bootstrapWith([{ ...boardNode }]));
    await expect(canvasNotes(store).renameNode("c1", "New")).resolves.toBe(true);
    expect(canvasList(store.get().nodes).map((row) => row.title)).toEqual(["New"]);
    expect(addPendingWrite).toHaveBeenCalledWith("PATCH", "/api/nodes/c1", JSON.stringify({ title: "New" }), expect.any(String));
  });

  it("deleteCanvas offline: queues the note DELETE and the board leaves the list at once", async () => {
    const store = makeStore(bootstrapWith([{ ...boardNode }]));
    await expect(canvasNotes(store).deleteNode("c1", "Board")).resolves.toBe(true);
    expect(canvasList(store.get().nodes)).toEqual([]);
    expect(addPendingWrite).toHaveBeenCalledWith("DELETE", "/api/nodes/c1", null, expect.any(String));
  });

  it("saveCanvasData online: sends the PATCH", async () => {
    apiMock.mockResolvedValueOnce(undefined);
    const a = makeCanvasWriter(canvasCtx(true));
    await a.save("c1", { nodes: [{ nodeId: "n1", x: 1, y: 2 }] });
    expect(apiMock).toHaveBeenCalledWith("/api/boards/c1", expect.objectContaining({ method: "PATCH" }));
    expect(addPendingWrite).not.toHaveBeenCalled();
  });

  it("createCanvas offline: queues POST with a CLIENT-MINTED id + returns the optimistic canvas (no longer null)", async () => {
    const a = makeCanvasWriter(canvasCtx(false));
    const fresh = await a.create("Board");
    // It used to hard-return null offline; now it yields a usable optimistic canvas.
    expect(fresh, "createCanvas returns an optimistic canvas offline").toBeTruthy();
    expect(fresh!.data).toEqual({ nodes: [] });
    const call = vi.mocked(addPendingWrite).mock.calls.find((c) => c[1] === "/api/canvases");
    expect(call, "the offline canvas create was queued").toBeTruthy();
    expect(call![0]).toBe("POST");
    // Client id in the body AND reused as the idempotency key — the server honors it.
    expect(JSON.parse(call![2] as string)).toEqual({ id: fresh!.id, title: "Board" });
    expect(call![3]).toBe(fresh!.id);
    expect(apiMock).not.toHaveBeenCalled();
    // MIRROR: the canvas is written to localDb so it survives a cold reload
    // before the drain — the whole point of this track.
    expect(vi.mocked(upsertCanvas)).toHaveBeenCalledWith(expect.objectContaining({ id: fresh!.id, title: "Board", data: { nodes: [] } }));
    // …and as the node it is, so the canvas list has it at once and after a reload.
    expect(vi.mocked(upsertNode)).toHaveBeenCalledWith(expect.objectContaining({ id: fresh!.id, node_type: "content", title: "Board", collection_views: [expect.objectContaining({ layout: "canvas" })] }));
  });

  it("saveCanvasData offline: mirrors the new layout (cold-start survival) + queues the PATCH", async () => {
    const active = { id: "c1", title: "Board", data: { nodes: [] }, created_at: "t0", updated_at: "t0" };
    const a = makeCanvasWriter({ ...canvasCtx(false), activeCanvas: active });
    const layout = { nodes: [{ nodeId: "n1", x: 10, y: 20 }] };
    await a.save("c1", layout);
    // The load-bearing mirror write: the new layout is persisted under the canvas id.
    expect(vi.mocked(upsertCanvas)).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", title: "Board", data: layout }));
    // Queued as the change (one new card), not the whole layout.
    expect(addPendingWrite).toHaveBeenCalledWith("PATCH", "/api/boards/c1", JSON.stringify({ cards: { upsert: layout.nodes } }), expect.any(String));
  });

  it("deleteCanvas offline: removes the canvas node from the mirror (so a reload lists it no more)", async () => {
    const store = makeStore(bootstrapWith([{ ...boardNode }]));
    await canvasNotes(store).deleteNode("c1", "Board");
    expect(vi.mocked(removeNode)).toHaveBeenCalledWith("c1");
  });

  it("renameCanvas offline: mirrors the canvas node's new title", async () => {
    const store = makeStore(bootstrapWith([{ ...boardNode }]));
    await canvasNotes(store).renameNode("c1", "Renamed");
    expect(vi.mocked(upsertNode)).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", node_type: "canvas", title: "Renamed" }));
  });

  it("selectCanvas offline: falls back to the mirrored layout when the GET fails", async () => {
    const mirrored = { id: "c1", title: "Board", data: { nodes: [{ nodeId: "n1", x: 1, y: 2 }] }, created_at: "t0", updated_at: "t0" };
    apiMock.mockRejectedValueOnce(new TypeError("Failed to fetch")); // offline GET
    vi.mocked(loadCanvas).mockResolvedValueOnce(mirrored);
    const setActiveCanvas = vi.fn();
    const a = makeCanvasWriter({ ...canvasCtx(false), setActiveCanvas });
    await a.select("c1");
    expect(vi.mocked(loadCanvas)).toHaveBeenCalledWith("c1");
    expect(setActiveCanvas).toHaveBeenCalledWith(mirrored);
  });

  it("selectCanvas online: sets the fetched canvas and freshens the mirror", async () => {
    const server = { id: "c1", title: "Board", data: { nodes: [] }, created_at: "t0", updated_at: "t1" };
    apiMock.mockResolvedValueOnce(server);
    const setActiveCanvas = vi.fn();
    const a = makeCanvasWriter({ ...canvasCtx(true), setActiveCanvas });
    await a.select("c1");
    expect(setActiveCanvas).toHaveBeenCalledWith(server);
    expect(vi.mocked(upsertCanvas)).toHaveBeenCalledWith(server);
  });

  it("createCanvas online: sends POST with the client id and reconciles by it", async () => {
    // The server echoes the honored client id back.
    apiMock.mockImplementationOnce(async (_p: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as { id: string; title: string };
      return { id: b.id, title: b.title, created_at: "2026-06-30T00:00:00Z", updated_at: "2026-06-30T00:00:00Z" };
    });
    const a = makeCanvasWriter(canvasCtx(true));
    const fresh = await a.create("Board");
    expect(fresh).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith("/api/canvases", expect.objectContaining({ method: "POST" }));
    // The returned canvas keeps the client-minted id (server honored it).
    const call = apiMock.mock.calls.find(([p]) => p === "/api/canvases")!;
    expect(JSON.parse(String((call[1] as RequestInit).body)).id).toBe(fresh!.id);
    expect(addPendingWrite).not.toHaveBeenCalled();
  });
});

beforeEach(() => { bindAccountStorage("unit-test-account", ""); });
