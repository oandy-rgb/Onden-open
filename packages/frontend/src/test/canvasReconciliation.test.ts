import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn(), recovery: vi.fn(() => [] as unknown[]) }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }), upsertCanvas: vi.fn(), removeCanvas: vi.fn(), upsertNode: vi.fn(), removeNode: vi.fn(), loadCanvas: vi.fn(), loadCanvases: vi.fn(), getPendingWrites: vi.fn() }));
vi.mock("../lib/data/writeRecovery", async original => ({
  ...await original<typeof import("../lib/data/writeRecovery")>(),
  getRecoveryWrites: mocks.recovery, confirmRecoveredWrite: vi.fn(),
}));
import { ApiError, noWorkspaceData, type Bootstrap, type Canvas, type CanvasMeta, type ContentNode } from "../lib/api";
import { canvasList } from "../lib/canvasList";
import * as db from "../lib/localDb";
import { makeCanvasWriter, type CanvasCtx } from "../lib/data/canvasWriter";

const server: Canvas = { id: "board", title: "Server board", created_at: "t0", updated_at: "t1",
  data: { nodes: [{ nodeId: "original", x: 10, y: 20 }], sections: [{ id: "section", title: "Keep", x: 0, y: 0, width: 500, height: 400 }] } };
const stale: Canvas = { ...server, title: "Rejected title", data: { ...server.data, nodes: [...server.data.nodes, { nodeId: "ghost", x: 400, y: 20 }] } };
/** A canvas is a node: the list the writer sees is the store's canvas nodes. */
const canvasNode = (row: CanvasMeta): ContentNode => ({ id: row.id, title: row.title, created_at: row.created_at, updated_at: row.updated_at,
  node_type: "canvas", slug: `canvas-${row.id}`, markdown: "", source_type: "manual" });
type TestCtx = CanvasCtx & { readonly canvases: CanvasMeta[]; setCanvasNodes: (rows: CanvasMeta[]) => void };
function fixture(online = true) {
  let active: Canvas | null = stale; let data: Bootstrap = { ...noWorkspaceData, nodes: [canvasNode(stale)] };
  const ctx: TestCtx = {
    online, get activeCanvas() { return active; }, get data() { return data; }, addToast: vi.fn(),
    setActiveCanvas: update => { active = typeof update === "function" ? update(active) : update; },
    setData: update => { data = typeof update === "function" ? update(data) : update; },
    get canvases() { return canvasList(data.nodes); },
    setCanvasNodes: rows => { data = { ...data, nodes: rows.map(canvasNode) }; },
  };
  return { ctx, writer: makeCanvasWriter(ctx) };
}
const ids = (rows: CanvasMeta[]) => rows.map((row) => row.id);
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.recovery.mockReturnValue([]);
  vi.mocked(db.getPendingWrites).mockResolvedValue([]);
  vi.mocked(db.loadCanvas).mockResolvedValue(stale);
});

describe("canvas selection owns the editable board", () => {
  it("hides the previous board immediately while the selected board is loading", async () => {
    const { ctx, writer } = fixture();
    const other = { ...server, id: "other", title: "Other board" };
    const read = deferred<Canvas>();
    mocks.api.mockReturnValueOnce(read.promise);
    const selected = writer.select(other.id);
    try {
      // The next render must not expose the previous board's drag/save target.
      expect(ctx.activeCanvas).toBeNull();
      expect(ids(ctx.canvases)).toEqual(["board"]);
      expect(db.removeCanvas).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledWith("/api/canvases/other"));
    } finally {
      read.resolve(other);
      await selected;
    }
    expect(ctx.activeCanvas).toEqual(other);
  });

  it("does not leave the previous board editable after the new board is denied", async () => {
    const { ctx, writer } = fixture();
    mocks.api.mockRejectedValueOnce(new ApiError(403, JSON.stringify({ error: "forbidden", detail: "denied" })));
    await expect(writer.select("other")).rejects.toThrow("denied");
    expect(ctx.activeCanvas).toBeNull();
    expect(ids(ctx.canvases)).toEqual(["board"]);
    expect(db.removeCanvas).not.toHaveBeenCalled();
  });

  it("does not leave the previous board editable when an offline selection has no local copy", async () => {
    const { ctx, writer } = fixture(false);
    vi.mocked(db.loadCanvas).mockResolvedValueOnce(null);
    await writer.select("other");
    expect(ctx.activeCanvas).toBeNull();
    expect(ids(ctx.canvases)).toEqual(["board"]);
    expect(db.removeCanvas).not.toHaveBeenCalled();
  });

  it("preserves unconfirmed layout input when leaving a board and returning", async () => {
    const { ctx, writer } = fixture();
    const other = { ...server, id: "other", title: "Other board" };
    ctx.setCanvasNodes([stale, other]);
    // The recoverable in-memory layout is newer than the last durable copy.
    mocks.recovery.mockReturnValue([{ path: "/api/canvases/board", body: JSON.stringify({ data: stale.data }) }]);
    vi.mocked(db.loadCanvas).mockResolvedValue(server);
    mocks.api.mockResolvedValueOnce(other);
    await writer.select("other");
    expect(ctx.activeCanvas).toEqual(other);
    await writer.select("board");
    expect(ctx.activeCanvas?.data).toEqual(stale.data);
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith("/api/canvases/other");
    expect(db.removeCanvas).not.toHaveBeenCalled();
  });
});

describe("canvas reconciliation after replay", () => {
  it("replaces refused local placement/title in memory and cache, including the basis for later rollback", async () => {
    const { ctx, writer } = fixture(); mocks.api.mockResolvedValueOnce(server);
    await writer.refreshOpenCanvas();
    expect(ctx.activeCanvas).toEqual(server);
    expect(db.upsertCanvas).toHaveBeenLastCalledWith(server);
    mocks.api.mockRejectedValueOnce(new ApiError(403, JSON.stringify({ error: "forbidden", detail: "denied" })));
    await expect(writer.save(server.id, stale.data)).rejects.toThrow();
    expect(ctx.activeCanvas?.data).toEqual(server.data);
    expect(db.upsertCanvas).toHaveBeenLastCalledWith(expect.objectContaining({ data: server.data }));
  });

  it.each(["POST", "PATCH", "DELETE"])("keeps a pending %s of this board, then refreshes after it settles", async method => {
    const { ctx, writer } = fixture();
    vi.mocked(db.getPendingWrites).mockResolvedValue([{ id: 1, idem_key: "one", method, path: method === "POST" ? "/api/canvases" : "/api/canvases/board", body: JSON.stringify({ id: "board", data: stale.data }), attempts: 0 }]);
    await writer.refreshOpenCanvas();
    expect(mocks.api).not.toHaveBeenCalled(); expect(ctx.activeCanvas).toEqual(stale);
    vi.mocked(db.getPendingWrites).mockResolvedValue([]); mocks.api.mockResolvedValue(server);
    await writer.refreshOpenCanvas(); expect(ctx.activeCanvas).toEqual(server);
  });

  it("protects an unconfirmed storage failure, but rejected recovery copies do not pin the layout", async () => {
    const { ctx, writer } = fixture();
    const input = { path: "/api/canvases/board", body: JSON.stringify({ data: stale.data }) };
    mocks.recovery.mockReturnValue([input]);
    await writer.refreshOpenCanvas(); expect(mocks.api).not.toHaveBeenCalled();
    mocks.recovery.mockReturnValue([{ ...input, rejection: "denied" }]); mocks.api.mockResolvedValue(server);
    await writer.refreshOpenCanvas(); expect(ctx.activeCanvas).toEqual(server);
  });

  it("does not let a delayed GET overwrite a newer local edit or its durable mirror", async () => {
    const { ctx, writer } = fixture(); const read = deferred<Canvas>();
    mocks.api.mockReturnValueOnce(read.promise).mockResolvedValueOnce({});
    const refresh = writer.refreshOpenCanvas();
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    const newer = { ...server.data, nodes: [{ nodeId: "newer", x: 800, y: 300 }] };
    const write = writer.save("board", newer);
    read.resolve(server); await refresh; await write;
    expect(ctx.activeCanvas?.data).toEqual(newer);
    expect(db.upsertCanvas).toHaveBeenLastCalledWith(expect.objectContaining({ data: newer }));
    expect(db.upsertCanvas).not.toHaveBeenCalledWith(server);
  });

  it("does not overwrite a queue entry that arrived during the read", async () => {
    const { ctx, writer } = fixture(); const read = deferred<Canvas>(); mocks.api.mockReturnValueOnce(read.promise);
    const refresh = writer.refreshOpenCanvas(); await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    vi.mocked(db.getPendingWrites).mockResolvedValue([{ id: 2, idem_key: "two", method: "PATCH", path: "/api/canvases/board", body: "{}", attempts: 0 }]);
    read.resolve(server); await refresh;
    expect(ctx.activeCanvas).toEqual(stale); expect(db.upsertCanvas).not.toHaveBeenCalled();
  });

  it("preserves an edit started while the refreshed local copy is being persisted", async () => {
    const { ctx, writer } = fixture(); const mirror = deferred<void>();
    mocks.api.mockResolvedValueOnce(server).mockResolvedValueOnce({});
    vi.mocked(db.upsertCanvas).mockReturnValueOnce(mirror.promise);
    const refresh = writer.refreshOpenCanvas(); await vi.waitFor(() => expect(db.upsertCanvas).toHaveBeenCalledOnce());
    const newer = { ...server.data, nodes: [{ nodeId: "newer", x: 900, y: 400 }] };
    const write = writer.save("board", newer); mirror.resolve(); await refresh; await write;
    expect(ctx.activeCanvas?.data).toEqual(newer);
    expect(db.upsertCanvas).toHaveBeenLastCalledWith(expect.objectContaining({ data: newer }));
  });

  it("only checks the open board, even when a different board has queued work", async () => {
    const { ctx, writer } = fixture();
    vi.mocked(db.getPendingWrites).mockResolvedValue([{ id: 3, idem_key: "other", method: "PATCH", path: "/api/canvases/other", body: "{}", attempts: 0 }]);
    mocks.api.mockResolvedValueOnce(server); await writer.refreshOpenCanvas();
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith("/api/canvases/board");
    expect(ctx.activeCanvas).toEqual(server);
  });

  it("a slow refresh cannot replace a different selection", async () => {
    const { ctx, writer } = fixture(); const read = deferred<Canvas>();
    const other = { ...server, id: "other", title: "Other" };
    mocks.api.mockReturnValueOnce(read.promise).mockResolvedValueOnce(other);
    const refresh = writer.refreshOpenCanvas(); await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    await writer.select("other"); read.resolve(server); await refresh;
    expect(ctx.activeCanvas).toEqual(other); expect(db.upsertCanvas).not.toHaveBeenCalledWith(server);
  });

  it("removes only the canvas cache when the server says it is unavailable", async () => {
    const { ctx, writer } = fixture(); mocks.api.mockRejectedValueOnce(new ApiError(404, "not found"));
    const before = ctx.data;
    await writer.refreshOpenCanvas();
    // The canvas node leaves the store with the next sync, like any note.
    expect(ctx.activeCanvas).toBeNull(); expect(ctx.data).toBe(before);
    expect(db.removeCanvas).toHaveBeenCalledExactlyOnceWith("board");
  });

  it("read or mirror failure stays retryable and is not reported as a successful check", async () => {
    const { writer } = fixture(); mocks.api.mockRejectedValueOnce(new ApiError(503, "unavailable"));
    await expect(writer.refreshOpenCanvas()).rejects.toThrow(); expect(db.upsertCanvas).not.toHaveBeenCalled();
    mocks.api.mockResolvedValue(server); vi.mocked(db.upsertCanvas).mockRejectedValueOnce(new Error("quota"));
    await expect(writer.refreshOpenCanvas()).rejects.toThrow("quota");
    await expect(writer.refreshOpenCanvas()).resolves.toBeUndefined();
  });

  it("a failed cache deletion can be retried without losing the open target", async () => {
    const { ctx, writer } = fixture(); mocks.api.mockRejectedValue(new ApiError(404, "not found"));
    vi.mocked(db.removeCanvas).mockRejectedValueOnce(new Error("quota"));
    await expect(writer.refreshOpenCanvas()).rejects.toThrow("quota");
    expect(ctx.activeCanvas?.id).toBe("board");
    await writer.refreshOpenCanvas();
    expect(ctx.activeCanvas).toBeNull(); expect(db.removeCanvas).toHaveBeenCalledTimes(2);
  });

  it("a stale read failure does not fail the new board's check", async () => {
    const { ctx, writer } = fixture(); const read = deferred<Canvas>();
    const other = { ...server, id: "other" };
    mocks.api.mockReturnValueOnce(read.promise).mockResolvedValueOnce(other);
    const refresh = writer.refreshOpenCanvas(); await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    await writer.select("other"); read.reject(new ApiError(503, "offline"));
    await expect(refresh).resolves.toBeUndefined(); expect(ctx.activeCanvas).toEqual(other);
  });

  it("an offline selection that finishes after reconnect reads the server before showing its cached layout", async () => {
    const { ctx, writer } = fixture(false); const local = deferred<Canvas>();
    vi.mocked(db.loadCanvas).mockReturnValueOnce(local.promise); mocks.api.mockResolvedValueOnce(server);
    const select = writer.select("board");
    await vi.waitFor(() => expect(db.loadCanvas).toHaveBeenCalledOnce());
    ctx.online = true; local.resolve(stale); await select;
    expect(ctx.activeCanvas).toEqual(server);
  });

  it("opens an uncached selection when sync runs after the offline read already finished", async () => {
    const { ctx, writer } = fixture(false);
    ctx.setActiveCanvas(null); vi.mocked(db.loadCanvas).mockResolvedValue(null);
    await writer.select("board");
    expect(ctx.activeCanvas).toBeNull(); expect(mocks.api).not.toHaveBeenCalled();
    ctx.online = true; mocks.api.mockResolvedValueOnce(server);
    await writer.refreshOpenCanvas();
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith("/api/canvases/board");
    expect(ctx.activeCanvas).toEqual(server); expect(db.upsertCanvas).toHaveBeenCalledWith(server);
  });

  it("can retry a failed reconnect read before the selected board has any snapshot", async () => {
    const { ctx, writer } = fixture(false);
    ctx.setActiveCanvas(null); vi.mocked(db.loadCanvas).mockResolvedValue(null);
    await writer.select("board"); ctx.online = true;
    mocks.api.mockRejectedValueOnce(new ApiError(503, "offline"));
    await expect(writer.refreshOpenCanvas()).rejects.toThrow();
    mocks.api.mockResolvedValueOnce(server); await writer.refreshOpenCanvas();
    expect(ctx.activeCanvas).toEqual(server);
  });

  it("does not resurrect an uncached board after the user clears selection", async () => {
    const { ctx, writer } = fixture(false);
    ctx.setActiveCanvas(null); vi.mocked(db.loadCanvas).mockResolvedValue(null);
    await writer.select("board"); await writer.select(null); ctx.online = true;
    await writer.refreshOpenCanvas();
    expect(mocks.api).not.toHaveBeenCalled(); expect(ctx.activeCanvas).toBeNull();
  });

  it("reconnect checks the latest uncached selection, not an earlier missing board", async () => {
    const { ctx, writer } = fixture(false);
    ctx.setActiveCanvas(null); vi.mocked(db.loadCanvas).mockResolvedValue(null);
    await writer.select("board"); await writer.select("other"); ctx.online = true;
    const other = { ...server, id: "other" }; mocks.api.mockResolvedValueOnce(other);
    await writer.refreshOpenCanvas();
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith("/api/canvases/other");
    expect(ctx.activeCanvas).toEqual(other);
  });
});

describe("layout saves are changes, not documents", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("moving one card PATCHes /api/boards with that card only (GAP-178)", async () => {
    const { ctx, writer } = fixture();
    const board: Canvas = { ...server, data: { nodes: [{ nodeId: A, x: 0, y: 0 }, { nodeId: B, x: 300, y: 0 }], sections: server.data.sections } };
    ctx.setActiveCanvas(board);
    mocks.api.mockResolvedValueOnce({});
    await writer.save(board.id, { ...board.data, nodes: [{ nodeId: A, x: 0, y: 0 }, { nodeId: B, x: 320, y: 40 }] });
    const [path, init] = mocks.api.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/boards/board");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ cards: { upsert: [{ nodeId: B, x: 320, y: 40 }] } });
  });

  it("an unchanged layout sends nothing", async () => {
    const { ctx, writer } = fixture();
    ctx.setActiveCanvas(server);
    await writer.save(server.id, structuredClone(server.data));
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it("a tag board reads /api/boards and shows every member, placed or not", async () => {
    const { ctx } = fixture();
    const tagCtx: CanvasCtx = { ...ctx,
      get online() { return true; }, get activeCanvas() { return ctx.activeCanvas; }, get data() { return ctx.data; },
      tagBoard: (id) => id === "tag" ? { title: "Reading", memberIds: [A, B] } : null };
    const writer = makeCanvasWriter(tagCtx);
    mocks.api.mockResolvedValueOnce({ id: "tag", cards: [{ nodeId: A, x: 5, y: 6 }], sections: [] });
    await writer.select("tag");
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith("/api/boards/tag");
    expect(ctx.activeCanvas?.title).toBe("Reading");
    expect(ctx.activeCanvas?.data.nodes.map((c) => c.nodeId)).toEqual([A, B]);
    expect(ctx.activeCanvas?.data.nodes[0]).toEqual({ nodeId: A, x: 5, y: 6 });
    // The local copy is kept under its own key, out of the canvas list.
    expect(db.upsertCanvas).toHaveBeenLastCalledWith(expect.objectContaining({ id: "tag-board:tag" }));
    expect(ctx.canvases.some((row) => row.id === "tag")).toBe(false);
  });
});

describe("the offline board list follows the server's", () => {
  const row = (id: string, created_at: string): CanvasMeta => ({ id, title: id, created_at, updated_at: created_at });
  it("drops a board deleted elsewhere, but keeps queued creates and ones made while listing", async () => {
    const { writer } = fixture();
    vi.mocked(db.loadCanvases).mockResolvedValue([
      row("kept", "2026-10-01T00:00:00Z"),
      row("deleted-elsewhere", "2026-10-01T00:00:00Z"),
      row("queued-offline", "2026-10-02T00:00:00Z"),
      row("made-while-listing", "2026-10-14T09:00:01Z"),
    ]);
    vi.mocked(db.getPendingWrites).mockResolvedValue([
      { id: 1, method: "POST", path: "/api/canvases", body: JSON.stringify({ id: "queued-offline", title: "q" }), idem_key: "queued-offline", attempts: 0 },
    ]);
    await writer.pruneMirror([row("kept", "2026-10-01T00:00:00Z")], "2026-10-14T09:00:00Z");
    expect(vi.mocked(db.removeCanvas).mock.calls).toEqual([["deleted-elsewhere"]]);
  });

  it("keeps a board whose offline create flushed while the list was in flight", async () => {
    const { writer } = fixture();
    // Queued when the list was requested; accepted (and gone from the queue)
    // before the list came back, which was read before it existed.
    const queuedAtList = [{ method: "POST", path: "/api/canvases", body: JSON.stringify({ id: "flushed", title: "f" }) }];
    vi.mocked(db.loadCanvases).mockResolvedValue([row("flushed", "2026-10-02T00:00:00Z")]);
    vi.mocked(db.getPendingWrites).mockResolvedValue([]);
    await writer.pruneMirror([], "2026-10-14T09:00:00Z", queuedAtList);
    expect(db.removeCanvas).not.toHaveBeenCalled();
  });
});
