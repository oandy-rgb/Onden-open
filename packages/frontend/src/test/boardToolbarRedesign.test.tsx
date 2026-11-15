import { useBoardFullscreen } from "../hooks/useBoardFullscreen";
// The whiteboard's edit bar (docs: changes/2026-10-30-board-toolbar.md): one tool bar at the bottom with a
// single lit tool, the pen's own toolbar only with the pen, a bar over the selected card, 「顯示」 and full
// screen in the top-right corner, undo / zoom / fit in the bottom-left, and no React Flow credit line.
import { useEffect, type ComponentProps, type ReactNode } from "react";
import type { Node, ReactFlowProps } from "@xyflow/react";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const flow = vi.hoisted(() => {
  const state = { props: {} as ReactFlowProps, fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), instance: {} as never };
  state.instance = { fitView: state.fitView, zoomIn: state.zoomIn, zoomOut: state.zoomOut, getZoom: () => 1, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport: () => {}, setCenter: () => {}, getNode: () => undefined } as never;
  return state;
});
vi.mock("@xyflow/react", async (original) => ({
  ...await original<typeof import("@xyflow/react")>(),
  ReactFlow: function MockFlow(props: ReactFlowProps & { children?: ReactNode }) {
    flow.props = props;
    useEffect(() => { props.onInit?.(flow.instance); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, like React Flow
    return <div data-testid="flow">{props.children}</div>;
  },
  Background: () => null,
  MiniMap: () => <div data-testid="minimap" />,
  NodeToolbar: ({ nodeId, children }: { nodeId: string; children: ReactNode }) => <div data-testid="node-toolbar" data-node-id={nodeId}>{children}</div>,
}));
vi.mock("../components/CardNode", () => ({ CardNode: () => null }));
vi.mock("../components/SectionNode", () => ({ SectionNode: () => null }));
vi.mock("../components/CanvasInkLayer", () => ({
  default: ({ penActive, pen }: { penActive: boolean; pen: { tool: string } }) => <div data-testid="ink-layer" data-pen-active={penActive} data-pen-tool={pen.tool} />,
}));
import KnowledgeWorkspace from "../components/KnowledgeWorkspace";
import { resetAppState, setAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";
import { useCanvasTools } from "../hooks/useCanvasTools";

const board = { id: "board", title: "Board", created_at: "", updated_at: "", data: { nodes: [] } };
const card = (id: string, branch?: { expanded: boolean; below: number }): Node => ({ id, type: "card", position: { x: 0, y: 0 }, data: { branch } });

function mount(over: { nodes?: Node[]; tree?: NonNullable<ComponentProps<typeof KnowledgeWorkspace>["board"]["tree"]>; onScreen?: boolean; tagBoard?: boolean; actions?: Record<string, unknown>; display?: { settings: Record<string, unknown>; set: (d: unknown) => void } } = {}) {
  const unused = vi.fn();
  const actions = { ...over.actions } as Record<string, ReturnType<typeof vi.fn>>;
  const props = {
    board: {
      displayGraphNodes: over.nodes ?? [], displayGraphEdges: [], canvasSearch: "", graphLocalMode: false, showTagEdges: false, parentMode: false,
      setGraphLocalMode: unused, setCanvasSearch: unused, setParentMode: unused, tree: over.tree, tagBoard: over.tagBoard, inkEnabled: !over.tagBoard,
      display: over.display ?? { settings: {}, set: unused },
    },
    actions: new Proxy(actions, { get: (target, key: string) => target[key] ?? unused }),
    mobileView: "graph", createOpen: false, draftTitle: "", setCreateOpen: unused, setDraftTitle: unused, onCreateNode: unused, onClickWikilink: unused,
  } as unknown as ComponentProps<typeof KnowledgeWorkspace>;
  const view = render(<KnowledgeWorkspace {...props} onScreen={over.onScreen} />);
  return { showBoard: (onScreen: boolean) => view.rerender(<KnowledgeWorkspace {...props} onScreen={onScreen} />) };
}
const toolbar = () => screen.getByRole("toolbar", { name: "Board tools" });
const lit = () => within(toolbar()).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label"));

beforeEach(() => { setLocalePref("en"); localStorage.clear(); resetAppState({ activeCanvas: board }); document.body.className = ""; vi.clearAllMocks(); });
afterEach(cleanup);

describe("the board's tool bar", () => {
  it("offers select, move, pen, sticky note, frame, add card and ⋯, with exactly one tool lit", () => {
    mount();
    expect(within(toolbar()).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(
      ["Select", "Move", "Pen", "Sticky note", "Frame", "Add card", "More tools"]);
    expect(lit()).toEqual(["Select"]);
    for (const [name, other] of [["Move", "Move"], ["Sticky note", "Sticky note"], ["Frame", "Frame"], ["Pen", "Pen"], ["Select", "Select"]]) {
      fireEvent.click(within(toolbar()).getByRole("button", { name }));
      expect(lit(), `after ${name}`).toEqual([other]);
    }
  });

  it("the pen button starts drawing: the ink layer is told the pen is active, and a tool key still reaches the shared pen", async () => {
    mount();
    // The ink layer is lazy: wait for it rather than count on an earlier test having loaded it (under a loaded machine it hadn't).
    expect(await screen.findByTestId("ink-layer")).toHaveAttribute("data-pen-active", "false");
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Pen" }));
    expect(screen.getByTestId("ink-layer")).toHaveAttribute("data-pen-active", "true");
    expect(screen.getByTestId("ink-layer")).toHaveAttribute("data-pen-tool", "pen");
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Select" }));
    fireEvent.keyDown(window, { key: "e" });
    expect(screen.getByTestId("ink-layer")).toHaveAttribute("data-pen-active", "true");
    expect(screen.getByTestId("ink-layer")).toHaveAttribute("data-pen-tool", "eraser");
    expect(lit()).toEqual(["Pen"]);
  });

  it("the hand tool pans with a plain drag and does not box-select", () => {
    mount();
    expect(flow.props.panOnDrag).toEqual([1, 2]);
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Move" }));
    expect(flow.props.panOnDrag).toEqual([0, 1, 2]);
    expect(flow.props.selectionOnDrag).toBe(false);
  });

  it("the rarely used switches and arrangements are in ⋯, not on the bar", () => {
    mount();
    expect(screen.queryByRole("menuitemradio", { name: /Snap to grid/ })).toBeNull();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "More tools" }));
    for (const name of [/Snap to grid/, /Parent mode/, /Shared tags/]) expect(screen.getByRole("menuitemradio", { name })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Tidy up/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Arrange as tree/ })).toBeInTheDocument();
    for (const name of [/Export board/, /Import/]) expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
  });

  it("adding a card opens the picker without lighting a tool", () => {
    mount();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Add card" }));
    expect(within(toolbar()).getByRole("button", { name: "Add card" })).toHaveAttribute("aria-expanded", "true");
    expect(lit()).toEqual(["Select"]);
  });

  it("the old tool rail and the row of switches above the board are gone", () => {
    mount();
    expect(document.querySelector(".canvas-tools, .canvas-density-control")).toBeNull();
    expect(screen.queryByRole("button", { name: "Follow sub-notes" })).toBeNull();
  });
});

describe("the React Flow credit line", () => {
  it("is hidden, and the built-in zoom box is not drawn", () => {
    mount();
    expect(flow.props.proOptions).toEqual({ hideAttribution: true });
  });
});

describe("the minimap", () => {
  it("is off until the person turns it on in 「顯示」", () => {
    mount();
    expect(screen.queryByTestId("minimap")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(screen.getByRole("switch", { name: "Minimap" }));
    expect(screen.getByTestId("minimap")).toBeInTheDocument();
  });
});

describe("「顯示」", () => {
  const tree = (over: Partial<NonNullable<ComponentProps<typeof KnowledgeWorkspace>["board"]["tree"]>> = {}) =>
    ({ mode: "auto" as const, depth: 2 as const, childless: false, crumbs: [], backTo: vi.fn(), setMode: vi.fn(), setDepth: vi.fn(), ...over });

  it("holds only settings: follow sub-notes, levels, cards folded or expanded, titles-only, minimap", () => {
    mount({ tree: tree() });
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const panel = screen.getByRole("dialog", { name: "Display" });
    expect(within(panel).getAllByRole("switch").map((s) => s.getAttribute("aria-label"))).toEqual(["Follow sub-notes", "Titles only when zoomed out", "Minimap"]);
    expect(within(within(panel).getByRole("group", { name: "Cards" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["Fold card", "Expand card"]);
    expect(within(within(panel).getByRole("group", { name: "Levels" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["1", "2", "3", "All"]);
    for (const name of [/Arrange as tree/, /Export board/, /Import/]) expect(within(panel).queryByRole("button", { name })).toBeNull();
  });

  it("a switch and a level press choose them", () => {
    const setMode = vi.fn(); const setDepth = vi.fn(); const setDisplay = vi.fn();
    mount({ tree: tree({ setMode, setDepth }), display: { settings: { foldedIds: ["a"] }, set: setDisplay } });
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(screen.getByRole("switch", { name: "Follow sub-notes" }));
    expect(setMode).toHaveBeenCalledWith("manual");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(setDepth).toHaveBeenCalledWith("all");
    fireEvent.click(screen.getByRole("switch", { name: "Titles only when zoomed out" }));
    expect(setDisplay).toHaveBeenLastCalledWith({ foldedIds: ["a"], titleOnlyFar: false });
    // 卡片：摺起來 — every card: the default moves and each card's own choice is dropped.
    fireEvent.click(within(screen.getByRole("group", { name: "Cards" })).getByRole("button", { name: "Fold card" }));
    expect(setDisplay).toHaveBeenLastCalledWith({ cardDefault: "folded" });
  });

  it("a manual board shows no levels, and a tag's board no follow switch", () => {
    mount({ tree: tree({ mode: "manual" }) });
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    expect(screen.queryByRole("group", { name: "Levels" })).toBeNull();
    cleanup();
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    expect(screen.queryByRole("switch", { name: "Follow sub-notes" })).toBeNull();
  });

  it("arrange as tree in ⋯ runs the arrangement", () => {
    const onArrangeTree = vi.fn();
    mount({ actions: { onArrangeTree } });
    fireEvent.click(within(toolbar()).getByRole("button", { name: "More tools" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Arrange as tree/ }));
    expect(onArrangeTree).toHaveBeenCalledTimes(1);
  });
});

describe("phone: full screen for good", () => {
  const Probe = ({ always, onScreen }: { always: boolean; onScreen: boolean }) => {
    const { fullscreen, locked } = useBoardFullscreen({ toolIsSelect: true, onScreen, always });
    return <span data-testid="probe">{String(fullscreen)}/{String(locked)}</span>;
  };
  const body = (cls: string) => document.body.classList.contains(cls);
  it("is on as soon as the board is on screen, ends off screen, and comes back; Esc does not leave", () => {
    const { rerender } = render(<Probe always onScreen />);
    expect(screen.getByTestId("probe")).toHaveTextContent("true/true");
    expect(body("onden-board-fullscreen") && body("onden-board-locked")).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(body("onden-board-locked")).toBe(true);
    rerender(<Probe always onScreen={false} />);
    expect(body("onden-board-fullscreen") || body("onden-board-locked")).toBe(false);
    rerender(<Probe always onScreen />);
    expect(body("onden-board-locked")).toBe(true);
  });
  it("without `always` (desktop, tablet) nothing is on until chosen and the page is never locked", () => {
    render(<Probe always={false} onScreen />);
    expect(screen.getByTestId("probe")).toHaveTextContent("false/false");
    expect(body("onden-board-fullscreen") || body("onden-board-locked")).toBe(false);
  });
});

describe("full screen", () => {
  it("hides the app's top bar and the note's tabs through <body>, swaps the icon's meaning, and Esc comes back", () => {
    mount();
    const enter = screen.getByRole("button", { name: "Full screen" });
    expect(enter).toHaveAttribute("aria-pressed", "false");
    expect(document.body).not.toHaveClass("onden-board-fullscreen");
    fireEvent.click(enter);
    expect(document.body).toHaveClass("onden-board-fullscreen");
    expect(screen.getByRole("button", { name: "Exit full screen" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.body).not.toHaveClass("onden-board-fullscreen");
    expect(screen.getByRole("button", { name: "Full screen" })).toBeInTheDocument();
  });

  it("leaving the board brings the bars back, and nothing is stored", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    cleanup();
    expect(document.body).not.toHaveClass("onden-board-fullscreen");
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/fullscreen/i);
  });

  it("the full-screen button sits beside 「顯示」 in the top-right corner", () => {
    mount();
    const corner = screen.getByRole("button", { name: "Display" }).parentElement!;
    expect(corner).toHaveClass("board-view-controls");
    expect(within(corner).getByRole("button", { name: "Full screen" })).toBeInTheDocument();
  });
});

describe("the bar over the selected card", () => {
  const select = (id: string) => act(() => { setAppState({ selectedId: id }); });

  it("appears on the selected card with open, colour, sub-notes and ⋯, and its actions reach the board", () => {
    const onOpenCard = vi.fn(); const onToggleBranch = vi.fn(); const onSetNodesColor = vi.fn(); const onNodeContextMenu = vi.fn(); const onCenterBoard = vi.fn();
    mount({
      nodes: [card("a", { expanded: true, below: 0 }), card("b")],
      tree: { mode: "auto", depth: 2, childless: false, crumbs: [], backTo: vi.fn(), setMode: vi.fn(), setDepth: vi.fn() },
      actions: { onOpenCard, onToggleBranch, onSetNodesColor, onNodeContextMenu, onCenterBoard },
    });
    expect(screen.queryByTestId("node-toolbar")).toBeNull();
    select("a");
    const holder = screen.getByTestId("node-toolbar");
    expect(holder).toHaveAttribute("data-node-id", "a");
    const bar = within(holder).getByRole("toolbar", { name: "Selected card" });
    fireEvent.click(within(bar).getByRole("button", { name: /Open card/ }));
    expect(onOpenCard).toHaveBeenCalledWith("a");
    fireEvent.click(within(bar).getByRole("button", { name: /Centre here/ }));
    expect(onCenterBoard).toHaveBeenCalledWith("a");
    fireEvent.click(within(bar).getByRole("button", { name: /Collapse sub-notes/ }));
    expect(onToggleBranch).toHaveBeenCalledWith("a");
    fireEvent.click(within(bar).getByRole("button", { name: /Colour/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Clear colour" })[0]);
    expect(onSetNodesColor).toHaveBeenCalledWith(["a"], null);
    fireEvent.click(within(bar).getByRole("button", { name: "Card actions" }));
    expect(onNodeContextMenu).toHaveBeenCalledWith("a", expect.any(Number), expect.any(Number));
  });

  it("a card without sub-notes has no fold button, and a board that is not a tree has no centre button", () => {
    mount({ nodes: [card("b")] });
    select("b");
    const bar = screen.getByRole("toolbar", { name: "Selected card" });
    expect(within(bar).queryByRole("button", { name: /sub-notes/ })).toBeNull();
    expect(within(bar).queryByRole("button", { name: /Centre here/ })).toBeNull();
  });

  it("a collapsed branch offers to expand", () => {
    mount({ nodes: [card("a", { expanded: false, below: 4 })] });
    select("a");
    expect(screen.getByRole("button", { name: /Expand sub-notes/ })).toBeInTheDocument();
  });

  it("the old 「Card actions」 row above the board is replaced by it", () => {
    mount({ nodes: [card("a")] });
    select("a");
    expect(screen.getAllByRole("button", { name: "Card actions" })).toHaveLength(1);
  });
});

describe("the bottom-left corner", () => {
  it("has undo, redo, zoom out / in and fit; fit asks the board to show everything", () => {
    mount();
    const corner = screen.getByRole("group", { name: "Canvas controls" });
    expect(within(corner).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Undo", "Redo", "Zoom out", "Zoom in", "Fit view"]);
    expect(within(corner).getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(within(corner).getByRole("button", { name: "Redo" })).toBeDisabled();
    fireEvent.click(within(corner).getByRole("button", { name: "Zoom in" }));
    expect(flow.zoomIn).toHaveBeenCalled();
    fireEvent.click(within(corner).getByRole("button", { name: "Zoom out" }));
    expect(flow.zoomOut).toHaveBeenCalled();
    fireEvent.click(within(corner).getByRole("button", { name: "Fit view" }));
    expect(flow.fitView).toHaveBeenCalledWith(expect.objectContaining({ padding: expect.anything() }));
  });
});

describe("full screen Esc", () => {
  const enter = () => fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
  const inFullscreen = () => document.body.classList.contains("onden-board-fullscreen");

  it("leaves only for an Esc nobody else took: not one already handled, not while typing, not inside a popover or dialog", () => {
    mount(); enter();
    const taken = (event: Event) => event.preventDefault(); // a PDF card's Esc, say
    document.addEventListener("keydown", taken);
    try { fireEvent.keyDown(document.body, { key: "Escape" }); } finally { document.removeEventListener("keydown", taken); }
    expect(inFullscreen()).toBe(true);

    const field = document.body.appendChild(document.createElement("textarea"));
    fireEvent.keyDown(field, { key: "Escape" });
    expect(inFullscreen()).toBe(true);
    const editable = document.body.appendChild(document.createElement("div"));
    Object.defineProperty(editable, "isContentEditable", { value: true });
    fireEvent.keyDown(editable, { key: "Escape" });
    expect(inFullscreen()).toBe(true);

    const popover = document.body.appendChild(document.createElement("div"));
    popover.className = "ui-popover";
    const inside = popover.appendChild(document.createElement("button"));
    fireEvent.keyDown(inside, { key: "Escape" });
    expect(inFullscreen()).toBe(true);

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(inFullscreen()).toBe(false);
    field.remove(); editable.remove(); popover.remove();
  });

  it("first Esc puts a tool back to Select; only the next one leaves full screen", () => {
    mount(); enter();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Move" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(lit()).toEqual(["Select"]);
    expect(inFullscreen()).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(inFullscreen()).toBe(false);
  });

  it("ends when the board stops being on screen: a phone's Info screen, or no open board", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("900px"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    try {
      const { showBoard } = mount({ onScreen: true }); enter();
      expect(inFullscreen()).toBe(true);
      showBoard(false);
      expect(inFullscreen()).toBe(false);
      showBoard(true); enter();
      expect(inFullscreen()).toBe(true);
      act(() => setAppState({ activeCanvas: null }));
      expect(inFullscreen()).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it("a wide window keeps full screen when the phone-only tabs are on another screen", () => {
    const { showBoard } = mount({ onScreen: true }); enter();
    showBoard(false); // desktop: the note's phone tabs do not hide the board
    expect(inFullscreen()).toBe(true);
  });
});

describe("the hand tool", () => {
  it("moves the board only: no card or frame is draggable and no arrow can be drawn from one", () => {
    mount({ nodes: [{ ...card("a"), draggable: true }, { id: "s", type: "section", position: { x: 0, y: 0 }, data: {}, draggable: true }] });
    expect(flow.props.nodesDraggable).toBe(true);
    expect(flow.props.nodes!.every((n) => n.draggable === true)).toBe(true);
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Move" }));
    expect(flow.props.nodesDraggable).toBe(false);
    expect(flow.props.nodesConnectable).toBe(false);
    expect(flow.props.nodes!.map((n) => n.draggable)).toEqual([false, false]);
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Select" }));
    expect(flow.props.nodes!.every((n) => n.draggable === true)).toBe(true);
  });
});

describe("tools on a board that cannot hold ink", () => {
  it("drops the pen back to select when the board stops allowing ink (a note's board, then a tag's)", () => {
    const hook = renderHook(({ boardId, inkEnabled }) => useCanvasTools({ boardId, inkEnabled, onPenTool: vi.fn() }), { initialProps: { boardId: "n1" as string | null, inkEnabled: true } });
    act(() => hook.result.current.startPen());
    expect(hook.result.current.tool).toBe("pen");
    hook.rerender({ boardId: "t1", inkEnabled: false }); // the tag's board is a board, but has no ink
    expect(hook.result.current.tool).toBe("select");
  });

  it("a tag's board shows Select lit", () => {
    mount({ tagBoard: true });
    expect(lit()).toEqual(["Select"]);
  });
});

describe("the bar over the selected card on a narrow board", () => {
  it("names every button by aria-label and keeps its text in a label the narrow-board CSS hides", () => {
    mount({
      nodes: [card("a", { expanded: true, below: 0 })],
      tree: { mode: "auto", depth: 2, childless: false, crumbs: [], backTo: vi.fn(), setMode: vi.fn(), setDepth: vi.fn() },
    });
    act(() => { setAppState({ selectedId: "a" }); });
    const bar = screen.getByRole("toolbar", { name: "Selected card" });
    const buttons = within(bar).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Open card", "Colour", "Fold card", "Centre here", "Collapse sub-notes", "Card actions"]);
    expect(bar.querySelectorAll(".board-selection-label")).toHaveLength(5);
    for (const button of buttons.slice(0, 5)) expect(button.querySelector(".board-selection-label")?.textContent).toBe(button.getAttribute("aria-label"));
  });
});
