// Every note remembers the tab it was left on (hooks/useWorkspaceFocus +
// lib/viewTabs): choosing a tab stores it for the note on this account, the
// note reopens on it, 內容 forgets it, a followed link shows the text, and a
// whiteboard note's tab is its board. Also: notes and tags share one tab row.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { useWorkspaceFocus } from "../hooks/useWorkspaceFocus";
import NotesWorkspace from "../components/workspace/NotesWorkspace";
import type { NodeLens } from "../lib/nodeLens";
import { noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { resetAppState, setSelectedId } from "../lib/appStore";
import { resetOwnerViews } from "../lib/ownerViews";
import { rememberedTab } from "../lib/viewTabs";

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn(async () => ({ views: [] })) }));

const node = (id: string, extra: Partial<ContentNode> = {}) => ({ id, title: id, node_type: "content", parent_id: null, hidden: false, markdown: "", ...extra }) as ContentNode;
const tag = { id: "tag1", name: "task", node_type: "class_tag" } as unknown as Tag;

function useFocus(initial: { nodeId: string | null; lens: NodeLens; viewTab?: string | null }) {
  const [notesView, setNotesView] = useState<NodeLens>(initial.lens);
  const [viewTab, setViewTab] = useState<string | null>(initial.viewTab ?? null);
  const ui = { mode: "notes", setMode: vi.fn(), notesView, setNotesView, viewTab, setViewTab, setOverviewMobileTab: vi.fn() };
  const focus = useWorkspaceFocus({
    ui: ui as never, initialLocation: initial,
    boards: { selectCanvas: vi.fn(async () => {}) as never, createCanvas: vi.fn() as never },
    canvasImported: true, setCanvasNavStack: vi.fn(), confirm: async () => false,
  });
  return { ...focus, notesView, viewTab };
}

describe("a note remembers its tab", () => {
  beforeEach(() => {
    localStorage.clear();
    bindAccountStorage("tab-memory-test", "");
    resetAppState({ data: { ...noWorkspaceData, nodes: [node("a"), node("b"), node("w", { node_type: "canvas" })], tags: [tag] } });
    setSelectedId("a");
  });

  it("choosing a tab stores it; the note reopens on it later, and 內容 forgets it", async () => {
    const { result } = renderHook(() => useFocus({ nodeId: "a", lens: "editor" }));
    act(() => result.current.selectTab("v1"));
    expect(result.current.viewTab).toBe("v1");
    expect(result.current.notesView).toBe("editor");
    expect(rememberedTab("a")).toBe("v1");

    // Another note shows its content; coming back lands on v1 again.
    act(() => result.current.openNote("b"));
    await waitFor(() => expect(result.current.viewTab).toBeNull());
    act(() => result.current.openNote("a"));
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));

    act(() => result.current.selectTab("content"));
    expect(result.current.viewTab).toBeNull();
    expect(rememberedTab("a")).toBeNull();
  });

  it("the whiteboard tab is the canvas lens, and is remembered too", () => {
    const { result } = renderHook(() => useFocus({ nodeId: "a", lens: "editor" }));
    act(() => result.current.selectTab("canvas"));
    expect(result.current.notesView).toBe("canvas");
    expect(result.current.viewTab).toBeNull();
    expect(rememberedTab("a")).toBe("canvas");
  });

  it("a deep link's tab is shown first; a note already open shows its text again when clicked in the list", async () => {
    const { result } = renderHook(() => useFocus({ nodeId: "a", lens: "editor", viewTab: "v9" }));
    expect(result.current.viewTab).toBe("v9");
    act(() => result.current.openNote("a"));
    await waitFor(() => expect(result.current.viewTab).toBeNull());
  });

  it("following a link opens the target's text, not the tab it was left on", async () => {
    localStorage.clear();
    const { result } = renderHook(() => useFocus({ nodeId: "a", lens: "editor" }));
    act(() => result.current.selectTab("v1"));
    act(() => result.current.openNote("b"));
    act(() => result.current.selectTab("v2"));
    act(() => result.current.openNote("a"));
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));
    act(() => result.current.followLink("b"));
    await waitFor(() => expect(result.current.viewTab).toBeNull());
  });
});

describe("one tab row for notes and tags", () => {
  beforeEach(() => { resetAppState({ data: { ...noWorkspaceData, actor_role: "admin", actor_is_owner: true, nodes: [node("a")], tags: [tag] } }); resetOwnerViews(); localStorage.clear(); });
  const props = (selectedNode: ContentNode | null, selectedTag: Tag | null) => ({
    sidebar: null, center: <div />, inspector: null, mobileTab: "edit" as const, onCloseInfo: vi.fn(),
    ui: { mode: "notes", setMode: vi.fn(), notesView: "editor" as const, setNotesView: vi.fn(), viewTab: null, setOverviewMobileTab: vi.fn() },
    nav: { goBack: vi.fn(), canGoBack: false, setLens: vi.fn(), selectTab: vi.fn(), openBoardId: null, selectedNode, selectedTag, pageNode: selectedNode, pageTag: selectedTag },
    panes: { inspectorOpen: true, focusMode: false, showInspector: vi.fn() },
    noteActions: { exportNote: async () => true, copyMarkdown: async () => true, exportBusy: false }, nodeVersions: [],
    welcomeActions: { refresh: async () => {}, createNote: async () => {}, openDailyNote: async () => {} },
  });

  it("a note and a tag get the same title strip; a note with only 內容 still shows it (for ＋), a tag shows it with no 內容 tab (its first tab is 列表)", async () => {
    const note = render(<NotesWorkspace {...props(node("a"), null)} />);
    expect(note.container.querySelector(".center-lens-bar .view-tabs")).not.toHaveAttribute("hidden");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Content"]);
    expect(screen.getByRole("button", { name: "Add a view" })).toBeInTheDocument();
    note.unmount();
    const tagPage = render(<NotesWorkspace {...props(null, tag)} />);
    expect(tagPage.container.querySelector(".center-lens-bar .view-tabs")).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["List"]);
    expect(screen.getByRole("button", { name: "Add a view" })).toBeInTheDocument();
  });
});
