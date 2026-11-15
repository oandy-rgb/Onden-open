// The note board that follows its sub-notes (docs/architecture/canvas-as-view.md):
// opening it draws the tree and writes nothing; the level setting, a branch
// fold and the first dragged card are the writes, and each stores only what
// the person changed. A board with cards of its own stays as it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Canvas, ContentNode } from "../lib/api";
import { noWorkspaceData } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import { resetOwnerViews } from "../lib/ownerViews";

type View = { id: string; layout: string; name: string; layout_config: Record<string, unknown>; pin_order: number };
const world = vi.hoisted(() => ({
  views: [] as unknown[],
  create: vi.fn(),
  update: vi.fn(),
  save: vi.fn(),
  place: vi.fn(),
}));
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
vi.mock("../lib/data", async (original) => {
  const real = await original<typeof import("../lib/data")>();
  return {
    ...real,
    viewWriter: { ...real.viewWriter, create: world.create, update: world.update },
    reads: { ...real.reads, views: { ...real.reads.views, list: vi.fn(async () => ({ views: world.views })) } },
    canvasWriter: { ...real.canvasWriter, save: world.save, place: world.place, followList: vi.fn(), reconcileTagBoard: vi.fn(), select: vi.fn(async () => {}) },
  };
});
import { useBoardWorkspace } from "../hooks/useBoardWorkspace";

const note = (id: string, parent: string | null, minute = 0, extra: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", parent_id: parent, hidden: false,
    updated_at: `2026-10-29T10:${String(minute).padStart(2, "0")}:00Z`, ...extra }) as ContentNode;
const children = (parent: string, count: number) => Array.from({ length: count }, (_, i) => note(`${parent}.${i}`, parent, i));
const board = (id: string, cards: Canvas["data"]["nodes"] = []): Canvas => ({ id, title: id, created_at: "", updated_at: "", data: { nodes: cards } });
const tab = (config: Record<string, unknown> = { opens_first: true }): View =>
  ({ id: "tab-r", layout: "canvas", name: "Canvas", layout_config: config, pin_order: 0 });

function mount(nodes: ContentNode[], canvas: Canvas) {
  resetAppState({ online: true, data: { ...noWorkspaceData, nodes, tags: [] }, activeCanvas: canvas });
  const options = {
    ui: { mode: "notes", notesView: "canvas", setNotesView: vi.fn() },
    focus: { selectedNode: null, openBoardId: null, selectInWorkspace: vi.fn(), settleCardRemoval: vi.fn() },
    menus: { canvasNavStack: [], setCanvasNavStack: vi.fn(), setCtxMenu: vi.fn() },
    createNodeRaw: vi.fn(), assignToGroup: vi.fn(), refresh: vi.fn(async () => {}),
  } as unknown as Parameters<typeof useBoardWorkspace>[0];
  return renderHook(() => useBoardWorkspace(options));
}
const cardIds = (hook: ReturnType<typeof mount>) => hook.result.current.board.displayGraphNodes.filter((n) => n.type === "card").map((n) => n.id).sort();

beforeEach(() => {
  localStorage.clear();
  bindAccountStorage("board-auto-tree-test", "");
  resetOwnerViews();
  vi.clearAllMocks();
  world.views = [tab()];
  world.create.mockResolvedValue("tab-r");
  world.update.mockImplementation(async (_owner: unknown, _id: string, changes: { layout_config_patch?: Record<string, unknown> }) => {
    // The server's rule: the named keys change, the other keys of the tab stay.
    if (changes.layout_config_patch) world.views = [{ ...(world.views[0] as View), layout_config: { ...(world.views[0] as View).layout_config, ...changes.layout_config_patch } }];
    return {};
  });
  world.save.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("an empty note board", () => {
  it("opens with the note as the root card and its sub-notes spread out, joined by parent lines, and writes nothing", async () => {
    const hook = mount([note("r", null), ...children("r", 3), note("r.0.a", "r.0")], board("r"));
    await waitFor(() => expect(cardIds(hook)).toEqual(["r", "r.0", "r.0.a", "r.1", "r.2"].sort()));
    const { displayGraphEdges, displayGraphNodes } = hook.result.current.board;
    expect(displayGraphEdges.map((e) => `${e.source}>${e.target}`).sort()).toEqual(["r.0>r.0.a", "r>r.0", "r>r.1", "r>r.2"]);
    const root = displayGraphNodes.find((n) => n.id === "r")!;
    expect(displayGraphNodes.find((n) => n.id === "r.0")!.position.x).toBeGreaterThan(root.position.x);
    expect(hook.result.current.board.tree).toMatchObject({ mode: "auto", depth: 2, childless: false });
    expect(world.update).not.toHaveBeenCalled();
    expect(world.create).not.toHaveBeenCalled();
    expect(world.save).not.toHaveBeenCalled();
    expect(world.place).not.toHaveBeenCalled();
  });

  it("a note without sub-notes shows only the root card, with the note that says what to do", async () => {
    const hook = mount([note("r", null)], board("r"));
    await waitFor(() => expect(hook.result.current.board.tree?.childless).toBe(true));
    expect(cardIds(hook)).toEqual(["r"]);
  });

  it("follows the notes: a sub-note added, moved away or hidden changes the board by itself", async () => {
    const hook = mount([note("r", null), ...children("r", 2)], board("r"));
    await waitFor(() => expect(cardIds(hook)).toHaveLength(3));
    const nodes = getAppState().data.nodes;
    act(() => setAppState({ data: { ...getAppState().data, nodes: [...nodes, note("r.new", "r", 9)] } }));
    expect(cardIds(hook)).toContain("r.new");
    act(() => setAppState({ data: { ...getAppState().data, nodes: getAppState().data.nodes.map((n) => n.id === "r.0" ? { ...n, parent_id: "elsewhere" } : n) } }));
    expect(cardIds(hook)).not.toContain("r.0");
    expect(world.save).not.toHaveBeenCalled();
  });

  it("shows 8 sub-notes, newest first, and a +N card whose click draws 8 more", async () => {
    const hook = mount([note("r", null), ...children("r", 20)], board("r"));
    await waitFor(() => expect(cardIds(hook)).toHaveLength(9));
    const more = () => hook.result.current.board.displayGraphNodes.find((n) => n.type === "treeMore");
    expect(more()?.data).toMatchObject({ parentId: "r", remaining: 12 });
    expect(cardIds(hook)).toContain("r.19");
    expect(cardIds(hook)).not.toContain("r.0");
    act(() => hook.result.current.actions.onShowMoreChildren("r"));
    expect(cardIds(hook)).toHaveLength(17);
    expect(more()?.data).toMatchObject({ remaining: 4 });
    expect(world.update).not.toHaveBeenCalled();
  });

  it("holds to 30 cards on a phone and 100 on a computer, however many sub-notes there are", async () => {
    const nodes = [note("r", null), ...children("r", 8), ...Array.from({ length: 8 }, (_, i) => children(`r.${i}`, 8)).flat(), ...children("r.0.0", 8)];
    const desktop = mount(nodes, board("r"));
    await waitFor(() => expect(desktop.result.current.board.displayGraphNodes.length).toBeGreaterThan(30));
    expect(desktop.result.current.board.displayGraphNodes.length).toBeLessThanOrEqual(100);
    desktop.unmount();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const phone = mount(nodes, board("r"));
    await waitFor(() => expect(phone.result.current.board.displayGraphNodes.filter((n) => n.type !== "section").length).toBe(30));
  });

  it("switching the levels is the first write: it stores only the level, in the whiteboard tab", async () => {
    const hook = mount([note("r", null), note("a", "r"), note("b", "a"), note("c", "b")], board("r"));
    await waitFor(() => expect(cardIds(hook)).toEqual(["a", "b", "r"]));
    act(() => hook.result.current.board.tree!.setDepth(3));
    await waitFor(() => expect(cardIds(hook)).toEqual(["a", "b", "c", "r"]));
    expect(world.update).toHaveBeenCalledTimes(1);
    expect(world.update).toHaveBeenCalledWith({ kind: "node", id: "r" }, "tab-r", { layout_config_patch: { tree: { depth: 3 } } });
    expect(world.save).not.toHaveBeenCalled();
    act(() => hook.result.current.board.tree!.setDepth("all"));
    await waitFor(() => expect(world.update).toHaveBeenLastCalledWith({ kind: "node", id: "r" }, "tab-r", { layout_config_patch: { tree: { depth: "all" } } }));
  });

  it("folds and unfolds a branch, remembered in the tab", async () => {
    const hook = mount([note("r", null), note("a", "r"), note("b", "a")], board("r"));
    await waitFor(() => expect(cardIds(hook)).toEqual(["a", "b", "r"]));
    act(() => hook.result.current.actions.onToggleBranch("a"));
    await waitFor(() => expect(cardIds(hook)).toEqual(["a", "r"]));
    const a = hook.result.current.board.displayGraphNodes.find((n) => n.id === "a")!;
    expect(a.data.branch).toEqual({ expanded: false, below: 1 });
    expect(world.update).toHaveBeenLastCalledWith({ kind: "node", id: "r" }, "tab-r", { layout_config_patch: { tree: { closed: ["a"] } } });
    act(() => hook.result.current.actions.onToggleBranch("a"));
    await waitFor(() => expect(cardIds(hook)).toEqual(["a", "b", "r"]));
  });

  it("dragging a card is the first write of its position: only that card is stored, the rest keep following the notes, and the board stays automatic", async () => {
    const hook = mount([note("r", null), ...children("r", 3)], board("r"));
    await waitFor(() => expect(cardIds(hook)).toHaveLength(4));
    await act(async () => { await hook.result.current.actions.onApplyPositions([{ nodeId: "r.1", x: 900, y: 40 }]); });
    expect(world.save).toHaveBeenCalledTimes(1);
    expect(world.save).toHaveBeenCalledWith("r", { nodes: [{ nodeId: "r.1", x: 900, y: 40 }] });
    // The mode is stored with it, so a board that now has a card does not turn manual.
    await waitFor(() => expect(world.update).toHaveBeenCalledWith({ kind: "node", id: "r" }, "tab-r", { layout_config_patch: { tree: { mode: "auto" } } }));
    // The writer's answer: the stored card is on the board; it keeps its place and the others still lay themselves out.
    act(() => setAppState({ activeCanvas: board("r", [{ nodeId: "r.1", x: 900, y: 40 }]) }));
    const at = (id: string) => hook.result.current.board.displayGraphNodes.find((n) => n.id === id)!.position;
    expect(at("r.1")).toEqual({ x: 900, y: 40 });
    expect(cardIds(hook)).toEqual(["r", "r.0", "r.1", "r.2"]);
    act(() => setAppState({ data: { ...getAppState().data, nodes: [...getAppState().data.nodes, note("r.3", "r", 9)] } }));
    expect(cardIds(hook)).toContain("r.3");
    expect(hook.result.current.board.tree?.mode).toBe("auto");
  });

  it("a card the person dropped stays beside the tree, and the board stays automatic", async () => {
    const hook = mount([note("r", null), ...children("r", 2), note("loose", null)], board("r"));
    await waitFor(() => expect(cardIds(hook)).toHaveLength(3));
    await act(async () => { await hook.result.current.actions.onAddToCanvas("loose"); });
    expect(world.place).toHaveBeenCalledWith("r", "loose", undefined);
    await waitFor(() => expect(world.update).toHaveBeenCalledWith({ kind: "node", id: "r" }, "tab-r", { layout_config_patch: { tree: { mode: "auto" } } }));
    act(() => setAppState({ activeCanvas: board("r", [{ nodeId: "loose", x: 700, y: 0 }]) }));
    expect(cardIds(hook)).toEqual(["loose", "r", "r.0", "r.1"]);
  });
});

describe("centring the board on another note", () => {
  const nodes = () => [note("r", null), note("a", "r"), note("b", "r", 1), note("a1", "a"), note("a2", "a", 1), note("a1x", "a1")];
  const hasWrites = () => world.update.mock.calls.length + world.save.mock.calls.length + world.place.mock.calls.length;

  it("draws the tree from that note, with the way back, and stores nothing", async () => {
    const hook = mount(nodes(), board("r"));
    await waitFor(() => expect(cardIds(hook)).toEqual(["a", "a1", "a2", "b", "r"]));
    act(() => hook.result.current.actions.onCenterBoard("a"));
    expect(cardIds(hook)).toEqual(["a", "a1", "a1x", "a2"].sort());
    expect(hook.result.current.board.tree?.crumbs.map((c) => c.id)).toEqual(["r", "a"]);
    act(() => hook.result.current.actions.onCenterBoard("a1"));
    expect(hook.result.current.board.tree?.crumbs.map((c) => c.id)).toEqual(["r", "a", "a1"]);
    expect(hasWrites()).toBe(0);
  });

  it("the cards cannot be dragged and nothing is saved while centred; going back restores the board and its own cards", async () => {
    const hook = mount(nodes(), board("r", [{ nodeId: "b", x: 700, y: 0 }]));
    await waitFor(() => expect(hook.result.current.board.tree?.mode).toBe("manual"));
    act(() => hook.result.current.board.tree!.setMode("auto"));
    await waitFor(() => expect(cardIds(hook)).toContain("a"));
    act(() => hook.result.current.actions.onCenterBoard("a"));
    expect(hook.result.current.board.displayGraphNodes.filter((n) => n.type === "card").every((n) => n.draggable === false)).toBe(true);
    expect(cardIds(hook)).not.toContain("b");
    world.save.mockClear(); world.place.mockClear();
    await act(async () => { await hook.result.current.actions.onApplyPositions([{ nodeId: "a1", x: 5, y: 5 }]); await hook.result.current.actions.onAddToCanvas("b"); });
    expect(world.save).not.toHaveBeenCalled();
    expect(world.place).not.toHaveBeenCalled();
    expect(getAppState().toasts.at(-1)?.message).toBeTruthy();
    act(() => hook.result.current.board.tree!.backTo(0));
    expect(hook.result.current.board.tree?.crumbs).toEqual([]);
    expect(cardIds(hook)).toContain("b");
    expect(hook.result.current.board.displayGraphNodes.find((n) => n.id === "b")!.position).toEqual({ x: 700, y: 0 });
  });

  it("a centre that disappears ends the path there, and a manual board has no centring", async () => {
    const hook = mount(nodes(), board("r"));
    await waitFor(() => expect(cardIds(hook)).toContain("a"));
    act(() => hook.result.current.actions.onCenterBoard("a1"));
    act(() => setAppState({ data: { ...getAppState().data, nodes: getAppState().data.nodes.filter((n) => n.id !== "a1" && n.id !== "a1x") } }));
    expect(hook.result.current.board.tree?.crumbs.map((c) => c.id)).toEqual(["r", "a"]);
    expect(hook.result.current.centerBoardOn).toBeDefined();
    const manual = mount(nodes(), board("r", [{ nodeId: "b", x: 0, y: 0 }]));
    await waitFor(() => expect(manual.result.current.board.tree?.mode).toBe("manual"));
    expect(manual.result.current.centerBoardOn).toBeUndefined();
  });
});

describe("a board that already has cards", () => {
  const manual = () => board("r", [{ nodeId: "keep", x: 10, y: 20 }]);
  const nodes = () => [note("r", null), ...children("r", 2), note("keep", null)];

  it("stays exactly as it was: only its own cards, no tree", async () => {
    const hook = mount(nodes(), manual());
    await waitFor(() => expect(hook.result.current.board.tree?.mode).toBe("manual"));
    expect(cardIds(hook)).toEqual(["keep"]);
    expect(hook.result.current.board.displayGraphNodes.find((n) => n.id === "keep")!.position).toEqual({ x: 10, y: 20 });
    expect(world.update).not.toHaveBeenCalled();
  });

  it("is changed to follow the sub-notes only when the person chooses, and its own cards stay", async () => {
    const hook = mount(nodes(), manual());
    await waitFor(() => expect(hook.result.current.board.tree?.mode).toBe("manual"));
    act(() => hook.result.current.board.tree!.setMode("auto"));
    await waitFor(() => expect(cardIds(hook)).toEqual(["keep", "r", "r.0", "r.1"]));
    expect(world.update).toHaveBeenCalledWith({ kind: "node", id: "r" }, "tab-r", { layout_config_patch: { tree: { mode: "auto" } } });
    act(() => hook.result.current.board.tree!.setMode("manual"));
    await waitFor(() => expect(cardIds(hook)).toEqual(["keep"]));
  });

  it("an emptied manual board does not turn automatic under the person", async () => {
    const hook = mount(nodes(), manual());
    await waitFor(() => expect(hook.result.current.board.tree?.mode).toBe("manual"));
    act(() => setAppState({ activeCanvas: board("r") }));
    expect(hook.result.current.board.tree?.mode).toBe("manual");
    expect(cardIds(hook)).toEqual([]);
  });
});

describe("what is not a note's board", () => {
  it("a tag's board has no tree and no levels control", async () => {
    resetAppState({ online: true, data: { ...noWorkspaceData, nodes: [note("tag", null, 0, { node_type: "class_tag" }), note("child", "tag")], tags: [{ id: "tag", name: "tag" } as never] }, activeCanvas: board("tag") });
    const options = {
      ui: { mode: "notes", notesView: "canvas", setNotesView: vi.fn() },
      focus: { selectedNode: null, openBoardId: null, selectInWorkspace: vi.fn(), settleCardRemoval: vi.fn() },
      menus: { canvasNavStack: [], setCanvasNavStack: vi.fn(), setCtxMenu: vi.fn() },
      createNodeRaw: vi.fn(), assignToGroup: vi.fn(), refresh: vi.fn(async () => {}),
    } as unknown as Parameters<typeof useBoardWorkspace>[0];
    const hook = renderHook(() => useBoardWorkspace(options));
    expect(hook.result.current.board.tree).toBeUndefined();
    expect(hook.result.current.board.displayGraphNodes.filter((n) => n.type === "card")).toEqual([]);
  });
});
