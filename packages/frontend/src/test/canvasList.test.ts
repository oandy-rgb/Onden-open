// D75: the canvas list is the canvas nodes, not a second store. A canvas made
// on another device, renamed or trashed from its note, or created offline is
// in the list (palette, tab strip, board chooser) the moment its node is.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  upsertNode: vi.fn(), removeNode: vi.fn(), upsertAttribute: vi.fn(),
  upsertCanvas: vi.fn(), removeCanvas: vi.fn(), loadCanvas: vi.fn(), loadCanvases: vi.fn(),
  addPendingWrite: vi.fn(), getPendingWrites: vi.fn(),
}));
import { ApiError, noWorkspaceData, type Bootstrap, type Canvas, type ContentNode } from "../lib/api";
import * as db from "../lib/localDb";
import { canvasList } from "../lib/canvasList";
import { getAppState, resetAppState, selectCanvases, setData } from "../lib/appStore";
import { makeCanvasWriter, type CanvasCtx } from "../lib/data/canvasWriter";
import { makeNoteWriter } from "../lib/data/noteWriter";
import { setPending } from "../lib/data/syncStatus";
import { bindAccountStorage } from "../lib/accountStorage";
import type { DataCtx } from "../lib/data/types";

const board = (id: string, title: string, updated_at = "2026-10-01T00:00:00Z"): ContentNode => ({
  id, title, slug: `canvas-${id}`, markdown: "", node_type: "canvas", source_type: "manual", created_at: updated_at, updated_at,
});
// Since migration 138 a board is a plain note with a whiteboard tab.
const tabbed = (id: string, title: string, updated_at = "2026-10-01T00:00:00Z", layout_config: Record<string, unknown> = { opens_first: true }): ContentNode => ({
  id, title, slug: `canvas-${id}`, markdown: "", node_type: "content", source_type: "manual", created_at: updated_at, updated_at,
  collection_views: [{ id: `tab-${id}`, layout: "canvas", layout_config }],
});
const note: ContentNode = { id: "n1", title: "Note", slug: "note", markdown: "body", node_type: "content", source_type: "manual" };

function workspace(nodes: ContentNode[], online = true) {
  let state: Bootstrap = { ...noWorkspaceData, nodes };
  let active: Canvas | null = null;
  const data: DataCtx = {
    get data() { return state; }, online,
    setData: (update) => { state = typeof update === "function" ? update(state) : update; },
    addToast: vi.fn(), scheduleUserFolderSync: vi.fn(), refresh: vi.fn(async () => {}),
  };
  const ctx: CanvasCtx = {
    ...data, get data() { return state; }, get online() { return online; },
    get activeCanvas() { return active; },
    setActiveCanvas: (update) => { active = typeof update === "function" ? update(active) : update; },
  };
  return { ctx, boards: makeCanvasWriter(ctx), notes: makeNoteWriter(data), list: () => canvasList(state.nodes) };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.getPendingWrites).mockResolvedValue([]);
  vi.mocked(db.loadCanvas).mockResolvedValue(null);
  bindAccountStorage("unit-test-account", ""); setPending(0);
});

describe("the canvas list is the canvas nodes", () => {
  it("lists only canvas nodes, most recently updated first", () => {
    const rows = canvasList([board("old", "Old", "2026-01-01T00:00:00Z"), note, board("new", "New", "2026-10-01T00:00:00Z")]);
    expect(rows.map((row) => row.id)).toEqual(["new", "old"]);
    expect(rows[0]).toEqual({ id: "new", title: "New", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
  });

  it("a plain note with a whiteboard tab is a canvas, hidden tab or not; a note without one is not; the retired kind still is", () => {
    const rows = canvasList([tabbed("t", "Tabbed"), tabbed("h", "Hidden tab", "2026-09-01T00:00:00Z", { hidden: true }), note, board("legacy", "Legacy", "2026-08-01T00:00:00Z")]);
    expect(rows.map((row) => row.id)).toEqual(["t", "h", "legacy"]);
  });

  it("the store selector keeps one array while no canvas changed (a body edit elsewhere)", () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [board("b", "Board"), note] } });
    const first = selectCanvases(getAppState());
    setData((data) => ({ ...data, nodes: data.nodes.map((n) => n.id === "n1" ? { ...n, markdown: "edited" } : n) }));
    expect(selectCanvases(getAppState())).toBe(first);
    setData((data) => ({ ...data, nodes: data.nodes.map((n) => n.id === "b" ? { ...n, title: "Renamed" } : n) }));
    expect(selectCanvases(getAppState()).map((row) => row.title)).toEqual(["Renamed"]);
  });

  it("a canvas created on another device takes a dropped note (was: 'no longer available')", async () => {
    // The node arrived by sync; this device never listed or opened the board.
    const { boards } = workspace([board("remote", "From laptop"), note]);
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) =>
      init?.method ? {} : { id: "remote", title: "From laptop", created_at: "", updated_at: "", data: { nodes: [] } });
    await expect(boards.place("remote", "n1", { x: 10, y: 20 })).resolves.toBeUndefined();
    expect(mocks.api).toHaveBeenCalledWith("/api/boards/remote", expect.objectContaining({ method: "PATCH" }));
  });

  it("renaming the canvas from its note renames it in the list at once", async () => {
    const { notes, list } = workspace([board("b", "Board")]);
    let answer!: (row: unknown) => void;
    mocks.api.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const renaming = notes.patch("b", { title: "Trip plan" });
    expect(list().map((row) => row.title)).toEqual(["Trip plan"]);
    answer(board("b", "Trip plan")); await renaming;
    expect(list().map((row) => row.title)).toEqual(["Trip plan"]);
  });

  it("trashing the canvas from its note drops it from the list and closes its open board", async () => {
    const { ctx, boards, notes, list } = workspace([board("b", "Board"), note]);
    mocks.api.mockResolvedValueOnce({ id: "b", title: "Board", created_at: "", updated_at: "", data: { nodes: [] } });
    await boards.select("b");
    boards.followList(list().map((row) => row.id));
    expect(ctx.activeCanvas?.id).toBe("b");
    mocks.api.mockResolvedValueOnce({ deleted: true });
    await notes.remove("b");
    expect(list()).toEqual([]);
    boards.followList(list().map((row) => row.id));
    expect(ctx.activeCanvas).toBeNull();
    // A drop on it now is refused here, not sent to a 404.
    await expect(boards.place("b", "n1")).rejects.toThrow("no longer available");
  });

  it("a board trashed while its read is in flight does not reopen when the read lands", async () => {
    const { ctx, boards, list } = workspace([board("b", "Board")]);
    boards.followList(list().map((row) => row.id));
    let land!: (canvas: Canvas) => void;
    mocks.api.mockReturnValueOnce(new Promise<Canvas>((resolve) => { land = resolve; }));
    const opening = boards.select("b");
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    ctx.setData((state) => ({ ...state, nodes: [] })); // trashed on another device (sync)
    boards.followList(list().map((row) => row.id));
    land({ id: "b", title: "Board", created_at: "", updated_at: "", data: { nodes: [] } });
    await opening;
    expect(ctx.activeCanvas).toBeNull();
  });

  it("a canvas created offline is in the list at once, and as a node in the mirror", async () => {
    const { boards, list } = workspace([note], false);
    const fresh = await boards.create("Offline board");
    expect(list().map((row) => [row.id, row.title])).toEqual([[fresh.id, "Offline board"]]);
    // A plain note that opens on its whiteboard tab, as the server makes it.
    expect(db.upsertNode).toHaveBeenCalledWith(expect.objectContaining({
      id: fresh.id, node_type: "content", collection_views: [expect.objectContaining({ layout: "canvas", layout_config: { opens_first: true } })],
    }));
    expect(db.addPendingWrite).toHaveBeenCalledWith("POST", "/api/canvases", JSON.stringify({ id: fresh.id, title: "Offline board" }), fresh.id);
  });

  it("a converted board opens with all its cards, keyed by the note's own id", async () => {
    const { ctx, boards } = workspace([tabbed("inbox", "_Inbox"), note]);
    mocks.api.mockResolvedValueOnce({ id: "inbox", title: "_Inbox", created_at: "", updated_at: "", data: { nodes: [{ nodeId: "n1", x: 10, y: 20, color: "red" }], sections: [{ id: "s", x: 0, y: 0, width: 5, height: 5 }] } });
    await boards.select("inbox");
    expect(mocks.api).toHaveBeenCalledWith("/api/canvases/inbox");
    expect(ctx.activeCanvas).toMatchObject({ id: "inbox", title: "_Inbox", data: { nodes: [{ nodeId: "n1", x: 10, y: 20, color: "red" }], sections: [{ id: "s" }] } });
  });

  it("a plain note whose whiteboard tab has not reached this device is read as a layout from /api/boards", async () => {
    const { ctx, boards } = workspace([note]);
    mocks.api.mockResolvedValueOnce({ id: "n1", kind: "canvas", cards: [{ nodeId: "n1", x: 1, y: 2 }], sections: [] });
    await boards.select("n1");
    expect(mocks.api).toHaveBeenCalledWith("/api/boards/n1");
    expect(ctx.activeCanvas).toMatchObject({ id: "n1", title: "Note", data: { nodes: [{ nodeId: "n1", x: 1, y: 2 }] } });
  });

  it("a plain note given a whiteboard tab takes a dropped note on its own board", async () => {
    const { boards } = workspace([tabbed("fresh", "Fresh"), note]);
    mocks.api.mockImplementation(async (_path: string, init?: RequestInit) => init?.method ? {} : { id: "fresh", title: "Fresh", created_at: "", updated_at: "", data: { nodes: [] } });
    await boards.place("fresh", "n1", { x: 1, y: 2 });
    expect(mocks.api).toHaveBeenCalledWith("/api/boards/fresh", expect.objectContaining({ method: "PATCH" }));
  });

  it("a refused create leaves the list and the mirror", async () => {
    const { ctx, boards, list } = workspace([note]);
    mocks.api.mockRejectedValueOnce(new ApiError(403, "denied"));
    await expect(boards.create("Nope")).rejects.toThrow();
    expect(list()).toEqual([]);
    expect(ctx.activeCanvas).toBeNull();
    expect(db.removeNode).toHaveBeenCalled();
  });

  it("an accepted create takes the server's times without undoing a rename made meanwhile", async () => {
    const { boards, notes, list } = workspace([]);
    let answer!: (row: unknown) => void;
    mocks.api.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const creating = boards.create("Board");
    const id = list()[0]!.id;
    mocks.api.mockImplementationOnce(async () => ({ ...board(id, "Renamed"), updated_at: "2026-10-17T01:00:01Z" }));
    const renaming = notes.patch(id, { title: "Renamed" });
    answer({ id, title: "Board", created_at: "2026-10-17T01:00:00Z", updated_at: "2026-10-17T01:00:00Z" });
    await creating;
    expect(list()[0]).toMatchObject({ title: "Renamed", updated_at: "2026-10-17T01:00:00Z" });
    await renaming;
    expect(list()[0]).toMatchObject({ title: "Renamed" });
  });
});

describe("guard: one canvas list", () => {
  it("no code keeps or refreshes a second canvas list", () => {
    const root = resolve(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(ts|tsx)$/.test(name) || path === __filename) continue;
        const text = readFileSync(path, "utf8");
        if (/\b(?:s|st|state)\.canvases\b|refreshCanvasList|\bsetCanvases\b|api<CanvasMeta\[\]>/.test(text)) offenders.push(relative(root, path));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
