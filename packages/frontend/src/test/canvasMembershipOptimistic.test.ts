// D98: a note placed on (or taken off) a canvas shows in "Appears on canvases"
// — and so offers the canvas lens — before the server answers, and the change
// reaches the local mirror for a warm start. A refusal puts the list back.
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  upsertCanvas: vi.fn(), removeCanvas: vi.fn(), upsertNode: vi.fn(), removeNode: vi.fn(), loadCanvas: vi.fn(), loadCanvases: vi.fn(),
  getPendingWrites: vi.fn(), putCanvasMemberships: vi.fn(),
}));
vi.mock("../lib/data/writeRecovery", async original => ({
  ...await original<typeof import("../lib/data/writeRecovery")>(),
  getRecoveryWrites: () => [], confirmRecoveredWrite: vi.fn(),
}));
import { ApiError, noWorkspaceData, type Bootstrap, type Canvas, type ContentNode } from "../lib/api";
import * as db from "../lib/localDb";
import { makeCanvasWriter, type CanvasCtx } from "../lib/data/canvasWriter";

const node = (id: string, title: string, node_type: ContentNode["node_type"] = "content"): ContentNode =>
  ({ id, title, slug: id, markdown: "", source_type: "manual", node_type, created_at: "t0", updated_at: "t0" });
const board: Canvas = { id: "board", title: "Plans", created_at: "t0", updated_at: "t0", data: { nodes: [{ nodeId: "kept", x: 0, y: 0 }] } };

function fixture(opts: { memberships?: Bootstrap["canvas_memberships"]; tagBoard?: boolean } = {}) {
  let active: Canvas | null = board;
  let data: Bootstrap = {
    ...noWorkspaceData,
    nodes: [node("board", "Plans", "canvas"), node("kept", "Kept"), node("dropped", "Dropped")],
    canvas_memberships: opts.memberships ?? [{ canvas_id: "board", canvas_title: "Plans", node_id: "kept" }],
  };
  const ctx: CanvasCtx = {
    online: true, get activeCanvas() { return active; }, get data() { return data; }, addToast: vi.fn(),
    setActiveCanvas: update => { active = typeof update === "function" ? update(active) : update; },
    setData: update => { data = typeof update === "function" ? update(data) : update; },
    ...(opts.tagBoard ? { tagBoard: (id: string) => id === "board" ? { title: "Plans", memberIds: ["kept"] } : null } : {}),
  };
  return { ctx, writer: makeCanvasWriter(ctx) };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const boardsOf = (ctx: CanvasCtx, nodeId: string) =>
  (ctx.data.canvas_memberships ?? []).filter((m) => m.node_id === nodeId).map((m) => `${m.canvas_id}:${m.canvas_title}`);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.getPendingWrites).mockResolvedValue([]);
});

describe("canvas memberships follow this device's board changes (D98)", () => {
  it("a placed note is on the board before the server answers, and in the mirror", async () => {
    const { ctx, writer } = fixture();
    const reply = deferred<unknown>();
    mocks.api.mockReturnValue(reply.promise);
    const placed = writer.place("board", "dropped");
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalled());
    expect(boardsOf(ctx, "dropped")).toEqual(["board:Plans"]);
    expect(db.putCanvasMemberships).toHaveBeenCalledWith("board", ["dropped"],
      [{ canvas_id: "board", canvas_title: "Plans", node_id: "dropped" }]);
    reply.resolve({ ok: true });
    await placed;
    expect(boardsOf(ctx, "dropped")).toEqual(["board:Plans"]);
    expect(boardsOf(ctx, "kept")).toEqual(["board:Plans"]);
  });

  it("a refused placement takes the membership back, in the store and the mirror", async () => {
    const { ctx, writer } = fixture();
    mocks.api.mockRejectedValue(new ApiError(403, "denied"));
    await expect(writer.place("board", "dropped")).rejects.toThrow();
    expect(boardsOf(ctx, "dropped")).toEqual([]);
    expect(vi.mocked(db.putCanvasMemberships).mock.lastCall).toEqual(["board", ["dropped"], []]);
  });

  it("a note taken off the board leaves its list at once", async () => {
    const { ctx, writer } = fixture();
    const reply = deferred<unknown>();
    mocks.api.mockReturnValue(reply.promise);
    const saved = writer.save("board", { nodes: [] });
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalled());
    expect(boardsOf(ctx, "kept")).toEqual([]);
    expect(db.putCanvasMemberships).toHaveBeenCalledWith("board", ["kept"], []);
    reply.resolve({ ok: true });
    await saved;
    expect(boardsOf(ctx, "kept")).toEqual([]);
  });

  it("a tag board's cards are its members, not canvas placements", async () => {
    const { ctx, writer } = fixture({ memberships: [], tagBoard: true });
    mocks.api.mockResolvedValue({ ok: true });
    await writer.save("board", { nodes: [{ nodeId: "kept", x: 0, y: 0 }, { nodeId: "dropped", x: 5, y: 5 }] });
    expect(ctx.data.canvas_memberships).toEqual([]);
    expect(db.putCanvasMemberships).not.toHaveBeenCalled();
  });
});

describe("hiding or showing the 白板 tab updates 'Appears on canvases' at once", () => {
  it("a hidden tab takes the board's notes off the list and the mirror; showing it puts them back", async () => {
    const { ctx, writer } = fixture();
    await writer.setListed("board", false);
    expect(boardsOf(ctx, "kept")).toEqual([]);
    expect(db.putCanvasMemberships).toHaveBeenLastCalledWith("board", ["kept"], []);

    vi.mocked(db.loadCanvas).mockResolvedValue({ ...board, created_at: "t0", updated_at: "t0" });
    await writer.setListed("board", true);
    expect(boardsOf(ctx, "kept")).toEqual(["board:Plans"]);
    expect(db.putCanvasMemberships).toHaveBeenLastCalledWith("board", ["kept"],
      [{ canvas_id: "board", canvas_title: "Plans", node_id: "kept" }]);
  });

  it("leaves other boards' rows alone", async () => {
    const { ctx, writer } = fixture({ memberships: [
      { canvas_id: "board", canvas_title: "Plans", node_id: "kept" },
      { canvas_id: "other", canvas_title: "Other", node_id: "kept" },
    ] });
    await writer.setListed("board", false);
    expect(boardsOf(ctx, "kept")).toEqual(["other:Other"]);
  });
});
