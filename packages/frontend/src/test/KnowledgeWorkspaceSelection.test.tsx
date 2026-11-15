// @vitest-environment jsdom
import type { ComponentProps, MouseEvent } from "react";
import { useContext } from "react";
import type { Node, ReactFlowProps, ReactFlowInstance } from "@xyflow/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const flow = vi.hoisted(() => ({ props: {} as ReactFlowProps, onNodeEditStart: (_nodeId: string): (() => void) | void => {} }));
vi.mock("@xyflow/react", async importOriginal => ({
  ...await importOriginal<typeof import("@xyflow/react")>(),
  ReactFlow: function MockFlow(props: ReactFlowProps) {
    flow.props = props;
    flow.onNodeEditStart = useContext(GraphCallbacksContext).onNodeEditStart;
    return <div />;
  },
}));
vi.mock("../components/CardNode", () => ({ CardNode: () => null }));
vi.mock("../components/SectionNode", () => ({ SectionNode: () => null }));
import KnowledgeWorkspace from "../components/KnowledgeWorkspace";
import type { BoardActions } from "../components/KnowledgeWorkspace";
import { GraphCallbacksContext } from "../components/graphCallbacks";
import { addToast, getAppState, resetAppState, setAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";
import { ApiError } from "../lib/api";
import { fromJsonCanvas } from "../lib/jsonCanvas";
import { reportWriteFailure } from "../lib/data/writeErrors";

const cards: Node[] = [
  { id: "a", type: "card", position: { x: 0, y: 0 }, data: {}, style: { width: 330, height: 270 } },
  { id: "b", type: "card", position: { x: 400, y: 0 }, data: {}, style: { width: 260 } },
  { id: "group", type: "section", position: { x: -40, y: -64 }, data: { sectionId: "group" } },
];
const board = { id: "board", title: "Board", created_at: "", updated_at: "", data: { nodes: [] } };
function mount(graphNodes = cards, onImportCanvas?: BoardActions["onImportCanvas"], boardExtra: Partial<ComponentProps<typeof KnowledgeWorkspace>["board"]> = {}) {
  // Like the real writer, an applied move becomes the board's layout (undo
  // compares against it to leave cards moved since alone).
  const onApplyPositions = vi.fn(async (updates: Array<{ nodeId: string; x: number; y: number }>, sections: Array<{ id: string; x: number; y: number }> = []) => {
    const active = getAppState().activeCanvas;
    if (!active) return;
    const nodes = new Map(active.data.nodes.map((n) => [n.nodeId, n]));
    for (const u of updates) nodes.set(u.nodeId, { ...nodes.get(u.nodeId), ...u });
    const groups = new Map((active.data.sections ?? []).map((g) => [g.id, g]));
    for (const g of sections) { const old = groups.get(g.id); if (old) groups.set(g.id, { ...old, ...g }); }
    act(() => setAppState({ activeCanvas: { ...active, data: { ...active.data, nodes: [...nodes.values()], sections: [...groups.values()] } } }));
  });
  const unused = vi.fn();
  const props: ComponentProps<typeof KnowledgeWorkspace> = {
    board: {
      displayGraphNodes: graphNodes, displayGraphEdges: [], canvasSearch: "",
      graphLocalMode: false, showTagEdges: false, parentMode: false, display: { settings: {}, set: unused },
      setGraphLocalMode: unused, setCanvasSearch: unused, setParentMode: unused,
      ...boardExtra,
    },
    actions: {
      onApplyPositions, onSelectNode: vi.fn(), onImportCanvas: onImportCanvas ?? unused,
      onAddToCanvas: unused, onTidyCanvas: unused, onArrangeTree: unused,
      onGroupSelection: unused, onSetNodesColor: unused,
      onGraphDrop: unused, onInsertImages: async () => {},
      onToggleTagEdges: unused, onNodeUpdate: unused, onNodeResized: unused, onSectionResized: unused, onRemoveSections: async () => null,
      onSectionTitleChange: unused, onNodeTitleChange: unused,
      onResetCardSize: unused, onOpenSubCanvas: unused, onToggleBranch: unused, onCenterBoard: unused, onOpenCard: unused, onShowMoreChildren: unused, onConnect: unused,
      onParentConnect: unused, onEdgeDeleted: unused, onRemoveCards: unused,
      onNodeContextMenu: unused,
      onPaneContextMenu: unused, onEdgeContextMenu: unused, onDoubleClickCanvas: unused,
      onCreateSection: unused,
    },
    mobileView: "graph", onClickWikilink: unused,
  };
  render(<KnowledgeWorkspace {...props} />);
  return onApplyPositions;
}
function select(ids: string[], selected: boolean) {
  act(() => flow.props.onNodesChange?.(ids.map(id => ({ type: "select", id, selected }))));
}
beforeEach(() => {
  setLocalePref("en");
  resetAppState({ activeCanvas: board });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps an active editor centred when the canvas changes size and releases the observer on exit", () => {
  let resized: ResizeObserverCallback = () => {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resized = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  let nextFrame: FrameRequestCallback = () => {};
  vi.stubGlobal("requestAnimationFrame", vi.fn(callback => { nextFrame = callback; return 42; }));
  const cancel = vi.fn();
  vi.stubGlobal("cancelAnimationFrame", cancel);
  mount();
  const setCenter = vi.fn();
  act(() => flow.props.onInit?.({ fitView: vi.fn(), getNode: () => cards[0], getZoom: () => 1,
    setCenter, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport: vi.fn(),
  } as unknown as ReactFlowInstance));
  let release: (() => void) | void;
  act(() => { release = flow.onNodeEditStart("a"); });
  expect(observe).toHaveBeenCalledWith(document.querySelector(".kw-canvas-wrap"));
  const entry = { contentRect: { width: 390, height: 740 } } as ResizeObserverEntry;
  act(() => resized([entry], {} as ResizeObserver));
  expect(setCenter).toHaveBeenCalledTimes(1);
  act(() => nextFrame(0));
  expect(setCenter).toHaveBeenCalledTimes(2);
  act(() => resized([entry], {} as ResizeObserver));
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  act(() => release?.());
  expect(disconnect).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledWith(42);
});

it("entering a card editor brings small text to 1x without changing stored geometry or zooming out an already enlarged view", () => {
  const save = mount();
  let zoom = 0.55;
  const setCenter = vi.fn();
  const instance = { fitView: vi.fn(),
    getNode: (id: string) => cards.find(n => n.id === id),
    getZoom: () => zoom, setCenter, getViewport: () => ({ x: 0, y: 0, zoom }), setViewport: vi.fn(),
  } as unknown as ReactFlowInstance;
  act(() => flow.props.onInit?.(instance));
  act(() => flow.onNodeEditStart("a"));
  expect(setCenter).toHaveBeenLastCalledWith(165, 135, { zoom: 1, duration: 280 });
  act(() => setAppState({ selectedId: "a" }));
  expect(setCenter).toHaveBeenCalledTimes(1);
  expect(flow.props.nodes?.find(n => n.id === "a")?.style).toEqual({ width: 330, height: 270 });
  expect(save).not.toHaveBeenCalled();
  zoom = 1.4;
  act(() => flow.onNodeEditStart("a"));
  expect(setCenter).toHaveBeenLastCalledWith(165, 135, { zoom: 1.4, duration: 280 });
  act(() => { flow.onNodeEditStart("missing"); flow.onNodeEditStart("group"); });
  expect(setCenter).toHaveBeenCalledTimes(2);
});

it("a card clicked on the board keeps the camera; a selection made elsewhere still pans to its card", () => {
  mount();
  const setCenter = vi.fn();
  act(() => flow.props.onInit?.({ fitView: vi.fn(), getNode: (id: string) => cards.find(n => n.id === id), getZoom: () => 1,
    setCenter, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport: vi.fn(),
  } as unknown as ReactFlowInstance));
  const click = (node: Node, metaKey = false) =>
    flow.props.onNodeClick?.({ metaKey, ctrlKey: false, shiftKey: false } as unknown as MouseEvent, node);
  // The note selection follows each click (onSelectNode), the board stays put.
  act(() => click(cards[0]));
  act(() => setAppState({ selectedId: "a" }));
  act(() => click(cards[1], true));
  act(() => setAppState({ selectedId: "b" }));
  expect(setCenter).not.toHaveBeenCalled();
  // Choosing a card's note in the tree brings the board to it.
  act(() => setAppState({ selectedId: "a" }));
  expect(setCenter).toHaveBeenCalledTimes(1);
});

it("⌘/Ctrl/Shift-click adds a card to the selection or takes it out, whatever React Flow saw of the key", () => {
  mount();
  const click = (node: Node, keys: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey", boolean>> = {}) =>
    flow.props.onNodeClick?.({ metaKey: false, ctrlKey: false, shiftKey: false, ...keys } as unknown as MouseEvent, node);
  const selected = () => flow.props.nodes?.filter(n => n.selected).map(n => n.id);
  act(() => click(cards[0]));
  // React Flow missed the key and replaced its selection; the click still adds.
  act(() => {
    flow.props.onNodesChange?.([{ type: "select", id: "a", selected: false }, { type: "select", id: "b", selected: true }]);
    click(cards[1], { ctrlKey: true });
  });
  expect(selected()).toEqual(["a", "b"]);
  expect(screen.getByTitle("Align bottom")).toBeTruthy();
  act(() => click(cards[1], { metaKey: true }));
  expect(selected()).toEqual(["a"]);
  expect(screen.queryByTitle("Align bottom")).toBeNull();
});

it("⌘-click on a card's body adds it even though React Flow selected it at mousedown and the board re-rendered", () => {
  mount();
  const click = (node: Node, keys: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey", boolean>> = {}) =>
    flow.props.onNodeClick?.({ metaKey: false, ctrlKey: false, shiftKey: false, ...keys } as unknown as MouseEvent, node);
  const selected = () => flow.props.nodes?.filter(n => n.selected).map(n => n.id);
  const wrap = document.querySelector(".kw-canvas-wrap")!;
  act(() => { fireEvent.pointerDown(wrap); click(cards[0]); });
  // The second press: React Flow selects "b" at mousedown (it saw ⌘), the board renders, then the click comes.
  act(() => { fireEvent.pointerDown(wrap); });
  act(() => { flow.props.onNodesChange?.([{ type: "select", id: "b", selected: true }]); });
  act(() => click(cards[1], { metaKey: true }));
  expect(selected()).toEqual(["a", "b"]);
  expect(screen.getByTitle("Align bottom")).toBeTruthy();
});

it("accepts selection and deselection, including groups, without reviving the old box selection", () => {
  mount();
  select(["a", "b", "group"], true);
  expect(flow.props.nodes?.filter(n => n.selected).map(n => n.id)).toEqual(["a", "b", "group"]);
  expect(screen.getByTitle("Align bottom")).toBeTruthy();
  select(["a", "b", "group"], false);
  expect(flow.props.nodes?.filter(n => n.selected)).toEqual([]);
  expect(screen.queryByTitle("Align bottom")).toBeNull();
  select(["b"], true);
  expect(flow.props.nodes?.filter(n => n.selected).map(n => n.id)).toEqual(["b"]);
});

it("lays out headings at the current zoom without saving or changing frame geometry", () => {
  const groups: Node[] = [
    { ...cards[2], position: { x: 291, y: 100 }, style: { width: 730, height: 374 } },
    { ...cards[2], id: "inner", position: { x: 325, y: 107 }, style: { width: 460, height: 340 } },
  ];
  const save = mount(groups);
  act(() => flow.props.onViewportChange?.({ x: 0, y: 0, zoom: 0.31 }));
  const rendered = flow.props.nodes!;
  expect(rendered.map(n => n.position)).toEqual(groups.map(n => n.position));
  expect(rendered.map(n => n.style)).toEqual(groups.map(n => n.style));
  expect(rendered.map(n => n.data.heading)).toEqual(expect.arrayContaining([
    expect.objectContaining({ scale: 1 / 0.31 }),
  ]));
  expect(save).not.toHaveBeenCalled();
});

it("aligns using received measurements and sends one position-only batch with one undo", async () => {
  const save = mount();
  select(["a", "b", "group"], true);
  act(() => flow.props.onNodesChange?.([
    { type: "dimensions", id: "a", dimensions: { width: 330, height: 270 } },
    { type: "dimensions", id: "b", dimensions: { width: 260, height: 81 } },
  ]));
  await act(async () => fireEvent.click(screen.getByTitle("Align bottom")));
  expect(save).toHaveBeenCalledExactlyOnceWith([{ nodeId: "b", x: 400, y: 189 }]);
  await act(async () => fireEvent.click(screen.getByTitle("Undo canvas move")));
  expect(save).toHaveBeenLastCalledWith([{ nodeId: "b", x: 400, y: 0 }], []);
  expect(save).toHaveBeenCalledTimes(2);
});

it("clears the selection on a canvas switch even when both boards contain the same cards", () => {
  mount();
  select(["a", "b"], true);
  act(() => setAppState({ activeCanvas: { ...board, id: "another-board" } }));
  expect(flow.props.nodes?.filter(n => n.selected)).toEqual([]);
  expect(screen.queryByTitle("Align bottom")).toBeNull();
});

it("saves a mixed gesture and its hidden members once, then restores the same set once", async () => {
  setAppState({ activeCanvas: { ...board, data: {
    nodes: [{ nodeId: "a", x: 0, y: 0 }, { nodeId: "b", x: 400, y: 0 }, { nodeId: "hidden", x: 100, y: 20 }],
    sections: [
      { id: "group", x: -40, y: -64, width: 800, height: 400, title: "Wide" },
      { id: "other", x: -40, y: -64, width: 400, height: 400, title: "Narrow" },
    ],
  } } });
  const save = mount([...cards, { ...cards[2], id: "other", data: { sectionId: "other" } }]);
  const dragged = flow.props.nodes!;
  const group = dragged.find(n => n.id === "group")!;
  act(() => flow.props.onNodeDragStart?.(new MouseEvent("mousedown"), group, dragged));
  await act(async () => flow.props.onNodeDragStop?.(new MouseEvent("mouseup"), { ...group, position: { x: -15, y: -44 } }, dragged));
  expect(save).toHaveBeenCalledExactlyOnceWith([
    { nodeId: "a", x: 25, y: 20 }, { nodeId: "b", x: 425, y: 20 }, { nodeId: "hidden", x: 125, y: 40 },
  ], [{ id: "group", x: -15, y: -44 }, { id: "other", x: -15, y: -44 }]);
  await act(async () => fireEvent.click(screen.getByTitle("Undo canvas move")));
  expect(save).toHaveBeenLastCalledWith([
    { nodeId: "a", x: 0, y: 0 }, { nodeId: "b", x: 400, y: 0 }, { nodeId: "hidden", x: 100, y: 20 },
  ], [{ id: "group", x: -40, y: -64 }, { id: "other", x: -40, y: -64 }]);
  expect(save).toHaveBeenCalledTimes(2);
});

it("does not save or record an inverse for a missing drag start or a zero-distance gesture", async () => {
  const save = mount();
  const node = flow.props.nodes![0];
  await act(async () => flow.props.onNodeDragStop?.(new MouseEvent("mouseup"), node, [node]));
  act(() => flow.props.onNodeDragStart?.(new MouseEvent("mousedown"), node, [node]));
  await act(async () => flow.props.onNodeDragStop?.(new MouseEvent("mouseup"), node, [node]));
  expect(save).not.toHaveBeenCalled();
  expect((screen.getByTitle("Undo canvas move") as HTMLButtonElement).disabled).toBe(true);
});

async function chooseFile(text: () => Promise<string>) {
  const file = new File([], "Fixture.canvas", { type: "application/json" });
  Object.defineProperty(file, "text", { value: text });
  await act(async () => fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } }));
}

it("reports an unreadable file without a blocking alert or starting an import, then accepts selecting the file again", async () => {
  const importCanvas = vi.fn(async () => "new-board");
  const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
  mount(cards, importCanvas);
  await chooseFile(async () => '{"nodes":[');
  expect(importCanvas).not.toHaveBeenCalled();
  expect(getAppState().toasts).toHaveLength(1);
  expect(getAppState().toasts[0].message).toContain("isn't in the right format");
  expect(alert).not.toHaveBeenCalled();
  await chooseFile(async () => '{"nodes":[]}');
  expect(importCanvas).toHaveBeenCalledExactlyOnceWith("Fixture", { nodes: [] });
  alert.mockRestore();
});

it("distinguishes a file read failure from a rejected import", async () => {
  const importCanvas = vi.fn(async () => "new-board");
  mount(cards, importCanvas);
  await chooseFile(async () => { throw new Error("disk failed"); });
  expect(importCanvas).not.toHaveBeenCalled();
  expect(getAppState().toasts[0].message).toBe("Could not read this file. Choose it again.");
});

it("shows a format explanation before writing and warns of partial creation after a server failure", async () => {
  const importCanvas = vi.fn(async (_title, raw) => { fromJsonCanvas(raw); return "board"; });
  mount(cards, importCanvas);
  await chooseFile(async () => '{"nodes":[null]}');
  expect(getAppState().toasts[0].message).toContain("Card 1");
  importCanvas.mockRejectedValueOnce(new ApiError(503, '{}'));
  await chooseFile(async () => '{}');
  expect(getAppState().toasts[1].message).toContain("Some content may already have been created");
  expect(getAppState().toasts[1].message).toContain("Could not reach the server");
});

it("does not notify the same writer refusal twice", async () => {
  const error = new ApiError(403, '{}');
  mount(cards, async () => { reportWriteFailure(error, addToast); throw error; });
  await chooseFile(async () => '{}');
  expect(getAppState().toasts).toHaveLength(1);
});

it("caps only cards that grow with their note: not a resized card, not a folded one (GAP-175)", () => {
  mount();
  const cls = (id: string) => flow.props.nodes?.find(n => n.id === id)?.className ?? "";
  expect(cls("a")).not.toContain("graph-card-node--auto-height");
  expect(cls("b")).toContain("graph-card-node--auto-height");
  expect(cls("group")).not.toContain("graph-card-node--auto-height");
  cleanup();
  mount(cards.map((n) => n.id === "b" ? { ...n, data: { folded: true }, style: { ...n.style, height: 44 } } : n));
  expect(cls("b")).not.toContain("graph-card-node--auto-height");
});

it("with several cards selected the bar says how many, and Fold card folds all of them at once; Expand card shows only when all are folded", () => {
  const set = vi.fn();
  mount(cards, undefined, { display: { settings: { foldedIds: ["a"] }, set } });
  select(["a", "b"], true);
  expect(screen.getByText("2 cards selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Fold card" }));
  expect(set).toHaveBeenLastCalledWith({ foldedIds: ["a", "b"] });
  cleanup();
  mount(cards.map((n) => n.type === "card" ? { ...n, data: { folded: true } } : n), undefined, { display: { settings: { foldedIds: ["a", "b"] }, set } });
  select(["a", "b"], true);
  fireEvent.click(screen.getByRole("button", { name: "Expand card" }));
  expect(set).toHaveBeenLastCalledWith({ expandedIds: ["a", "b"] });
});

it("Reset size shows only when a selected card has a size of its own", () => {
  const sized = { nodes: [{ nodeId: "a", x: 0, y: 0, width: 330, height: 270 }, { nodeId: "b", x: 400, y: 0 }] };
  mount(cards, undefined, { layout: sized });
  select(["b", "group"], true);
  select(["a"], true);
  expect(screen.getByRole("button", { name: "Reset size" })).toBeTruthy();
  select(["a"], false);
  expect(screen.queryByRole("button", { name: "Reset size" })).toBeNull();
});

it("shows no board tab strip: no per-board tab, delete ×, or new-board ＋, while 「顯示」 stays", () => {
  mount();
  expect(document.querySelector(".canvas-tabbar")).toBeNull();
  expect(document.querySelector(".canvas-tab")).toBeNull();
  expect(screen.queryByTitle("Delete canvas")).toBeNull();
  expect(screen.queryByTitle("New canvas")).toBeNull();
  expect(screen.getByRole("button", { name: "Display" })).toBeTruthy();
});

it("inside a sub-canvas the only strip is the way back to the parent", () => {
  const back = vi.fn();
  mount(cards, undefined, { parentCanvasTitle: "Parent board", onBackToParentCanvas: back });
  const bar = document.querySelector(".canvas-tabbar")!;
  expect(bar.querySelectorAll("button")).toHaveLength(1);
  expect(document.querySelector(".canvas-tab")).toBeNull();
  fireEvent.click(screen.getByText("← Parent board"));
  expect(back).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Display" })).toBeTruthy();
});
