import { bindAccountStorage } from "../lib/accountStorage";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  upsertNode: vi.fn(), removeNode: vi.fn(), upsertTask: vi.fn(), removeTask: vi.fn(),
  upsertEdge: vi.fn(), removeEdge: vi.fn(), upsertAttribute: vi.fn(), removeAttribute: vi.fn(),
  getNodeAttributeRecord: vi.fn(), upsertCanvas: vi.fn(), removeCanvas: vi.fn(), loadCanvas: vi.fn(),
  addPendingWrite: vi.fn(), getPendingWrites: vi.fn(),
}));
import { ApiError, noWorkspaceData, type Bootstrap, type Canvas, type CanvasMeta, type ContentNode } from "../lib/api";
import * as db from "../lib/localDb";
import { makeTaskWriter } from "../lib/data/taskWriter";
import { makePropertyWriter } from "../lib/data/propertyWriter";
import { makeTagWriter } from "../lib/data/tagWriter";
import { makeRelationWriter } from "../lib/data/relationWriter";
import { makeCanvasWriter, type CanvasCtx } from "../lib/data/canvasWriter";
import { makeNoteWriter } from "../lib/data/noteWriter";
import { reportWriteFailure, WriteStorageError } from "../lib/data/writeErrors";
import { setPending } from "../lib/data/syncStatus";
import type { DataCtx } from "../lib/data/types";
import { setLocalePref } from "../lib/i18n";
import { canvasList } from "../lib/canvasList";

const node: ContentNode = { id: "n1", title: "Note", slug: "note", markdown: "body", node_type: "content", source_type: "manual", attrs: { rating: "3" }, label_tag_ids: ["tag-a"] };
const canvas: Canvas = { id: "c1", title: "Board", created_at: "t0", updated_at: "t0", data: { nodes: [{ nodeId: "n1", x: 1, y: 2 }] } };
function harness(online = true) {
  let state: Bootstrap = { ...noWorkspaceData, nodes: [{ ...node }], tasks: [{ id: "t1", node_id: "n1", title: "Task", status: "todo", due_date: "2026-09-08", recur: "1w" }] };
  const ctx: DataCtx = {
    get data() { return state; }, online,
    setData: (update) => { state = typeof update === "function" ? update(state) : update; },
    addToast: vi.fn(), scheduleUserFolderSync: vi.fn(), refresh: vi.fn(async () => {}),
  };
  return { ctx, get: () => state };
}
/** A canvas is a node: the board list is the store's canvas nodes. */
const canvasNode = (row: CanvasMeta): ContentNode => ({ id: row.id, title: row.title, created_at: row.created_at, updated_at: row.updated_at,
  node_type: "canvas", slug: `canvas-${row.id}`, markdown: "", source_type: "manual" });
const ids = (rows: CanvasMeta[]) => rows.map((row) => row.id);
function boards(online = true) {
  let state: Bootstrap = { ...noWorkspaceData, nodes: [canvasNode(canvas)] };
  let active: Canvas | null = { ...canvas };
  const ctx: CanvasCtx & { readonly canvases: CanvasMeta[]; setCanvasNodes: (rows: CanvasMeta[]) => void } = {
    online, get data() { return state; }, get activeCanvas() { return active; },
    setData: (update) => { state = typeof update === "function" ? update(state) : update; },
    setActiveCanvas: (update) => { active = typeof update === "function" ? update(active) : update; },
    addToast: vi.fn(),
    get canvases() { return canvasList(state.nodes); },
    setCanvasNodes: (rows) => { state = { ...state, nodes: rows.map(canvasNode) }; },
  };
  // The one rename/delete path for a canvas is the note writer over the same store.
  const notes = makeNoteWriter({ ...ctx, get data() { return state; }, get online() { return online; }, scheduleUserFolderSync: vi.fn(), refresh: vi.fn(async () => {}) });
  return { ctx, writer: makeCanvasWriter(ctx), notes };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const denied = () => new ApiError(422, "Invalid change");
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.getPendingWrites).mockResolvedValue([]);
  vi.mocked(db.getNodeAttributeRecord).mockResolvedValue(null);
  setPending(0); setLocalePref("en");
});

describe("domain write contract", () => {
  it.each(["task", "tag", "relation", "canvas"] as const)("%s creation waits for durable acknowledgement and retains an unconfirmed intent", async (domain) => {
    const h = harness(false); const c = boards(false); const gate = deferred<void>();
    // Storage that cannot take the row: the record made first and the queue both wait on it and fail.
    vi.mocked(db.addPendingWrite).mockReturnValue(gate.promise);
    const save = domain === "task" ? makeTaskWriter(h.ctx).create("n1", "New", { when: "2026-10-01" })
      : domain === "tag" ? makeTagWriter(h.ctx).create("New")
      : domain === "relation" ? makeRelationWriter(h.ctx).connect("n1", "n2", "knowledge_link") : c.writer.create("New");
    let finished = false;
    const observed = save.then(() => { finished = true; }, (error: unknown) => error);
    await vi.waitFor(() => expect(db.addPendingWrite).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    gate.reject(new Error("quota"));
    expect(await observed).toBeInstanceOf(WriteStorageError);
    if (domain === "task") expect(h.get().tasks).toContainEqual(expect.objectContaining({ title: "New", due_date: "2026-10-01" }));
    if (domain === "tag") { expect(h.get().nodes).toContainEqual(expect.objectContaining({ title: "New" })); expect(h.get().tags).toContainEqual(expect.objectContaining({ name: "New" })); }
    if (domain === "relation") expect(h.get().edges).toHaveLength(1);
    if (domain === "canvas") expect(c.ctx.activeCanvas?.title).toBe("New");
    expect((domain === "canvas" ? c.ctx : h.ctx).addToast).toHaveBeenCalledWith(expect.stringContaining("recovery panel"), "error");
  });

  it.each(["task", "note", "property"] as const)("%s restores the accepted value when two edits to the same field are rejected", async (domain) => {
    const h = harness();
    const firstResponse = deferred<unknown>();
    mocks.api.mockReturnValueOnce(firstResponse.promise).mockRejectedValueOnce(denied());
    const task = makeTaskWriter(h.ctx); const noteWriter = makeNoteWriter(h.ctx); const props = makePropertyWriter(h.ctx);
    const edit = (value: string) => domain === "task" ? task.patch("t1", { title: value }) : domain === "note" ? noteWriter.patch("n1", { title: value }) : props.set("n1", "rating", value);
    const first = edit("First").catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    const second = edit("Second").catch((error: unknown) => error);
    firstResponse.reject(denied());
    await Promise.all([first, second]);
    expect(domain === "task" ? h.get().tasks[0]!.title : domain === "note" ? h.get().nodes[0]!.title : h.get().nodes[0]!.attrs!.rating).toBe(domain === "task" ? "Task" : domain === "note" ? "Note" : "3");
  });

  it("task rollback preserves a later due-date edit and the full local task", async () => {
    const h = harness(); const writer = makeTaskWriter(h.ctx); const response = deferred<unknown>();
    mocks.api.mockReturnValueOnce(response.promise).mockResolvedValueOnce({});
    const first = writer.patch("t1", { status: "done" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    const second = writer.patch("t1", { when_date: "2026-10-02" });
    response.reject(denied()); await first; await second;
    expect(h.get().tasks[0]).toMatchObject({ status: "todo", due_date: "2026-10-02", recur: "1w" });
    expect(db.upsertTask).toHaveBeenLastCalledWith(h.get().tasks[0]);
  });

  it("replacing a property value is one request, never a delete followed by a put", async () => {
    // A connection lost between two requests would leave the value gone (Logseq 2.0.2 fixed this class).
    const h = harness();
    mocks.api.mockReset(); mocks.api.mockResolvedValue({ status: "ok", value: { value_type: "text" } });
    await makePropertyWriter(h.ctx).set("n1", "rating", "5");
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api.mock.calls[0]![1]).toMatchObject({ method: "PUT" });
  });

  it("property removal restores metadata, preserving unrelated fields", async () => {
    const h = harness();
    vi.mocked(db.getNodeAttributeRecord).mockResolvedValue({ key: "rating", value: "3", value_type: "number", is_inheritable: true, source: "explicit" });
    mocks.api.mockRejectedValue(denied());
    await expect(makePropertyWriter(h.ctx).remove("n1", "rating")).rejects.toMatchObject({ status: 422 });
    expect(db.upsertAttribute).toHaveBeenLastCalledWith("n1", "rating", "3", "number", true, "explicit");
  });

  it("a rejected property change on an unloaded query row restores its local value and metadata", async () => {
    const h = harness(); h.ctx.setData((state) => ({ ...state, nodes: [] }));
    vi.mocked(db.getNodeAttributeRecord).mockResolvedValue({ key: "rating", value: "3", value_type: "number", is_inheritable: true, source: "explicit" });
    mocks.api.mockRejectedValue(denied());
    await expect(makePropertyWriter(h.ctx).remove("n1", "rating")).rejects.toMatchObject({ status: 422 });
    expect(db.upsertAttribute).toHaveBeenLastCalledWith("n1", "rating", "3", "number", true, "explicit");
  });

  it("an accepted property keeps the type the server stored, not the hint sent", async () => {
    const h = harness();
    mocks.api.mockResolvedValue({ key: "rating", value: "4", value_type: "number", is_inheritable: false, source: "ui" });
    await makePropertyWriter(h.ctx).set("n1", "rating", "4", { value_type: "text" });
    expect(db.upsertAttribute).toHaveBeenLastCalledWith("n1", "rating", "4", "number", false, "ui");
  });

  it("tag rollback respects no-op membership and keeps a later sibling tag", async () => {
    const h = harness(); const writer = makeTagWriter(h.ctx); const response = deferred<unknown>();
    mocks.api.mockReturnValueOnce(response.promise).mockResolvedValueOnce({});
    const first = writer.apply("n1", "tag-a").catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    const second = writer.apply("n1", "tag-b"); response.reject(denied()); await first; await second;
    expect(h.get().nodes[0]!.label_tag_ids).toEqual(["tag-b", "tag-a"]);
    mocks.api.mockRejectedValueOnce(denied());
    await expect(writer.remove("n1", "absent")).rejects.toMatchObject({ status: 422 });
    expect(h.get().nodes[0]!.label_tag_ids).not.toContain("absent");
  });

  it("relation reconciliation deduplicates an existing server edge", async () => {
    const h = harness(); const existing = { id: "edge", source_node_id: "n1", target_node_id: "n2", edge_type: "knowledge_link" as const, status: "active" as const, origin: "manual" };
    h.ctx.setData((state) => ({ ...state, edges: [existing] })); mocks.api.mockResolvedValue(existing);
    await makeRelationWriter(h.ctx).connect("n1", "n2", "knowledge_link");
    expect(h.get().edges).toEqual([existing]);
    expect(db.upsertEdge).toHaveBeenLastCalledWith(existing);
  });

  it("a rejected relation deletion leaves its local copy intact", async () => {
    const h = harness(); const edge = { id: "edge", source_node_id: "n1", target_node_id: "n2", edge_type: "knowledge_link" as const, status: "active" as const };
    h.ctx.setData((state) => ({ ...state, edges: [edge] })); mocks.api.mockRejectedValue(denied());
    await expect(makeRelationWriter(h.ctx).remove("edge")).rejects.toMatchObject({ status: 422 });
    expect(h.get().edges).toEqual([edge]); expect(db.removeEdge).not.toHaveBeenCalled();
  });

  it("canvas title rejection (a note rename) preserves a newer layout", async () => {
    const h = boards(); const response = deferred<unknown>();
    mocks.api.mockReturnValueOnce(response.promise).mockResolvedValueOnce({});
    const first = h.notes.patch("c1", { title: "Rejected" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    expect(mocks.api).toHaveBeenCalledWith("/api/nodes/c1", expect.objectContaining({ method: "PATCH" }));
    expect(h.ctx.canvases[0]!.title).toBe("Rejected");
    const data = { nodes: [{ nodeId: "n1", x: 99, y: 88 }] };
    const second = h.writer.save("c1", data); response.reject(denied()); await first; await second;
    expect(h.ctx.canvases[0]!.title).toBe("Board");
    expect(h.ctx.activeCanvas).toMatchObject({ data });
    expect(db.upsertCanvas).toHaveBeenLastCalledWith(expect.objectContaining({ data }));
  });

  it("a slow selection cannot replace the later selected canvas", async () => {
    const h = boards(); const response = deferred<Canvas>();
    mocks.api.mockReturnValueOnce(response.promise).mockResolvedValueOnce({ ...canvas, id: "c2", title: "Other" });
    const first = h.writer.select("c1");
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    await h.writer.select("c2"); response.resolve(canvas); await first;
    expect(h.ctx.activeCanvas?.id).toBe("c2");
  });

  it("reopening a queued canvas reads the local layout instead of stale server data", async () => {
    const h = boards(); const data = { nodes: [{ nodeId: "n1", x: 7, y: 9 }] };
    vi.mocked(db.getPendingWrites).mockResolvedValue([{ id: 1, idem_key: "w1", method: "PATCH", path: "/api/canvases/c1", body: JSON.stringify({ data }), attempts: 0 }]);
    vi.mocked(db.loadCanvas).mockResolvedValue({ ...canvas, data });
    await h.writer.select("c1"); expect(mocks.api).not.toHaveBeenCalled(); expect(h.ctx.activeCanvas?.data).toEqual(data);
  });

  it("canvas delete (a note trash) closes the board and restores the row on rejection without stealing a new selection", async () => {
    const h = boards(); const response = deferred<unknown>();
    h.writer.followList(ids(h.ctx.canvases));
    mocks.api.mockReturnValueOnce(response.promise).mockResolvedValueOnce({ ...canvas, id: "c2" });
    const removed = h.notes.remove("c1").catch((error: unknown) => error);
    expect(h.ctx.canvases).toEqual([]);
    h.writer.followList(ids(h.ctx.canvases));
    expect(h.ctx.activeCanvas).toBeNull();
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    expect(mocks.api).toHaveBeenCalledWith("/api/nodes/c1", expect.objectContaining({ method: "DELETE" }));
    await h.writer.select("c2");
    response.reject(denied()); await removed;
    expect(ids(h.ctx.canvases)).toEqual(["c1"]); expect(h.ctx.activeCanvas?.id).toBe("c2");
  });

  it("acknowledged saves survive mirror failure and errors are reported once at the UI boundary", async () => {
    const h = harness(); vi.mocked(db.upsertTask).mockRejectedValue(new Error("cache")); mocks.api.mockResolvedValue({});
    await expect(makeTaskWriter(h.ctx).patch("t1", { recur: "1d" })).resolves.toMatchObject({ status: "synced" });
    expect(h.ctx.addToast).toHaveBeenCalledWith(expect.stringContaining("local copy"), "error");
    vi.mocked(db.upsertTask).mockResolvedValue(); mocks.api.mockRejectedValue(denied()); vi.mocked(h.ctx.addToast).mockClear();
    await makeTaskWriter(h.ctx).patch("t1", { recur: "bad" }).catch((error: unknown) => reportWriteFailure(error, h.ctx.addToast));
    expect(h.ctx.addToast).toHaveBeenCalledOnce();
  });

  it("a patch pending before deletion never prematurely cascades the local note", async () => {
    const h = harness(); const writer = makeNoteWriter(h.ctx); const response = deferred<unknown>();
    mocks.api.mockReturnValueOnce(response.promise).mockRejectedValueOnce(denied());
    const patch = writer.patch("n1", { markdown: "new" });
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    const remove = writer.remove("n1").catch((error: unknown) => error);
    response.resolve({ ...node, markdown: "new" }); await patch; await remove;
    expect(db.removeNode).not.toHaveBeenCalled();
  });
});

beforeEach(() => { bindAccountStorage("unit-test-account", ""); });

describe("append a canvas card to current local intent", () => {
  it("keeps newer cards, edited geometry and sections instead of the pre-create snapshot", async () => {
    const { ctx, writer } = boards();
    const newer = { nodes: [{ nodeId: "n1", x: 90, y: 80, width: 310 }, { nodeId: "added-during-create", x: 450, y: 80 }],
      sections: [{ id: "s", title: "Keep", x: 0, y: 0, width: 700, height: 500 }] };
    await writer.save("c1", newer);
    await writer.place("c1", "created", { x: 0, y: 0 });
    expect(ctx.activeCanvas?.data).toEqual({ ...newer, nodes: [...newer.nodes, { nodeId: "created", x: 0, y: 0 }] });
    // The append is sent as the one new card; the server keeps the rest.
    const payload = JSON.parse(mocks.api.mock.calls.at(-1)![1].body);
    expect(payload).toEqual({ cards: { upsert: [{ nodeId: "created", x: 0, y: 0 }] } });
  });

  it("keeps a requested card width", async () => {
    const { ctx, writer } = boards();
    await writer.place("c1", "card", { x: 10, y: 20, width: 240.4 });
    expect(ctx.activeCanvas?.data.nodes.at(-1)).toEqual({ nodeId: "card", x: 10, y: 20, width: 240 });
  });

  it("composes two appends immediately with separate non-overlapping default positions", async () => {
    const { ctx, writer } = boards();
    const first = writer.place("c1", "n2"); const second = writer.place("c1", "n3");
    await first; await second;
    expect(ctx.activeCanvas?.data.nodes).toEqual([
      { nodeId: "n1", x: 1, y: 2 }, { nodeId: "n2", x: 321, y: 2 }, { nodeId: "n3", x: 641, y: 2 },
    ]);
    expect(JSON.parse(mocks.api.mock.calls.at(-1)![1].body)).toEqual({ cards: { upsert: [{ nodeId: "n3", x: 641, y: 2 }] } });
  });

  it("duplicate calls share the pending acknowledgement, including refusal, without a second write", async () => {
    const { ctx, writer } = boards(); const gate = deferred<unknown>(); mocks.api.mockReturnValue(gate.promise);
    const first = writer.place("c1", "n2");
    const second = writer.place("c1", "n2", { x: 999, y: 999 });
    expect(second).toBe(first);
    const refused = expect(first).rejects.toMatchObject({ status: 422 });
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    gate.reject(denied()); await refused;
    expect(ctx.activeCanvas?.data).toEqual(canvas.data);
    expect(ctx.addToast).toHaveBeenCalledOnce();
  });

  it("an existing placement is unchanged and needs no new write", async () => {
    const { ctx, writer } = boards(); await writer.place("c1", "n1", { x: 999, y: 999 });
    expect(ctx.activeCanvas?.data).toEqual(canvas.data); expect(mocks.api).not.toHaveBeenCalled();
  });

  it("can append to the originating board after another board was opened, without navigation", async () => {
    const { ctx, writer } = boards(); const other = { ...canvas, id: "c2", data: { nodes: [{ nodeId: "shared", x: 900, y: 600 }] } };
    ctx.setCanvasNodes([...ctx.canvases, other]); ctx.setActiveCanvas(other);
    vi.mocked(db.loadCanvas).mockResolvedValue(canvas);
    await writer.place("c1", "created", { x: 1.4, y: 2.8 });
    expect(ctx.activeCanvas).toEqual(other);
    expect(db.loadCanvas).toHaveBeenCalledExactlyOnceWith("c1");
    expect(mocks.api).toHaveBeenCalledWith("/api/boards/c1", expect.objectContaining({ method: "PATCH" }));
    expect(db.upsertCanvas).toHaveBeenLastCalledWith(expect.objectContaining({ id: "c1", data: { nodes: [...canvas.data.nodes, { nodeId: "created", x: 1, y: 3 }] } }));
  });

  it("rechecks newer local layout after a slow cache read", async () => {
    const { ctx, writer } = boards(); ctx.setActiveCanvas(null);
    const read = deferred<Canvas>(); vi.mocked(db.loadCanvas).mockReturnValueOnce(read.promise);
    const placement = writer.place("c1", "created");
    const newer = { ...canvas, data: { nodes: [{ nodeId: "newer", x: 100, y: 200 }] } };
    ctx.setActiveCanvas(newer); await writer.save("c1", newer.data);
    read.resolve(canvas); await placement;
    expect(ctx.activeCanvas?.data.nodes.map(n => n.nodeId)).toEqual(["newer", "created"]);
  });

  it("reads a board never opened on this device from the server before appending", async () => {
    const { ctx, writer } = boards(); ctx.setActiveCanvas(null);
    vi.mocked(db.loadCanvas).mockResolvedValueOnce(null as never);
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => init?.method ? {} : canvas);
    await writer.place("c1", "created", { x: 5, y: 6 });
    expect(mocks.api).toHaveBeenCalledWith("/api/canvases/c1");
    expect(JSON.parse(mocks.api.mock.calls.at(-1)![1].body)).toEqual({ cards: { upsert: [{ nodeId: "created", x: 5, y: 6 }] } });
  });

  it("does not revive a board removed during cache loading", async () => {
    const { ctx, writer } = boards(); ctx.setActiveCanvas(null);
    const read = deferred<Canvas>(); vi.mocked(db.loadCanvas).mockReturnValue(read.promise);
    const placement = writer.place("c1", "created");
    ctx.setCanvasNodes([]); read.resolve(canvas);
    await expect(placement).rejects.toThrow("Your note has been kept");
    expect(ctx.activeCanvas).toBeNull(); expect(mocks.api).not.toHaveBeenCalled();
  });

  it("waits for durable offline placement and preserves its complete layout in the cache", async () => {
    const { ctx, writer } = boards(false); const gate = deferred<void>();
    vi.mocked(db.addPendingWrite).mockReturnValue(gate.promise);
    let done = false; const placement = writer.place("c1", "offline").then(() => { done = true; });
    await vi.waitFor(() => expect(db.addPendingWrite).toHaveBeenCalledOnce());
    expect(done).toBe(false); gate.resolve(); await placement;
    expect(db.upsertCanvas).toHaveBeenLastCalledWith(expect.objectContaining({ id: "c1", data: ctx.activeCanvas?.data }));
    expect(mocks.api).not.toHaveBeenCalled();
  });
});

// Scan finding #35: work that awaited the network (creating a sub-canvas) then
// saved the board snapshot from before the await, undoing changes made
// meanwhile. updateCard changes one card on the layout as it is now.
describe("update one card on the current local layout", () => {
  it("keeps cards and sections changed while the caller waited", async () => {
    const { ctx, writer } = boards();
    const meanwhile = { nodes: [{ nodeId: "n1", x: 1, y: 2 }, { nodeId: "added-meanwhile", x: 400, y: 2 }],
      sections: [{ id: "s", title: "Keep", x: 0, y: 0, width: 700, height: 500 }] };
    await writer.save("c1", meanwhile);
    await writer.updateCard("c1", "n1", { subCanvasId: "child" });
    expect(ctx.activeCanvas?.data).toEqual({ ...meanwhile, nodes: [{ nodeId: "n1", x: 1, y: 2, subCanvasId: "child" }, meanwhile.nodes[1]] });
    expect(JSON.parse(mocks.api.mock.calls.at(-1)![1].body)).toEqual({ cards: { upsert: [{ nodeId: "n1", subCanvasId: "child" }] } });
  });

  it("leaves the board alone when the card was removed meanwhile", async () => {
    const { ctx, writer } = boards();
    await writer.updateCard("c1", "gone", { subCanvasId: "child" });
    expect(ctx.activeCanvas?.data).toEqual(canvas.data);
    expect(mocks.api).not.toHaveBeenCalled();
  });
});

describe("propertyWriter.revertConflict (D90)", () => {
  it("asks the server to revert, then holds the value with the type it stored", async () => {
    const h = harness();
    mocks.api.mockResolvedValueOnce({ key: "rating", value: "5", value_type: "number", is_inheritable: false, source: "ui" });
    expect(await makePropertyWriter(h.ctx).revertConflict(42, "n1", "rating")).toBe(true);
    expect(mocks.api).toHaveBeenCalledWith("/api/events/42/revert-conflict", expect.objectContaining({ method: "POST" }));
    expect(h.get().nodes[0]!.attrs).toEqual({ rating: "5" });
    expect(db.upsertAttribute).toHaveBeenCalledWith("n1", "rating", "5", "number", false, "ui");
  });

  it("a drawing is mirrored, not put in the note list", async () => {
    const h = harness();
    mocks.api.mockResolvedValueOnce({ key: "ink_data", value: "{\"version\":1}", value_type: "text", is_inheritable: false, source: "ui" });
    expect(await makePropertyWriter(h.ctx).revertConflict(7, "n1", "ink_data")).toBe(true);
    expect(h.get().nodes[0]!.attrs).toEqual({ rating: "3" });
    expect(db.upsertAttribute).toHaveBeenCalledWith("n1", "ink_data", "{\"version\":1}", "text", false, "ui");
  });

  it("a refusal (edited since) or no connection keeps everything as it is, reported once", async () => {
    const h = harness();
    mocks.api.mockRejectedValueOnce(new ApiError(409, "rating was changed after this conflict"));
    expect(await makePropertyWriter(h.ctx).revertConflict(42, "n1", "rating")).toBe(false);
    expect(h.get().nodes[0]!.attrs).toEqual({ rating: "3" });
    expect(h.ctx.addToast).toHaveBeenCalledTimes(1);
    const offline = harness(false);
    expect(await makePropertyWriter(offline.ctx).revertConflict(42, "n1", "rating")).toBe(false);
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(db.upsertAttribute).not.toHaveBeenCalled();
  });
});
