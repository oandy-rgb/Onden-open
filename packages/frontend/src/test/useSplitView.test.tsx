// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { applyUrlRight, getSplit, requestSplitOpen, setRight, splitDrag } from "../lib/splitViewStore";
import { notePress } from "../lib/splitView";
import { useSplitView } from "../hooks/useSplitView";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../lib/appStore", async (original) => ({ ...(await original<typeof import("../lib/appStore")>()), addToast: (message: string) => { toasts.push(message); } }));
const dayNotes = vi.hoisted(() => ({ openToday: vi.fn(async () => null as { node: { id: string } } | null) }));
vi.mock("../lib/data", async (original) => ({ ...(await original<typeof import("../lib/data")>()), dayNotes }));

const node = (id: string, over: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", parent_id: null, updated_at: "2026-10-01T00:00:00Z", ...over }) as ContentNode;

const calls = { openNote: vi.fn(), selectTab: vi.fn() };
type Where = { mode: string; selectedId: string | null; notesView: string };
/** The workspace's real state for where the left is, so a change on one side shows on the other. */
function setup(initial: Partial<Where>) {
  return renderHook(() => {
    const [where, setWhere] = useState<Where>({ mode: "notes", selectedId: null, notesView: "editor", ...initial });
    const split = useSplitView({
      mode: where.mode, selectedId: where.selectedId, notesView: where.notesView, viewTab: null,
      setMode: (mode) => setWhere((w) => ({ ...w, mode })),
      openModuleScreen: (mode) => setWhere((w) => ({ ...w, mode })),
      openNote: (id) => { calls.openNote(id); setWhere({ mode: "notes", selectedId: id, notesView: "editor" }); },
      selectTab: (key) => { calls.selectTab(key); setWhere((w) => ({ ...w, notesView: key === "canvas" ? "canvas" : "editor" })); },
    });
    return { ...split, where, setWhere };
  });
}

beforeEach(() => {
  resetAppState({ data: { ...noWorkspaceData, nodes: [node("a"), node("b", { updated_at: "2026-10-30T00:00:00Z" }), node("c", { updated_at: "2026-10-20T00:00:00Z" })] }, online: true });
  Object.values(calls).forEach((fn) => fn.mockClear());
  toasts.length = 0;
  dayNotes.openToday.mockClear();
});
afterEach(() => { setRight(null); applyUrlRight(null); splitDrag.cancel(); });

describe("useSplitView", () => {
  it("opens a destination on the right, and a menu request does the same", () => {
    const view = setup({ selectedId: "a" });
    act(() => { view.result.current.openRight({ kind: "page", mode: "tasks" }); });
    expect(getSplit().right).toEqual({ kind: "page", mode: "tasks" });
    act(() => requestSplitOpen({ kind: "note", id: "c", tab: "content" }, "right"));
    expect(getSplit().right).toEqual({ kind: "note", id: "c", tab: "content" });
  });

  it("refuses the same view on both sides with a sentence, and leaves the right as it was", () => {
    const view = setup({ selectedId: "a", notesView: "canvas" });
    act(() => { view.result.current.openRight({ kind: "note", id: "c", tab: "content" }); });
    act(() => { expect(view.result.current.openRight({ kind: "note", id: "a", tab: "canvas" })).toBe(false); });
    expect(getSplit().right).toEqual({ kind: "note", id: "c", tab: "content" });
    expect(toasts).toHaveLength(1);
    // The same note's text is another view: allowed.
    act(() => { expect(view.result.current.openRight({ kind: "note", id: "a", tab: "content" })).toBe(true); });
  });

  it("a note's text on both sides is 並排 (the editor left, rendered right): allowed", () => {
    const view = setup({ selectedId: "a" });
    act(() => { expect(view.result.current.openRight({ kind: "note", id: "a", tab: "content" })).toBe(true); });
    expect(getSplit().right).toEqual({ kind: "note", id: "a", tab: "content" });
    expect(toasts).toHaveLength(0);
  });

  it("refuses one page on both sides", () => {
    const view = setup({ mode: "tasks" });
    act(() => { expect(view.result.current.openRight({ kind: "page", mode: "tasks" })).toBe(false); });
    expect(getSplit().right).toBeNull();
  });

  it("the shortcut with nothing on the right opens the note last written, not the one on the left", async () => {
    const view = setup({ selectedId: "b" });
    await act(async () => { await view.result.current.toggleCurrent(); });
    expect(getSplit().right).toEqual({ kind: "note", id: "c", tab: "content" });
  });

  it("from a function page the right is the note last written", async () => {
    const view = setup({ mode: "rss", selectedId: "a" });
    await act(async () => { await view.result.current.toggleCurrent(); });
    expect(getSplit().right).toEqual({ kind: "note", id: "b", tab: "content" });
  });

  it("with no note to show it is today's day note", async () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [] }, online: true });
    dayNotes.openToday.mockResolvedValueOnce({ node: { id: "today" } });
    const view = setup({ mode: "rss" });
    await act(async () => { await view.result.current.toggleCurrent(); });
    expect(getSplit().right).toEqual({ kind: "note", id: "today", tab: "content" });
    expect(dayNotes.openToday).toHaveBeenCalledWith({ create: false });
  });

  it("the shortcut on a whiteboard tab moves it right and leaves the text on the left", async () => {
    const view = setup({ selectedId: "a", notesView: "canvas" });
    await act(async () => { await view.result.current.toggleCurrent(); });
    expect(getSplit().right).toEqual({ kind: "note", id: "a", tab: "canvas" });
    expect(calls.selectTab).toHaveBeenCalledWith("content");
    expect(view.result.current.where.notesView).toBe("editor");
  });

  it("the shortcut with a right side open closes it", async () => {
    const view = setup({ selectedId: "a" });
    act(() => { view.result.current.openRight({ kind: "note", id: "c", tab: "content" }); });
    await act(async () => { await view.result.current.toggleCurrent(); });
    expect(getSplit().right).toBeNull();
  });

  it("swapping puts the right on the left and the left on the right", () => {
    const view = setup({ selectedId: "a" });
    act(() => { view.result.current.openRight({ kind: "page", mode: "tasks" }); });
    act(() => view.result.current.swap());
    expect(view.result.current.where.mode).toBe("tasks");
    expect(getSplit().right).toEqual({ kind: "note", id: "a", tab: "content" });
  });

  it("a drop of the right pane's header on the left brings it back to the left", () => {
    vi.stubGlobal("innerWidth", 1280);
    const view = setup({ selectedId: "a" });
    act(() => { view.result.current.openRight({ kind: "note", id: "c", tab: "content" }); });
    act(() => { splitDrag.begin({ kind: "note", id: "c", tab: "content" }, "right-header"); splitDrag.drop(100); });
    expect(calls.openNote).toHaveBeenCalledWith("c");
    expect(getSplit().right).toEqual({ kind: "note", id: "a", tab: "content" });
    vi.unstubAllGlobals();
  });

  it("opening beside: from the left it lands on the right, from the right on the left", () => {
    const view = setup({ selectedId: "a" });
    act(() => view.result.current.openBeside("c", "left"));
    expect(getSplit().right).toEqual({ kind: "note", id: "c", tab: "content" });
    act(() => view.result.current.openBeside("b", "right"));
    expect(calls.openNote).toHaveBeenCalledWith("b");
  });

  it("Ctrl/⌘ + click is known for a moment", () => {
    const view = setup({ selectedId: "a" });
    notePress({ ctrlKey: true, metaKey: false }, performance.now());
    expect(view.result.current.modClick()).toBe(true);
    notePress({ ctrlKey: false, metaKey: false }, performance.now());
    expect(view.result.current.modClick()).toBe(false);
  });

  it("when the left comes to show the view the right shows, the right gives way", () => {
    const view = setup({ selectedId: "a" });
    act(() => { view.result.current.openRight({ kind: "note", id: "c", tab: "canvas" }); });
    act(() => view.result.current.setWhere({ mode: "notes", selectedId: "c", notesView: "canvas" }));
    expect(getSplit().right).toBeNull();
    expect(toasts.length).toBeGreaterThan(0);
  });

  it("when the left opens the note the right shows as text, both stay: that is 並排", () => {
    const view = setup({ selectedId: "a" });
    act(() => { view.result.current.openRight({ kind: "note", id: "c", tab: "content" }); });
    act(() => view.result.current.setWhere({ mode: "notes", selectedId: "c", notesView: "editor" }));
    expect(getSplit().right).toEqual({ kind: "note", id: "c", tab: "content" });
  });

  it("a right note that was deleted closes the right", () => {
    const view = setup({ selectedId: "a" });
    act(() => { view.result.current.openRight({ kind: "note", id: "c", tab: "content" }); });
    act(() => { resetAppState({ data: { ...noWorkspaceData, nodes: [node("a")] }, online: true }); });
    expect(getSplit().right).toBeNull();
  });

  it("a reload comes back from the address (right=…)", () => {
    applyUrlRight("note:c:canvas");
    const view = setup({ selectedId: "a" });
    expect(view.result.current.split.right).toEqual({ kind: "note", id: "c", tab: "canvas" });
  });
});

describe("useSplitView on a phone (no side by side, owner 2026-11-08)", () => {
  afterEach(() => clearPhoneLayout());

  it("opens nothing on the right, shows nothing already stored, and a note opened 'beside' opens on the one screen", () => {
    setRight({ kind: "page", mode: "tasks" }); // stored while the window was wide
    setPhoneLayout(true);
    const view = setup({ selectedId: "a" });
    expect(view.result.current.split.right).toBeNull();
    act(() => { expect(view.result.current.openRight({ kind: "note", id: "c", tab: "content" })).toBe(false); });
    act(() => requestSplitOpen({ kind: "note", id: "c", tab: "content" }, "right"));
    act(() => { view.result.current.openBeside("b", "left"); });
    expect(calls.openNote).toHaveBeenCalledWith("b");
    expect(view.result.current.modClick()).toBe(false);
  });

  it("the shortcut does nothing", async () => {
    setPhoneLayout(true);
    const view = setup({ selectedId: "b" });
    await act(async () => { await view.result.current.toggleCurrent(); });
    expect(getSplit().right).toBeNull();
    expect(toasts).toHaveLength(0);
  });
});

