// The whiteboard is a view of a note (migration 138). A board that became a
// plain note opens on its whiteboard tab with every card there; any note can
// be given the tab and take cards; 內容 stays reachable and is remembered; the
// canvas lens of a note with no whiteboard yet reads its own board (the sub-note
// tree draws on it) and writes nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { useWorkspaceFocus } from "../hooks/useWorkspaceFocus";
import type { NodeLens } from "../lib/nodeLens";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { getAppState, resetAppState, setAppState, setSelectedId } from "../lib/appStore";
import { resetOwnerViews } from "../lib/ownerViews";
import { rememberedTab } from "../lib/viewTabs";

const mocks = vi.hoisted(() => ({ create: vi.fn(async () => ({ id: "view-1" })), update: vi.fn(async () => ({})), list: vi.fn(async () => ({ views: [] as unknown[] })) }));
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn(async () => ({ views: [] })) }));
vi.mock("../lib/data", async (original) => {
  const real = await original<typeof import("../lib/data")>();
  return {
    ...real,
    viewWriter: { ...real.viewWriter, create: mocks.create, update: mocks.update },
    reads: { ...real.reads, views: { ...real.reads.views, list: mocks.list } },
  };
});

const node = (id: string, extra: Partial<ContentNode> = {}) =>
  ({ id, title: id, node_type: "content", parent_id: null, hidden: false, markdown: "", source_type: "manual", slug: id, ...extra }) as ContentNode;
const converted = (id: string, config: Record<string, unknown> = { opens_first: true }) =>
  node(id, { slug: `canvas-${id}`, collection_views: [{ id: `tab-${id}`, layout: "canvas", layout_config: config }] });

function useFocus(initial: { nodeId: string | null; lens: NodeLens; viewTab?: string | null }, over: { selectCanvas?: ReturnType<typeof vi.fn> } = {}) {
  const [notesView, setNotesView] = useState<NodeLens>(initial.lens);
  const [viewTab, setViewTab] = useState<string | null>(initial.viewTab ?? null);
  const ui = { mode: "notes", setMode: vi.fn(), notesView, setNotesView, viewTab, setViewTab, setOverviewMobileTab: vi.fn() };
  const focus = useWorkspaceFocus({
    ui: ui as never, initialLocation: initial,
    boards: { selectCanvas: (over.selectCanvas ?? vi.fn(async () => {})) as never, createCanvas: vi.fn() as never },
    canvasImported: true, setCanvasNavStack: vi.fn(), confirm: async () => false,
  });
  return { ...focus, notesView, viewTab };
}

beforeEach(() => {
  localStorage.clear();
  bindAccountStorage("canvas-as-view-test", "");
  resetOwnerViews();
  vi.clearAllMocks();
  // clearAllMocks keeps implementations: undo the stored canvas tab a test may have set.
  mocks.list.mockResolvedValue({ views: [] });
  resetAppState({ online: true, data: { ...noWorkspaceData, nodes: [converted("inbox"), converted("quiet", {}), node("plain"), node("child", { parent_id: "plain" })], tags: [] } });
});

describe("a board that became a note", () => {
  it("opens on its whiteboard tab and loads its own board, not a copy built from its children", async () => {
    const selectCanvas = vi.fn(async () => {});
    setSelectedId("plain");
    const { result } = renderHook(() => useFocus({ nodeId: "plain", lens: "editor" }, { selectCanvas }));
    act(() => result.current.openNote("inbox"));
    await waitFor(() => expect(result.current.notesView).toBe("canvas"));
    expect(result.current.viewTab).toBeNull();
    await waitFor(() => expect(selectCanvas).toHaveBeenCalledWith("inbox"));
  });

  it("can still show its content: the choice is remembered, and the whiteboard tab brings the board back", async () => {
    setSelectedId("inbox");
    const { result } = renderHook(() => useFocus({ nodeId: "inbox", lens: "canvas" }));
    act(() => result.current.selectTab("content"));
    expect(result.current.notesView).toBe("editor");
    expect(rememberedTab("inbox")).toBe("content");
    act(() => result.current.openNote("plain"));
    act(() => result.current.openNote("inbox"));
    await waitFor(() => expect(result.current.notesView).toBe("editor"));
    act(() => result.current.selectTab("canvas"));
    expect(result.current.notesView).toBe("canvas");
    expect(rememberedTab("inbox")).toBeNull();
  });

  it("a note whose tab does not say opens-first opens on its content", async () => {
    const { result } = renderHook(() => useFocus({ nodeId: null, lens: "editor" }));
    act(() => result.current.openNote("quiet"));
    await waitFor(() => expect(result.current.notesView).toBe("editor"));
  });

  it("opened by a link before the notes have loaded, it still opens on its whiteboard once they arrive", async () => {
    const all = getAppState().data.nodes;
    setAppState({ data: { ...getAppState().data, nodes: [] } });
    setSelectedId("inbox");
    const { result } = renderHook(() => useFocus({ nodeId: "inbox", lens: "editor" }));
    expect(result.current.notesView).toBe("editor");
    act(() => setAppState({ data: { ...getAppState().data, nodes: all } }));
    await waitFor(() => expect(result.current.notesView).toBe("canvas"));
    expect(result.current.viewTab).toBeNull();
  });

  it("a tab chosen while the notes are still loading is kept when they arrive", async () => {
    const all = getAppState().data.nodes;
    setAppState({ data: { ...getAppState().data, nodes: [] } });
    setSelectedId("inbox");
    const { result } = renderHook(() => useFocus({ nodeId: "inbox", lens: "editor" }));
    act(() => result.current.selectTab("content"));
    act(() => setAppState({ data: { ...getAppState().data, nodes: all } }));
    await act(async () => {});
    expect(result.current.notesView).toBe("editor");
  });

  it("a link followed to it shows its text", async () => {
    const { result } = renderHook(() => useFocus({ nodeId: "plain", lens: "editor" }));
    act(() => result.current.followLink("inbox"));
    await waitFor(() => expect(result.current.notesView).toBe("editor"));
  });
});

describe("a plain note's canvas lens", () => {
  it("looking at its canvas lens without a whiteboard reads its own board and writes nothing: no tab, no cards", async () => {
    const selectCanvas = vi.fn(async () => {});
    setSelectedId("plain");
    const { result } = renderHook(() => useFocus({ nodeId: "plain", lens: "editor" }, { selectCanvas }));
    act(() => result.current.setLens("canvas"));
    await waitFor(() => expect(selectCanvas).toHaveBeenCalledWith("plain"));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("with the tab already stored (added from ＋), the canvas lens loads its own board at once", async () => {
    const selectCanvas = vi.fn(async () => {});
    setSelectedId("plain");
    mocks.list.mockResolvedValue({ views: [{ id: "v", layout: "canvas", name: "Canvas", layout_config: {} }] });
    const { reloadOwnerViews } = await import("../lib/ownerViews");
    await reloadOwnerViews({ kind: "node", id: "plain" });
    const { result } = renderHook(() => useFocus({ nodeId: "plain", lens: "editor" }, { selectCanvas }));
    act(() => result.current.setLens("canvas"));
    await waitFor(() => expect(selectCanvas).toHaveBeenCalledWith("plain"));
  });
});

describe("a click on a card of a board that follows its sub-notes", () => {
  const openBoard = (cards: Array<{ nodeId: string; x: number; y: number }>) =>
    setAppState({ activeCanvas: { id: "plain", title: "plain", created_at: "", updated_at: "", data: { nodes: cards } } });

  it("keeps the board: a sub-note the tree draws is on it, whether or not it has a stored card", async () => {
    const selectCanvas = vi.fn(async () => {});
    setSelectedId("plain");
    openBoard([]);
    const { result } = renderHook(() => useFocus({ nodeId: "plain", lens: "canvas" }, { selectCanvas }));
    await waitFor(() => expect(result.current.notesView).toBe("canvas"));
    selectCanvas.mockClear();
    act(() => result.current.selectInWorkspace("child"));
    await waitFor(() => expect(result.current.selectedId).toBe("child"));
    expect(result.current.notesView).toBe("canvas");
    expect(selectCanvas).not.toHaveBeenCalled();
  });

  it("on a board of the person's own cards, a note that is not one of them opens its own board, as before", async () => {
    const selectCanvas = vi.fn(async () => {});
    setSelectedId("plain");
    openBoard([{ nodeId: "other", x: 0, y: 0 }]);
    const { result } = renderHook(() => useFocus({ nodeId: "plain", lens: "canvas" }, { selectCanvas }));
    await waitFor(() => expect(result.current.notesView).toBe("canvas"));
    selectCanvas.mockClear();
    act(() => result.current.selectInWorkspace("child"));
    await waitFor(() => expect(selectCanvas).toHaveBeenCalledWith("child"));
  });
});

describe("the tabs above a board belong to the note whose board it is", () => {
  const openBoard = (id: string, cards: Array<{ nodeId: string; x: number; y: number }> = []) =>
    setAppState({ activeCanvas: { id, title: id, created_at: "", updated_at: "", data: { nodes: cards } } });
  const onBoard = async (cards: Array<{ nodeId: string; x: number; y: number }> = [], selectCanvas = vi.fn(async () => {})) => {
    setSelectedId("plain");
    openBoard("plain", cards);
    const hook = renderHook(() => useFocus({ nodeId: "plain", lens: "canvas" }, { selectCanvas }));
    await waitFor(() => expect(hook.result.current.notesView).toBe("canvas"));
    return hook;
  };

  it("a click on empty board space clears the selection, but the page stays the board's note", async () => {
    const { result } = await onBoard();
    act(() => result.current.selectInWorkspace(null));
    await waitFor(() => expect(result.current.selectedId).toBeNull());
    expect(result.current.pageNode?.id).toBe("plain");
  });

  it.each([
    ["a sub-note the tree draws", [], "child"],
    ["a note of the person's own cards", [{ nodeId: "inbox", x: 0, y: 0 }], "inbox"],
  ])("selecting a card (%s) does not change the page", async (_name, cards, card) => {
    const { result } = await onBoard(cards);
    act(() => result.current.selectInWorkspace(card));
    await waitFor(() => expect(result.current.selectedId).toBe(card));
    expect(result.current.pageNode?.id).toBe("plain");
  });

  it("a tag's board: with nothing selected the page is the tag", async () => {
    const tag = { id: "books", name: "書籍" } as never;
    setAppState({ data: { ...getAppState().data, tags: [tag] } });
    setSelectedId("books");
    openBoard("books");
    const { result } = renderHook(() => useFocus({ nodeId: "books", lens: "canvas" }));
    act(() => result.current.selectInWorkspace(null));
    await waitFor(() => expect(result.current.selectedId).toBeNull());
    expect(result.current.pageTag?.id).toBe("books");
    expect(result.current.pageNode).toBeNull();
  });

  it("the 內容 tab with a card selected returns to the board's note, not the card's", async () => {
    const { result } = await onBoard();
    act(() => result.current.selectInWorkspace("child"));
    await waitFor(() => expect(result.current.selectedId).toBe("child"));
    act(() => result.current.selectTab("content"));
    await waitFor(() => expect(result.current.selectedId).toBe("plain"));
    expect(result.current.notesView).toBe("editor");
    expect(rememberedTab("child")).toBeNull();
  });

  it("without a board the page is simply the selected note", () => {
    setSelectedId("plain");
    const { result } = renderHook(() => useFocus({ nodeId: "plain", lens: "editor" }));
    expect(result.current.pageNode?.id).toBe("plain");
  });
});
