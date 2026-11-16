// A note whose 「內容」 tab was removed (a record of layout content, hidden): where the page opens (the first tab showing),
// what a remembered or bare-address 「內容」 becomes, and what happens when something wants the caret in the text.
// hooks/useWorkspaceFocus + lib/contentTab + lib/viewTabs.
import "./helpers/offlineNetwork";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { useWorkspaceFocus } from "../hooks/useWorkspaceFocus";
import type { NodeLens } from "../lib/nodeLens";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { addToast as realAddToast, getAppState, resetAppState, setSelectedId } from "../lib/appStore";
import { resetOwnerViews } from "../lib/ownerViews";
import { rememberTab, rememberedTab } from "../lib/viewTabs";
import { setPendingCursor } from "../lib/cursorHandoff";
import { SESSION_KEYS, readSession } from "../lib/sessionPrefs";
import { settleRemovedContent } from "../lib/contentTab";

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
type Stored = Record<string, unknown> & { id: string; layout: string };
const server = vi.hoisted(() => ({ views: [] as Stored[] }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn(async (path: string) => {
  const match = /^\/api\/nodes\/([^/]+)\/views$/.exec(path);
  return { views: match && match[1] === "a" ? server.views : [] };
}) }));
const update = vi.hoisted(() => vi.fn());
vi.mock("../lib/data/domainWriters", async (load) => {
  const actual = await load<typeof import("../lib/data/domainWriters")>();
  return { ...actual, viewWriter: { create: vi.fn(), remove: vi.fn(), update } };
});
const confirm = vi.hoisted(() => vi.fn(async () => true));
const toasts: string[] = [];
vi.mock("../lib/appStore", async (original) => ({ ...await original<typeof import("../lib/appStore")>(), addToast: (message: string) => { toasts.push(message); } }));
const spaces = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
vi.mock("../lib/spaces", async (original) => ({ ...await original<typeof import("../lib/spaces")>(), loadedSpaces: () => spaces.list }));

const view = (id: string, layout: string, extra: Record<string, unknown> = {}): Stored =>
  ({ id, node_id: "a", name: id, layout, filters: [], sorts: [], group_by: null, visible_fields: [], layout_config: {}, pin_order: 0, ...extra });
const REMOVED = () => [view("c1", "content", { name: "Content", layout_config: { hidden: true }, pin_order: 1 }), view("v1", "table")];
const node = (id: string, extra: Partial<ContentNode> = {}) => ({ id, title: id, node_type: "content", parent_id: null, hidden: false, markdown: "", ...extra }) as ContentNode;

function useFocus(initial: { nodeId: string | null; lens: NodeLens; viewTab?: string | null; tabShownByEntry?: boolean; mode?: string }) {
  const [mode, setMode] = useState(initial.mode ?? "notes");
  const [notesView, setNotesView] = useState<NodeLens>(initial.lens);
  const [viewTab, setViewTab] = useState<string | null>(initial.viewTab ?? null);
  const ui = { mode, setMode, notesView, setNotesView, viewTab, setViewTab, setOverviewMobileTab: vi.fn() };
  const focus = useWorkspaceFocus({
    ui: ui as never, initialLocation: initial,
    boards: { selectCanvas: vi.fn(async () => {}) as never, createCanvas: vi.fn() as never },
    canvasImported: true, setCanvasNavStack: vi.fn(), confirm,
  });
  return { ...focus, notesView, viewTab, setMode };
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  bindAccountStorage("content-tab-focus", "");
  resetOwnerViews();
  server.views = REMOVED();
  update.mockReset(); update.mockImplementation(async (_owner: unknown, id: string, changes: { layout_config_patch?: Record<string, unknown>; pin_order?: number }) => {
    const target = server.views.find((v) => v.id === id)!;
    if (changes.pin_order !== undefined) target.pin_order = changes.pin_order;
    if (changes.layout_config_patch) { const next = { ...(target.layout_config as Record<string, unknown>) }; for (const [k, v] of Object.entries(changes.layout_config_patch)) { if (v === null) delete next[k]; else next[k] = v; } target.layout_config = next; }
    return { status: "ok" };
  });
  confirm.mockClear(); confirm.mockResolvedValue(true);
  toasts.length = 0; spaces.list = [];
  resetAppState({ data: { ...noWorkspaceData, actor_is_owner: true, nodes: [node("a", { collection_views: REMOVED() as never }), node("b"), node("c", { space_id: "s1" })] } });
  setSelectedId("a");
  void realAddToast;
});

describe("a note whose 「內容」 tab was removed", () => {
  it("opens on the first tab showing; a note with no record still opens on 「內容」", async () => {
    const { result } = renderHook(() => useFocus({ nodeId: "a", lens: "editor" }));
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));
    act(() => result.current.openNote("b"));
    await waitFor(() => expect(result.current.viewTab).toBeNull());
    expect(result.current.notesView).toBe("editor");
    act(() => result.current.openNote("a"));
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));
  });

  it("a remembered 「內容」, the bare address, a history entry that showed it, and a followed link all land on the default tab", async () => {
    rememberTab("a", "content", "v1"); // as left behind from before it was removed
    const { result } = renderHook(() => useFocus({ nodeId: "a", lens: "editor", tabShownByEntry: true }));
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));
    act(() => result.current.openNote("b"));
    await waitFor(() => expect(result.current.viewTab).toBeNull());
    act(() => result.current.followLink("a"));
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));
    act(() => result.current.openNote("b"));
    act(() => result.current.openNote("a"));
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));
    // Choosing the default again forgets the choice, as for any default.
    act(() => result.current.selectTab("v1"));
    expect(rememberedTab("a")).toBeNull();
  });

  it("adding 「內容」 back lets the page show it again", async () => {
    const { result } = renderHook(() => useFocus({ nodeId: "a", lens: "editor" }));
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));
    await act(async () => { await import("../lib/contentTab").then((mod) => mod.showContentTab("a")); });
    act(() => result.current.selectTab("content"));
    expect(result.current.viewTab).toBeNull();
  });
});

describe("a caret waiting for the text (settleRemovedContent): the question before 「內容」 is added back", () => {
  const show = vi.fn();
  const settle = (isOwner = true, id = "a") => settleRemovedContent({ id, waiting: true, isOwner, confirm, show, stillOn: () => true });
  beforeEach(() => { show.mockClear(); setPendingCursor("a", 3); });

  it("nothing to ask when the tab shows or the note never had it hidden: no question, no write, the text is shown", async () => {
    server.views = [view("c1", "content", { layout_config: {} })];
    resetOwnerViews();
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith("content");
  });

  it("asks once; yes shows the tab again (last, the hidden flag cleared by itself) and then the text", async () => {
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toBe("This note has no content tab. Add it?");
    expect(update).toHaveBeenCalledWith({ kind: "node", id: "a" }, "c1", { layout_config_patch: { hidden: null }, pin_order: 1 });
    expect(show).toHaveBeenCalledWith("content");
  });

  it("no drops the jump and writes nothing; a read-only member is not asked and is told what is tucked away", async () => {
    confirm.mockResolvedValueOnce(false);
    await settle();
    expect(update).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(readSession(SESSION_KEYS.pendingCursor("a"))).toBeNull();
    setPendingCursor("a", 3);
    spaces.list = [{ id: "s1", kind: "shared", permission: "view", can_manage: false }];
    resetAppState({ data: { ...noWorkspaceData, nodes: [node("a", { collection_views: REMOVED() as never, space_id: "s1" })] } });
    await settle(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual(["The text of this note is tucked away, and you don't have permission to put its tab back."]);
    expect(show).not.toHaveBeenCalled();
  });

  it("a refused write drops the jump and leaves the tab hidden", async () => {
    update.mockRejectedValueOnce(new Error("refused"));
    await settle();
    expect(show).not.toHaveBeenCalled();
    expect(readSession(SESSION_KEYS.pendingCursor("a"))).toBeNull();
  });
});

describe("a jump to a line of the text (backlink, mention) in a note whose 「內容」 was removed", () => {
  /** From note b, a backlink opens note a on a line of its text. */
  const jump = async () => {
    await act(async () => { setSelectedId("b"); });
    await act(async () => { setPendingCursor("a", 3); setSelectedId("a"); });
  };

  it("opens the default tab, asks, and on yes shows the text where the caret goes", async () => {
    const { result } = renderHook(() => useFocus({ nodeId: "b", lens: "editor" }));
    await jump();
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.viewTab).toBeNull());
    expect(readSession(SESSION_KEYS.pendingCursor("a"))).not.toBeNull(); // the editor takes it when it opens
  });

  it("on no, the jump is dropped: the default tab stays and no caret is left pending", async () => {
    confirm.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useFocus({ nodeId: "b", lens: "editor" }));
    await jump();
    await waitFor(() => expect(readSession(SESSION_KEYS.pendingCursor("a"))).toBeNull());
    expect(update).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));
  });

  it("for a read-only member: not asked, told, and dropped", async () => {
    spaces.list = [{ id: "s1", kind: "shared", permission: "view", can_manage: false }];
    resetAppState({ data: { ...noWorkspaceData, nodes: [node("a", { collection_views: REMOVED() as never, space_id: "s1" }), node("b")] } });
    renderHook(() => useFocus({ nodeId: "b", lens: "editor" }));
    await jump();
    await waitFor(() => expect(toasts).toEqual(["The text of this note is tucked away, and you don't have permission to put its tab back."]));
    expect(confirm).not.toHaveBeenCalled();
    expect(readSession(SESSION_KEYS.pendingCursor("a"))).toBeNull();
    expect(getAppState().selectedId).toBe("a");
  });
});

describe("the page and the jump, however it was reached", () => {
  it("a jump that arrives by changing the place, not the note (a task's line from the tasks page) asks too, and no caret is left pending on no", async () => {
    confirm.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useFocus({ nodeId: "a", lens: "editor", viewTab: "v1", mode: "tasks" }));
    await act(async () => { setPendingCursor("a", 3); result.current.setMode("notes"); });
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readSession(SESSION_KEYS.pendingCursor("a"))).toBeNull());
    expect(update).not.toHaveBeenCalled();
    expect(result.current.viewTab).toBe("v1");
    // Opened normally later: nothing is asked.
    await act(async () => { result.current.openNote("b"); });
    await act(async () => { result.current.openNote("a"); });
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("a yes after the person went to another note shows nothing there and leaves no caret pending", async () => {
    let answer: (yes: boolean) => void = () => {};
    confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const { result } = renderHook(() => useFocus({ nodeId: "b", lens: "editor" }));
    await act(async () => { setSelectedId("b"); });
    await act(async () => { setPendingCursor("a", 3); setSelectedId("a"); });
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await act(async () => { setSelectedId("b"); });
    await act(async () => { answer(true); });
    await waitFor(() => expect(readSession(SESSION_KEYS.pendingCursor("a"))).toBeNull());
    expect(result.current.viewTab).toBeNull();
    expect(result.current.notesView).toBe("editor");
  });

  it("a palette command or a Back onto 「內容」 of such a note opens its default tab and says where the text is, once", async () => {
    // Its own note: what was told about is kept per note for the session.
    resetAppState({ data: { ...noWorkspaceData, nodes: [node("e", { collection_views: REMOVED() as never }), node("b")] } });
    setSelectedId("e");
    const { result } = renderHook(() => useFocus({ nodeId: "e", lens: "editor" }));
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));
    act(() => result.current.selectTab("content"));
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));
    await waitFor(() => expect(toasts).toEqual(["The text is still there. Add the 「Content」 tab back from ＋ to see it."]));
    act(() => result.current.selectTab("content"));
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));
    expect(toasts).toHaveLength(1);
  });

  it("the default follows pin_order, not creation order, before the tab row has read the views", async () => {
    // 「內容」 shows, was made first but moved after the table; the note's own row lists by creation.
    resetAppState({ data: { ...noWorkspaceData, nodes: [node("a", { collection_views: [view("c1", "content", { name: "Content", pin_order: 2 }), view("v1", "table", { pin_order: 1 })] as never }), node("b")] } });
    setSelectedId("a");
    const { result } = renderHook(() => useFocus({ nodeId: "a", lens: "editor" }));
    await waitFor(() => expect(result.current.viewTab).toBe("v1"));
  });
});
