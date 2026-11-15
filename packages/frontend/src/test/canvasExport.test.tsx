import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../lib/api", async original => ({
  ...await original<typeof import("../lib/api")>(), api: vi.fn(),
}));
import { api, ApiError, noWorkspaceData, type Canvas, type ContentNode, type NodeEdge } from "../lib/api";
import { prepareCanvasExport } from "../lib/canvasExport";
import { useCanvasExport } from "../hooks/useCanvasExport";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";

const note = (id: string, extra: Partial<ContentNode> = {}): ContentNode => ({
  id, title: id, markdown: `body ${id}`, source_type: "manual", node_type: "content", slug: id, ...extra,
});
const board: Canvas = {
  id: "board", title: "完整 白板", created_at: "", updated_at: "",
  data: {
    nodes: [
      { nodeId: "a", x: 15, y: -20, width: 330, height: 270, color: "#3b82f6", folded: true },
      { nodeId: "b", x: 500, y: 40 },
    ],
    sections: [{ id: "s", x: -30, y: -50, width: 700, height: 350, title: "Group", color: "#22c55e" }],
  },
};
const relation = (id: string, source: string, target: string, edge_type: NodeEdge["edge_type"] = "knowledge_link"): NodeEdge =>
  ({ id, source_node_id: source, target_node_id: target, edge_type, status: "active" });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.clearAllMocks();
  setLocalePref("en");
  resetAppState({ activeCanvas: board, data: { ...noWorkspaceData, nodes: [note("a"), note("b")] } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("exports every stored member/group and full stored sizes, independent of display folding or graph filtering", async () => {
  const result = await prepareCanvasExport(board, [note("a"), note("b"), note("outside")], [
    relation("ab", "a", "b"), relation("suggested", "b", "a", "suggested_link"),
    relation("nav", "a", "b", "nav_link"), relation("outside", "a", "outside"),
  ]);
  expect(result.filename).toBe("完整-白板.canvas");
  expect(result.canvas.nodes).toEqual([
    { id: "group-s", type: "group", x: -30, y: -50, width: 700, height: 350, label: "Group", color: "#22c55e" },
    { id: "a", type: "text", x: 15, y: -20, width: 330, height: 270, text: "# a\n\nbody a", color: "#3b82f6" },
    { id: "b", type: "text", x: 500, y: 40, width: 260, height: 200, text: "# b\n\nbody b" },
  ]);
  expect(result.canvas.edges).toEqual([
    { id: "ab", fromNode: "a", toNode: "b" }, { id: "suggested", fromNode: "b", toNode: "a" },
  ]);
  expect(api).not.toHaveBeenCalled();
});

it("uses loaded local text offline, including an intentionally empty body, without replacing it with server data", async () => {
  vi.mocked(api).mockRejectedValue(new TypeError("offline"));
  const result = await prepareCanvasExport(board, [note("a", { markdown: "local pending text" }), note("b", { markdown: "" })], []);
  expect(result.canvas.nodes.find(n => n.id === "a")?.text).toBe("# a\n\nlocal pending text");
  expect(result.canvas.nodes.find(n => n.id === "b")?.text).toBe("# b\n\n");
  expect(api).not.toHaveBeenCalled();
});

it("reads slim/missing notes before returning the file, preserving local titles and leaving the store untouched", async () => {
  const local = note("a", { title: "Queued rename", markdown: "", body_len: 30 });
  vi.mocked(api).mockResolvedValueOnce(note("a", { title: "Old title", markdown: "full body" })).mockResolvedValueOnce(note("b"));
  const before = getAppState();
  const result = await prepareCanvasExport(board, [local], []);
  expect(api).toHaveBeenNthCalledWith(1, "/api/nodes/a");
  expect(api).toHaveBeenNthCalledWith(2, "/api/nodes/b");
  expect(result.canvas.nodes.find(n => n.id === "a")?.text).toBe("# Queued rename\n\nfull body");
  expect(local.markdown).toBe("");
  expect(getAppState()).toBe(before);
});

it.each([403, 404])("refuses the entire export for an unavailable member (%i), instead of skipping it", async status => {
  vi.mocked(api).mockRejectedValue(new ApiError(status, '{"error":"unavailable"}'));
  await expect(prepareCanvasExport(board, [note("a")], [])).rejects.toThrow("Some cards are unavailable");
});

it("propagates a failed read without returning an empty replacement", async () => {
  const failure = new TypeError("network error");
  vi.mocked(api).mockRejectedValue(failure);
  await expect(prepareCanvasExport(board, [note("a", { markdown: "", body_len: 10 }), note("b")], [])).rejects.toBe(failure);
});

it.each([
  note("wrong"), note("b", { markdown: "", body_len: 4 }), note("b", { deleted_at: "2026-09-16" }),
])("refuses a mismatched, incomplete or deleted result", async result => {
  vi.mocked(api).mockResolvedValue(result);
  await expect(prepareCanvasExport(board, [note("a")], [])).rejects.toThrow("Some cards are unavailable");
});

it("captures layout, loaded text and connections before awaiting missing bodies", async () => {
  const source = structuredClone(board);
  const notes = [note("a", { markdown: "", body_len: 10 }), note("b")];
  const edges = [relation("ab", "a", "b")];
  const read = deferred<ContentNode>();
  vi.mocked(api).mockReturnValue(read.promise);
  const pending = prepareCanvasExport(source, notes, edges);
  source.title = "Renamed";
  source.data.nodes[1].x = 999;
  source.data.sections![0].title = "New group";
  notes[1].markdown = "Later edit";
  edges[0].target_node_id = "outside";
  read.resolve(note("a"));
  const result = await pending;
  expect(result.filename).toBe("完整-白板.canvas");
  expect(result.canvas.nodes.find(n => n.id === "b")).toMatchObject({ x: 500, text: "# b\n\nbody b" });
  expect(result.canvas.nodes[0].label).toBe("Group");
  expect(result.canvas.edges[0].toNode).toBe("b");
});

function downloadSpies() {
  const create = vi.fn(() => "blob:canvas-test");
  const revoke = vi.fn();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return { create, revoke, click };
}

it("allows one pending download, exposes waiting state, and downloads only after all bodies arrive", async () => {
  const download = downloadSpies();
  const read = deferred<ContentNode>();
  setAppState({ data: { ...noWorkspaceData, nodes: [note("a")] } });
  vi.mocked(api).mockReturnValue(read.promise);
  const { result } = renderHook(useCanvasExport);
  let pending!: Promise<void>;
  act(() => { pending = result.current.exportBoard(); });
  expect(result.current.isExporting).toBe(true);
  await act(async () => result.current.exportBoard());
  expect(api).toHaveBeenCalledTimes(1);
  expect(download.click).not.toHaveBeenCalled();
  await act(async () => { read.resolve(note("b")); await pending; });
  expect(download.create).toHaveBeenCalledTimes(1);
  expect(download.click).toHaveBeenCalledTimes(1);
  expect((download.click.mock.instances[0] as HTMLAnchorElement).download).toBe("完整-白板.canvas");
  // downloadBlob lets the browser read the object URL before revoking it.
  await vi.waitFor(() => expect(download.revoke).toHaveBeenCalledWith("blob:canvas-test"), { timeout: 2000 });
  expect(result.current.isExporting).toBe(false);
});

it("reports a failed preparation once, creates no file, and permits retry", async () => {
  const download = downloadSpies();
  setAppState({ data: { ...noWorkspaceData, nodes: [note("a")] } });
  vi.mocked(api).mockRejectedValueOnce(new ApiError(403, '{}')).mockResolvedValueOnce(note("b"));
  const { result } = renderHook(useCanvasExport);
  await act(async () => result.current.exportBoard());
  expect(download.create).not.toHaveBeenCalled();
  expect(getAppState().toasts).toHaveLength(1);
  expect(getAppState().toasts[0].message).toContain("Some cards are unavailable");
  expect(result.current.isExporting).toBe(false);
  await act(async () => result.current.exportBoard());
  expect(download.click).toHaveBeenCalledTimes(1);
});

it.each(["board", "workspace", "gate", "unmount"])("discards a late export after changing %s", async change => {
  const download = downloadSpies();
  setAppState({ data: { ...noWorkspaceData, nodes: [note("a")] } });
  const read = deferred<ContentNode>();
  vi.mocked(api).mockReturnValue(read.promise);
  const { result, unmount } = renderHook(useCanvasExport);
  let pending!: Promise<void>;
  act(() => { pending = result.current.exportBoard(); });
  act(() => {
    if (change === "board") setAppState({ activeCanvas: { ...board, id: "other" } });
    if (change === "workspace") setAppState({ data: { ...noWorkspaceData, workspace: { ...noWorkspaceData.workspace, id: "other" } } });
    if (change === "gate") setAppState({ membershipGated: true });
    if (change === "unmount") unmount();
  });
  await act(async () => { read.resolve(note("b")); await pending; });
  expect(download.click).not.toHaveBeenCalled();
  expect(getAppState().toasts).toEqual([]);
});

it("a late failure cannot report against another board or clear its pending export", async () => {
  const download = downloadSpies();
  setAppState({ data: { ...noWorkspaceData, nodes: [note("a")] } });
  const old = deferred<ContentNode>(), next = deferred<ContentNode>();
  vi.mocked(api).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  const { result } = renderHook(useCanvasExport);
  let first!: Promise<void>, second!: Promise<void>;
  act(() => { first = result.current.exportBoard(); });
  act(() => setAppState({ activeCanvas: { ...board, id: "other", title: "Other" } }));
  act(() => { second = result.current.exportBoard(); });
  await act(async () => { old.reject(new Error("late")); await first; });
  expect(result.current.isExporting).toBe(true);
  expect(getAppState().toasts).toEqual([]);
  await act(async () => { next.resolve(note("b")); await second; });
  expect(download.click).toHaveBeenCalledTimes(1);
  expect((download.click.mock.instances[0] as HTMLAnchorElement).download).toBe("Other.canvas");
});
