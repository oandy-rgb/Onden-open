// D74: an edge's origin and status reach the app, and every view decides what
// to show (and what may be deleted) with lib/edgeRoles, not a filter of its
// own. One fixture of every kind of stored edge goes through each view; each
// view must agree with its predicate. Then the four bugs the audit found.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
const capture = vi.hoisted(() => ({ props: {} as Record<string, unknown> }));
vi.mock("react-force-graph-2d", () => ({ default: (props: Record<string, unknown>) => { capture.props = props; return <canvas />; } }));
vi.mock("@xyflow/react", () => ({ MarkerType: { ArrowClosed: "arrowclosed" } }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn(), apiFetch: vi.fn(async () => ({ ok: true, json: async () => [] })) }));
import { noWorkspaceData, type Canvas, type ContentNode, type NodeEdge } from "../lib/api";
import { getAppState, resetAppState } from "../lib/appStore";
import { canDelete, countsAsBacklink, drawsInGraph, drawsOnBoard, resetEdgeKindsForTest } from "../lib/edgeKinds";
import { reads, relationWriter } from "../lib/data";
import { useGraphLayout } from "../hooks/useGraphLayout";
import { useBoardWorkspace } from "../hooks/useBoardWorkspace";
import { useGraphViewState } from "../hooks/useGraphViewState";
import AllCardsGraph from "../modules/graph/AllCardsGraph";
import { noteLinks, noteNeighborhood } from "../lib/noteNeighborhood";
import ContextMenu from "../components/ContextMenu";
import { prepareCanvasExport } from "../lib/canvasExport";
import { setLocalePref } from "../lib/i18n";

const note = (id: string): ContentNode => ({ id, title: id, slug: id, markdown: `body ${id}`, source_type: "manual", node_type: "content" });
const NODES = ["a", "b", "c", "d"].map(note);
const edge = (id: string, source: string, target: string, edge_type: string, status: string, origin: string | null): NodeEdge =>
  ({ id, source_node_id: source, target_node_id: target, edge_type, status, origin });
// Every kind of stored edge, each on its own pair so views can be compared by id.
const EDGES: NodeEdge[] = [
  edge("wikilink", "a", "b", "knowledge_link", "active", "wikilink"),
  edge("drawn", "b", "c", "knowledge_link", "active", "manual"),
  edge("supports", "c", "d", "supports", "active", "manual"),
  edge("cites", "d", "a", "cites", "active", "citation"),
  edge("suggested", "a", "c", "suggested_link", "suggested", "semantic"),
  edge("rejected", "b", "d", "suggested_link", "rejected", "semantic"),
  edge("nav", "d", "b", "nav_link", "active", "manual"),
];
const ids = (predicate: (e: NodeEdge) => boolean) => EDGES.filter(predicate).map((e) => e.id).sort();
const BOARD: Canvas = { id: "board", title: "Board", created_at: "", updated_at: "",
  data: { nodes: NODES.map((n, i) => ({ nodeId: n.id, x: i * 300, y: 0, width: 260, height: 200 })) } };

beforeEach(() => {
  setLocalePref("en");
  resetEdgeKindsForTest();
  vi.spyOn(reads.workspace, "edgeManifest").mockResolvedValue([]);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  resetAppState({ data: { ...noWorkspaceData, nodes: NODES, edges: EDGES } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("every view uses its edgeRoles predicate", () => {
  it("the board draws drawsOnBoard and lets only canDelete arrows be deleted", () => {
    const { result } = renderHook(() => useGraphLayout({ nodes: NODES, edges: EDGES, activeCanvas: BOARD,
      mode: "notes", notesView: "canvas", selectedNode: null, selectedId: null,
      graphLocalMode: false, canvasSearch: "", showTagEdges: false, tags: [] }));
    const stored = result.current.displayGraphEdges.filter((e) => EDGES.some((s) => s.id === e.id));
    expect(stored.map((e) => e.id).sort()).toEqual(ids(drawsOnBoard));
    for (const drawn of stored) {
      expect(drawn.deletable).toBe(canDelete(EDGES.find((s) => s.id === drawn.id)!));
    }
  });

  it("a board arrow is named by its two notes' titles, never React Flow's \"Edge from <id> to <id>\"", () => {
    const { result } = renderHook(() => useGraphLayout({ nodes: NODES, edges: EDGES, activeCanvas: BOARD,
      mode: "notes", notesView: "canvas", selectedNode: null, selectedId: null,
      graphLocalMode: false, canvasSearch: "", showTagEdges: false, tags: [] }));
    const drawn = result.current.displayGraphEdges.find((e) => e.id === "drawn")!;
    expect(drawn.ariaLabel).toBe("b → c");
    for (const edge of result.current.displayGraphEdges) expect(edge.ariaLabel).toMatch(/^\S+ → \S+$/);
  });

  it("the force graph draws drawsInGraph", () => {
    let resize!: ResizeObserverCallback;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    render(<AllCardsGraph nodes={NODES} edges={EDGES} tags={[]} selectedNodeId={null} onNodeClick={() => {}} />);
    // The graph mounts once its pane has a size.
    act(() => resize([{ contentRect: { width: 600, height: 400 } }] as ResizeObserverEntry[], {} as ResizeObserver));
    const links = (capture.props.graphData as { links: Array<{ source: string; target: string; type: string }> }).links
      .filter((l) => l.type !== "parent");
    const key = (e: { source: string; target: string; type: string }) => `${e.source}>${e.target}:${e.type}`;
    expect(links.map(key).sort()).toEqual(EDGES.filter(drawsInGraph)
      .map((e) => key({ source: e.source_node_id, target: e.target_node_id, type: e.edge_type })).sort());
  });

  it("the info panel's relations hold the drawsInGraph neighbours of a note", () => {
    const listed = noteNeighborhood(NODES[0]!, NODES, EDGES).relations.filter((r) => r.edgeType).map((r) => r.node.title).sort();
    const expected = EDGES.filter((e) => drawsInGraph(e) && (e.source_node_id === "a" || e.target_node_id === "a"))
      .map((e) => (e.source_node_id === "a" ? e.target_node_id : e.source_node_id)).sort();
    expect(listed).toEqual(expected);
  });

  it("the board's JSON Canvas export holds drawsInGraph", async () => {
    const result = await prepareCanvasExport(BOARD, NODES, EDGES);
    expect(result.canvas.edges?.map((e) => e.id).sort()).toEqual(ids(drawsInGraph));
  });

  it("backlinks and outgoing links are countsAsBacklink", () => {
    const links = (n: ContentNode) => noteLinks(noteNeighborhood(n, NODES, EDGES).relations);
    const backlinkPairs = NODES.flatMap((n) => links(n).backlinks.map((src) => `${src.id}>${n.id}`)).sort();
    const outgoingPairs = NODES.flatMap((n) => links(n).outgoing.map((tgt) => `${n.id}>${tgt.id}`)).sort();
    const expected = EDGES.filter(countsAsBacklink).map((e) => `${e.source_node_id}>${e.target_node_id}`).sort();
    expect(backlinkPairs).toEqual(expected);
    expect(outgoingPairs).toEqual(expected);
  });
});

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

describe("the D74 bugs", () => {
  it("(1) Delete on a [[link]]'s arrow removes nothing and says why; a drawn arrow is removed", async () => {
    const remove = vi.spyOn(relationWriter, "remove").mockResolvedValue(undefined as never);
    const { result } = renderHook(() => useBoardWorkspace({ ...boardOptions(), graphView: useGraphViewState() }));
    await act(async () => { await result.current.actions.onEdgeDeleted("wikilink"); });
    expect(remove).not.toHaveBeenCalled();
    expect(getAppState().toasts.at(-1)?.message).toMatch(/comes from the note's text/);
    await act(async () => { await result.current.actions.onEdgeDeleted("drawn"); });
    expect(remove).toHaveBeenCalledExactlyOnceWith("drawn");
  });

  it("(2) a [[link]]'s arrow menu offers no type change and no delete, only the explanation", () => {
    const remove = vi.spyOn(relationWriter, "remove");
    const connect = vi.spyOn(relationWriter, "connect");
    render(<ContextMenu menu={{ kind: "graph-edge", edgeId: "wikilink", edgeType: "knowledge_link", x: 1, y: 1 }}
      onClose={vi.fn()} onSelectNode={vi.fn()} onStartRename={vi.fn()} onCreateAt={vi.fn()} />);
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete arrow" })).toBeNull();
    expect(screen.getByRole("note").textContent).toMatch(/Edit the note to change or remove it/);
    expect(remove).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("(3) drawing A→B by hand when A's [[B]] already draws it adds no second arrow", async () => {
    const connect = vi.spyOn(relationWriter, "connect").mockResolvedValue(undefined as never);
    const { result } = renderHook(() => useBoardWorkspace({ ...boardOptions(), graphView: useGraphViewState() }));
    await act(async () => { await result.current.actions.onConnect("a", "b"); });
    expect(connect).not.toHaveBeenCalled();
    expect(getAppState().toasts.at(-1)?.message).toMatch(/already linked/);
    // The other direction is a new arrow.
    await act(async () => { await result.current.actions.onConnect("b", "a"); });
    expect(connect).toHaveBeenCalledExactlyOnceWith("b", "a", "knowledge_link");
  });

  it("(4) a suggested or rejected suggestion is no backlink, and a pair linked twice is listed once", () => {
    const edges = [...EDGES, edge("drawn-twice", "a", "b", "knowledge_link", "active", "manual")];
    const backlinks = (id: string) => noteLinks(noteNeighborhood(NODES.find((n) => n.id === id)!, NODES, edges).relations).backlinks.map((n) => n.id);
    expect(backlinks("c")).toEqual(["b"]); // not the suggestion a→c
    expect(backlinks("d")).toEqual([]);    // not the rejected b→d, not supports
    expect(backlinks("b")).toEqual(["a"]); // [[link]] + drawn arrow: once
  });
});
