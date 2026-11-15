// @vitest-environment jsdom
// A slim workspace (lib/slimMode.ts) keeps bodies out of memory. useBoardWorkspace fetches the open
// board's missing card bodies, but only while a board is open, and never more than the resident-body
// cap allows: syncEngine evicts the oldest bodies past it, so an evicted card must not be fetched again.
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { noWorkspaceData, type Canvas, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { dataSync } from "../lib/data";
import { useBoardWorkspace } from "../hooks/useBoardWorkspace";

const slim = (id: string): ContentNode =>
  ({ id, title: id, slug: id, markdown: "", body_len: 50, node_type: "content", source_type: "manual", parent_id: null }) as ContentNode;

function options(mode: string, notesView: string) {
  return {
    ui: { mode, notesView, setNotesView: vi.fn() },
    focus: { selectedNode: null, openBoardId: null, selectInWorkspace: vi.fn(), settleCardRemoval: vi.fn(), createBoard: vi.fn() },
    menus: { canvasNavStack: [], setCanvasNavStack: vi.fn(), setCtxMenu: vi.fn() },
    createNodeRaw: vi.fn(), assignToGroup: vi.fn(), refresh: vi.fn(async () => {}),
  } as unknown as Parameters<typeof useBoardWorkspace>[0];
}
const board = (ids: string[]): Canvas => ({
  id: "board", title: "Board", created_at: "", updated_at: "",
  data: { nodes: ids.map((nodeId, i) => ({ nodeId, x: i * 10, y: 0 })) },
});

describe("board card bodies in a slim workspace", () => {
  let hydrate: MockInstance<typeof dataSync.hydrateNode>;
  beforeEach(() => { hydrate = vi.spyOn(dataSync, "hydrateNode").mockResolvedValue(); });
  afterEach(() => hydrate.mockRestore());

  it("tasks (or any non-board page) never hydrates the workspace's notes", async () => {
    const nodes = Array.from({ length: 400 }, (_, i) => slim(`n${i}`));
    resetAppState({ data: { ...noWorkspaceData, nodes }, online: true, activeCanvas: null });
    renderHook(() => useBoardWorkspace(options("tasks", "canvas")));
    await new Promise((r) => setTimeout(r, 30));
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("a board still loading (no canvas yet) hydrates nothing", async () => {
    const nodes = Array.from({ length: 50 }, (_, i) => slim(`n${i}`));
    resetAppState({ data: { ...noWorkspaceData, nodes }, online: true, activeCanvas: null });
    renderHook(() => useBoardWorkspace(options("notes", "canvas")));
    await new Promise((r) => setTimeout(r, 30));
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("a board with more cards than the cap fetches a bounded number, each once, even if the bodies are evicted", async () => {
    const total = dataSync.HYDRATED_BODY_CAP * 3;
    const ids = Array.from({ length: total }, (_, i) => `n${i}`);
    // The mock never fills the body in, as if syncEngine evicted it right away.
    resetAppState({ data: { ...noWorkspaceData, nodes: ids.map(slim) }, online: true, activeCanvas: board(ids) });
    const hook = renderHook((opts) => useBoardWorkspace(opts), { initialProps: options("notes", "canvas") });
    await waitFor(() => expect(hydrate).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    hook.rerender(options("notes", "canvas"));
    await new Promise((r) => setTimeout(r, 50));
    expect(hydrate.mock.calls.length).toBeLessThan(dataSync.HYDRATED_BODY_CAP);
    const called = hydrate.mock.calls.map((c) => c[0]);
    expect(new Set(called).size).toBe(called.length);
  });
});
