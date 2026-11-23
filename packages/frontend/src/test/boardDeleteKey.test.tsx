// Delete/Backspace on a board took the selected card's NOTE to the trash (the
// global delete shortcut ran nodeActions.delete). On a board it now does what
// the card menu's "Remove from canvas" does — the card comes off the board,
// the note stays — for every selected card at once, with an Undo.

// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import type { ComponentProps } from "react";
import type { ReactFlowProps } from "@xyflow/react";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const flow = vi.hoisted(() => ({ props: {} as ReactFlowProps }));
vi.mock("@xyflow/react", async importOriginal => ({
  ...await importOriginal<typeof import("@xyflow/react")>(),
  ReactFlow: function MockFlow(props: ReactFlowProps) {
    flow.props = props;
    return <div className="mock-flow" tabIndex={0} />;
  },
}));
vi.mock("../components/CardNode", () => ({ CardNode: () => null }));
vi.mock("../components/SectionNode", () => ({ SectionNode: () => null }));
import KnowledgeWorkspace from "../components/KnowledgeWorkspace";
import { useBoardWorkspace } from "../hooks/useBoardWorkspace";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import { canvasWriter, nodeActions } from "../lib/data";
import { setLocalePref } from "../lib/i18n";
import type { Tag } from "../lib/api";

const board = { id: "board", title: "Board", created_at: "", updated_at: "", data: { nodes: [
  { nodeId: "a", x: 0, y: 0, width: 300 }, { nodeId: "b", x: 400, y: 0, color: "#fde68a" }, { nodeId: "c", x: 800, y: 0 },
] } };
const cards = board.data.nodes.map(({ nodeId, x, y }) => ({ id: nodeId, type: "card", position: { x, y }, data: {} }));

function mount(onRemoveCards = vi.fn(async (_ids: string[]) => vi.fn(async () => {}) as () => Promise<unknown>), tagBoard = false) {
  const unused = vi.fn();
  const props = {
    board: {
      tagBoard, displayGraphNodes: cards, displayGraphEdges: [], canvasSearch: "",
      graphLocalMode: false, showTagEdges: false, parentMode: false, display: { settings: {}, set: () => {} },
      setGraphLocalMode: unused, setCanvasSearch: unused, setParentMode: unused,
    },
    actions: new Proxy({ onRemoveCards }, { get: (target, key) => (target as Record<string | symbol, unknown>)[key] ?? unused }),
    mobileView: "graph", createOpen: false, draftTitle: "",
    setCreateOpen: unused, setDraftTitle: unused,
    onCreateNode: unused, onClickWikilink: unused,
  } as unknown as ComponentProps<typeof KnowledgeWorkspace>;
  render(<KnowledgeWorkspace {...props} />);
  return onRemoveCards;
}
const select = (ids: string[]) => act(() => flow.props.onNodesChange?.(ids.map(id => ({ type: "select", id, selected: true }))));
const press = (key: string, target: Element | Window = window, init: KeyboardEventInit = {}) =>
  act(async () => { fireEvent.keyDown(target, { key, bubbles: true, ...init }); });

beforeEach(() => {
  setLocalePref("en");
  resetAppState({ activeCanvas: board });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Delete on a board", () => {
  it("takes the selected card off the board, never trashes its note, and offers Undo", async () => {
    const trash = vi.spyOn(nodeActions, "delete");
    const undo = vi.fn(async () => {});
    const remove = mount(vi.fn(async () => undo));
    act(() => setAppState({ selectedId: "a" }));
    await press("Delete");
    expect(remove).toHaveBeenCalledExactlyOnceWith(["a"]);
    expect(trash).not.toHaveBeenCalled();
    const toast = getAppState().toasts.at(-1)!;
    expect(toast.message).toContain("The notes stay in your library");
    act(() => toast.action!.onClick());
    expect(undo).toHaveBeenCalledOnce();
  });

  it("Backspace removes every selected card in one call", async () => {
    const remove = mount();
    select(["a", "b"]);
    await press("Backspace", document.body);
    expect(remove).toHaveBeenCalledExactlyOnceWith(["a", "b"]);
  });

  it("does nothing while typing: a field, an editor, an IME candidate, or focus outside the board", async () => {
    const remove = mount();
    select(["a"]);
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const line = editor.appendChild(document.createElement("div"));
    const sidebar = document.createElement("button");
    document.body.append(input, editor, sidebar);
    await press("Backspace", input);
    await press("Delete", line);
    await press("Delete", sidebar);
    await press("Backspace", window, { isComposing: true });
    await press("Backspace", window, { metaKey: true });
    expect(remove).not.toHaveBeenCalled();
    // On the board itself the key applies.
    await press("Delete", document.querySelector(".mock-flow")!);
    expect(remove).toHaveBeenCalledOnce();
    input.remove(); editor.remove(); sidebar.remove();
  });

  it("on a tag's board it changes nothing and says how to take a card off", async () => {
    const remove = mount(undefined, true);
    select(["a"]);
    await press("Delete");
    expect(remove).not.toHaveBeenCalled();
    expect(getAppState().toasts.at(-1)?.message).toContain("Remove from canvas");
  });
});

describe("the global shortcut", () => {
  it("no longer trashes the selected note on the canvas view", () => {
    const deleteNode = vi.fn();
    const noop = () => {};
    renderHook(() => useKeyboardShortcuts({
      mode: "notes", notesView: "canvas", selectedId: "a", setSelectedId: noop,
      createOpen: false, setCreateOpen: noop, createNote: noop, canvasSearch: "", setCanvasSearch: noop,
      onOpenOverviewSearch: noop, setPaletteOpen: noop, setPaletteQuery: noop, setPaletteIndex: noop,
      saveOverviewDraft: noop, setOverviewView: noop, openDailyNote: noop,
      setFocusMode: noop, deleteNode,
    } as Parameters<typeof useKeyboardShortcuts>[0]));
    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(deleteNode).not.toHaveBeenCalled();
  });
});

describe("removeCanvasCards", () => {
  function options(settleCardRemoval = vi.fn()) {
    return {
      ui: { mode: "notes", notesView: "canvas", setNotesView: vi.fn() },
      focus: { selectedNode: null, openBoardId: null, selectInWorkspace: vi.fn(), settleCardRemoval, createBoard: vi.fn() },
      menus: { canvasNavStack: [], setCanvasNavStack: vi.fn(), setCtxMenu: vi.fn() },
      createNodeRaw: vi.fn(), assignToGroup: vi.fn(), refresh: vi.fn(async () => {}),
    } as unknown as Parameters<typeof useBoardWorkspace>[0];
  }

  it("saves the board once without the cards, and the undo puts them back as they were", async () => {
    const save = vi.spyOn(canvasWriter, "save").mockImplementation(async (id, data) => {
      setAppState({ activeCanvas: { ...board, id, data } });
      return undefined;
    });
    const settle = vi.fn();
    const hook = renderHook(() => useBoardWorkspace(options(settle)));
    let undo: (() => Promise<unknown>) | null = null;
    await act(async () => { undo = await hook.result.current.actions.onRemoveCards(["a", "b"]); });
    expect(save).toHaveBeenCalledOnce();
    expect(getAppState().activeCanvas?.data.nodes.map(n => n.nodeId)).toEqual(["c"]);
    expect(settle.mock.calls).toEqual([["board", "a"], ["board", "b"]]);
    await act(async () => { await undo!(); });
    expect(getAppState().activeCanvas?.data.nodes).toEqual([
      { nodeId: "c", x: 800, y: 0 }, { nodeId: "a", x: 0, y: 0, width: 300 }, { nodeId: "b", x: 400, y: 0, color: "#fde68a" },
    ]);
  });

  it("leaves a tag's board alone", async () => {
    const save = vi.spyOn(canvasWriter, "save");
    resetAppState({ activeCanvas: board, data: { ...getAppState().data, tags: [{ id: "board", name: "t" } as Tag] } });
    const hook = renderHook(() => useBoardWorkspace(options()));
    let undo: unknown = "unset";
    await act(async () => { undo = await hook.result.current.actions.onRemoveCards(["a"]); });
    expect(undo).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});
