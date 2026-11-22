// Semantic search is an optional module (user, 2026-10-18: 「語意搜尋要關」):
// a board draws related-note suggestions only while it is imported, and its
// switch in the feature list asks first and says it is heavy to run.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
vi.mock("@xyflow/react", () => ({ MarkerType: { ArrowClosed: "arrowclosed" } }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn(), apiFetch: vi.fn(async () => ({ ok: true, json: async () => [] })) }));
vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));
import { noWorkspaceData, type Canvas, type ContentNode, type NodeEdge } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import { resetEdgeKindsForTest } from "../lib/edgeKinds";
import { reads } from "../lib/data";
import { useBoardWorkspace } from "../hooks/useBoardWorkspace";
import { useGraphViewState } from "../hooks/useGraphViewState";
import { linkSuggestionsShown, moduleFilterFor, ALL_MODULES } from "../modules";
import ModuleLibrary from "../components/ModuleLibrary";
import { setLocalePref } from "../lib/i18n";

const note = (id: string): ContentNode => ({ id, title: id, slug: id, markdown: `body ${id}`, source_type: "manual", node_type: "content" });
const NODES = ["a", "b", "c"].map(note);
const EDGES: NodeEdge[] = [
  { id: "drawn", source_node_id: "a", target_node_id: "b", edge_type: "knowledge_link", status: "active", origin: "manual" },
  { id: "suggested", source_node_id: "a", target_node_id: "c", edge_type: "suggested_link", status: "suggested", origin: "semantic" },
];
const BOARD: Canvas = { id: "board", title: "Board", created_at: "", updated_at: "",
  data: { nodes: NODES.map((n, i) => ({ nodeId: n.id, x: i * 300, y: 0, width: 260, height: 200 })) } };

function boardOptions() {
  return {
    ui: { mode: "notes", notesView: "canvas", setNotesView: vi.fn() },
    focus: { selectedNode: null, openBoardId: null, selectInWorkspace: vi.fn(), settleCardRemoval: vi.fn(), createBoard: vi.fn() },
    menus: { canvasNavStack: [], setCanvasNavStack: vi.fn(), setCtxMenu: vi.fn() },
    createNodeRaw: vi.fn(),
    assignToGroup: vi.fn(),
    refresh: vi.fn(async () => {}),
  } as unknown as Parameters<typeof useBoardWorkspace>[0];
}

function workspace(modules: string[] | null) {
  resetAppState({ data: { ...noWorkspaceData, nodes: NODES, edges: EDGES, actor_role: "admin", actor_is_owner: true,
    workspace: { ...noWorkspaceData.workspace, modules } }, activeCanvas: BOARD });
}
const drawn = () => renderHook(() => useBoardWorkspace({ ...boardOptions(), graphView: useGraphViewState() })).result.current.board.displayGraphEdges
  .map((e) => e.id).filter((id) => EDGES.some((s) => s.id === id)).sort();

beforeEach(() => {
  setLocalePref("en");
  resetEdgeKindsForTest();
  vi.spyOn(reads.workspace, "edgeManifest").mockResolvedValue([]);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resetAppState(); });

describe("semantic search module", () => {
  it("link suggestions are shown only where semantic search is imported", () => {
    expect(linkSuggestionsShown(moduleFilterFor([]))).toBe(false);
    expect(linkSuggestionsShown(moduleFilterFor(["canvas", "rss"]))).toBe(false);
    expect(linkSuggestionsShown(moduleFilterFor(["semantic"]))).toBe(true);
    expect(linkSuggestionsShown(ALL_MODULES)).toBe(true);
  });

  it("not imported, a board hides suggested links and keeps the rest", () => {
    workspace(["canvas"]);
    expect(drawn()).toEqual(["drawn"]);
  });

  it("imported, a board draws them again", () => {
    workspace(["canvas", "semantic"]);
    expect(drawn()).toEqual(["drawn", "suggested"]);
  });

  it("turning it on says it is heavy to run (zh-TW)", async () => {
    setLocalePref("zh-TW");
    workspace(["canvas"]);
    setAppState((s) => ({ data: { ...s.data, workspace: { ...s.data.workspace, modules_to_confirm: ["semantic"] } } }));
    render(<ModuleLibrary online />);
    fireEvent.click(screen.getByRole("switch", { name: "語意搜尋" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/AI 模型/);
    expect(dialog.textContent).toMatch(/很吃資/);
  });
});
