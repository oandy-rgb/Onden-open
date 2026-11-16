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
import { ensureContentTab } from "../lib/contentTab";

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

function useFocus(initial: { nodeId: string | null; lens: NodeLens; viewTab?: string | null; tabShownByEntry?: boolean }) {
  const [notesView, setNotesView] = useState<NodeLens>(initial.lens);
  const [viewTab, setViewTab] = useState<string | null>(initial.viewTab ?? null);
  const ui = { mode: "notes", setMode: vi.fn(), notesView, setNotesView, viewTab, setViewTab, setOverviewMobileTab: vi.fn() };
  const focus = useWorkspaceFocus({
    ui: ui as never, initialLocation: initial,
    boards: { selectCanvas: vi.fn(async () => {}) as never, createCanvas: vi.fn() as never },
    canvasImported: true, setCanvasNavStack: vi.fn(), confirm,
  });
  return { ...focus, notesView, viewTab };
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
    await act(async () => { await ensureContentTab("a", { canManage: true, confirm }); });
    act(() => result.current.selectTab("content"));
    expect(result.current.viewTab).toBeNull();
  });
});

describe("ensureContentTab: something needs a place in the text", () => {
  it("true at once when the tab shows or the note never had it hidden: no question, no write", async () => {
    server.views = [view("v1", "table")];
    expect(await ensureContentTab("a", { canManage: true, confirm })).toBe(true);
    server.views = [view("c1", "content", { layout_config: {} })];
    resetOwnerViews();
    expect(await ensureContentTab("a", { canManage: true, confirm })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("asks once; yes shows the tab again (last, the hidden flag cleared by itself) and goes on", async () => {
    expect(await ensureContentTab("a", { canManage: true, confirm })).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toBe("This note has no content tab. Add it?");
    expect(update).toHaveBeenCalledWith({ kind: "node", id: "a" }, "c1", { layout_config_patch: { hidden: null }, pin_order: 1 });
  });

  it("no cancels the action and writes nothing; a read-only member is not asked and is told", async () => {
    confirm.mockResolvedValueOnce(false);
    expect(await ensureContentTab("a", { canManage: true, confirm })).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(await ensureContentTab("a", { canManage: false, confirm })).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual(["You can't change this note."]);
  });

  it("a refused write answers false and leaves the tab hidden", async () => {
    update.mockRejectedValueOnce(new Error("refused"));
    expect(await ensureContentTab("a", { canManage: true, confirm })).toBe(false);
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
    await waitFor(() => expect(toasts).toEqual(["You can't change this note."]));
    expect(confirm).not.toHaveBeenCalled();
    expect(readSession(SESSION_KEYS.pendingCursor("a"))).toBeNull();
    expect(getAppState().selectedId).toBe("a");
  });
});
