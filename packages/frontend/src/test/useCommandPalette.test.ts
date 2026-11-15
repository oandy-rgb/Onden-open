import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async original => ({
  ...await original<typeof import("../lib/api")>(),
  apiFetch: request,
  api: async (path: string, init?: RequestInit) => {
    const response = await request(path, init);
    if (!response.ok) throw new Error("unavailable");
    return response.json();
  },
}));
import { useCommandPalette } from "../hooks/useCommandPalette";
import { usePaletteState } from "../hooks/usePaletteState";
import { capabilitiesFor } from "../lib/capabilities";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import type { Space } from "../lib/spaces";
const options = () => ({ setMode: vi.fn(), showTags: vi.fn(), setNotesView: vi.fn(), setSelectedId: vi.fn(), setCreateOpen: vi.fn(),
  setOverviewPane: vi.fn(), refresh: vi.fn(async () => {}), nodes: [], canvases: [], activeCanvasId: null as string | null,
  selectedNode: null as ContentNode | null, selectCanvas: vi.fn(), capabilities: capabilitiesFor(true, [], false) });
function pending() { let resolve!: (r: Response) => void; const promise = new Promise<Response>(yes => { resolve = yes; }); return { promise, resolve }; }
const rows = (id: string) => Response.json([{ id, title: id, node_type: "content", snippet: { text: id, ranges: [] } }]);
const realSetTimeout = globalThis.setTimeout;
beforeEach(() => { vi.useFakeTimers(); request.mockReset(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
/** Fire the debounced search and wait until its already-resolved mocked response has settled. One timer advance is not enough:
 *  reading the `Response` body finishes on later ticks, which under load come after the test's next step (and runPaletteItem
 *  ignores a click while the search is loading). The body is read on real ticks, so a loaded machine needs more than 1 s.
 *  Polled on a real timer (up to 2 s), not vi.waitFor: under fake timers vi.waitFor stopped after its first check when
 *  「waits for create acceptance」 ran first in the file, the test timed out and every later renderHook came back null. */
async function searchSettled(result: { current: { searchLoading: boolean } }) {
  await act(async () => vi.advanceTimersByTime(201));
  for (let i = 0; i < 200 && result.current.searchLoading; i++) await act(() => new Promise<void>(done => realSetTimeout(done, 10)));
  expect(result.current.searchLoading).toBe(false);
}

it("keeps search results with their query and ignores a late previous response", async () => {
  const old = pending(), latest = pending(); request.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  const { result } = renderHook(() => useCommandPalette(options(), usePaletteState()));
  act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery("?alpha"); });
  await act(async () => vi.advanceTimersByTime(201));
  act(() => result.current.setPaletteQuery("?beta"));
  await act(async () => vi.advanceTimersByTime(201));
  await act(async () => latest.resolve(rows("beta")));
  expect(result.current.paletteItems.map(x => x.id)).toEqual(["beta"]);
  await act(async () => old.resolve(rows("alpha")));
  expect(result.current.paletteItems.map(x => x.id)).toEqual(["beta"]);
});

it("does not open hidden old results while a new search is waiting", async () => {
  request.mockResolvedValueOnce(rows("alpha")).mockReturnValueOnce(pending().promise);
  const opts = options(); const { result } = renderHook(() => useCommandPalette(opts, usePaletteState()));
  act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery("?alpha"); });
  await searchSettled(result);
  const old = result.current.paletteItems[0];
  act(() => result.current.setPaletteQuery("?beta"));
  expect(result.current.paletteItems).toEqual([]);
  await act(async () => { await result.current.runPaletteItem(old); });
  expect(opts.setSelectedId).not.toHaveBeenCalled();
  expect(result.current.paletteOpen).toBe(true);
});

it("reports a failed search without a create-on-miss claim and can retry", async () => {
  request.mockResolvedValueOnce(new Response("Unavailable", { status: 503 })).mockResolvedValueOnce(rows("recovered"));
  const { result } = renderHook(() => useCommandPalette(options(), usePaletteState()));
  act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery("unmatched"); });
  await searchSettled(result);
  expect(result.current.searchError).toBe(true);
  expect(result.current.paletteItems.some(x => x.kind === "create")).toBe(false);
  act(() => result.current.retrySearch());
  await searchSettled(result);
  expect(result.current.searchError).toBe(false);
  expect(result.current.paletteItems[0].id).toBe("recovered");
});

it("does not revive a search after closing and reopening with the same query", async () => {
  const old = pending(), latest = pending(); request.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  const { result } = renderHook(() => useCommandPalette(options(), usePaletteState()));
  act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery("?alpha"); });
  await act(async () => vi.advanceTimersByTime(201));
  act(() => result.current.setPaletteOpen(false));
  act(() => result.current.setPaletteOpen(true));
  await act(async () => vi.advanceTimersByTime(201));
  await act(async () => old.resolve(rows("stale")));
  expect(result.current.paletteItems).toEqual([]);
  expect(result.current.searchLoading).toBe(true);
  await act(async () => latest.resolve(rows("fresh")));
  expect(result.current.paletteItems.map(x => x.id)).toEqual(["fresh"]);
});

it("evaluates canvas actions against the currently opened board", () => {
  const opts = options(); const { result, rerender } = renderHook(() => useCommandPalette(opts, usePaletteState()));
  act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">"); });
  const enabled = () => { const item = result.current.paletteItems.find(x => x.id === "a-tidy-canvas")!;
    return item.kind === "action" && item.when?.(); };
  expect(enabled()).toBe(false);
  opts.activeCanvasId = "board"; rerender(); expect(enabled()).toBe(true);
  opts.activeCanvasId = null; rerender(); expect(enabled()).toBe(false);
});

it("finds task navigation by its keyword even when labels are translated", async () => {
  const { setLocalePref } = await import("../lib/i18n");
  setLocalePref("zh-TW");
  try {
    const { result } = renderHook(() => useCommandPalette(options(), usePaletteState()));
    act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">tasks"); });
    expect(result.current.paletteItems.some(x => x.id === "a-tasks")).toBe(true);
  } finally { act(() => setLocalePref("en")); }
});

it("waits for create acceptance, keeps refused input and prevents duplicate submissions", async () => {
  request.mockResolvedValue(Response.json([]));
  let finish!: (accepted: boolean) => void;
  const createNamedNote = vi.fn().mockImplementationOnce(() => new Promise<boolean>(yes => { finish = yes; }))
    .mockResolvedValueOnce(true);
  const { result } = renderHook(() => useCommandPalette({ ...options(), createNamedNote }, usePaletteState()));
  act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery("Keep my title"); });
  await searchSettled(result);
  const create = result.current.paletteItems.find(x => x.kind === "create")!;
  act(() => { void result.current.runPaletteItem(create); void result.current.runPaletteItem(create); });
  expect(createNamedNote).toHaveBeenCalledExactlyOnceWith("Keep my title");
  expect(result.current.actionBusy).toBe(true);
  expect(result.current.paletteOpen).toBe(true);
  await act(async () => finish(false));
  expect(result.current.actionBusy).toBe(false);
  expect(result.current.actionFailed).toBe(true);
  expect(result.current.paletteQuery).toBe("Keep my title");
  await act(async () => result.current.runPaletteItem(result.current.paletteItems.find(x => x.kind === "create")!));
  expect(createNamedNote).toHaveBeenCalledTimes(2);
  expect(result.current.paletteOpen).toBe(false);
  expect(result.current.paletteQuery).toBe("");
});

it("contains a rejected action promise and preserves the open panel", async () => {
  const refresh = vi.fn().mockRejectedValue(new Error("network error"));
  const { result } = renderHook(() => useCommandPalette({ ...options(), refresh }, usePaletteState()));
  act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">"); });
  await act(async () => result.current.runPaletteItem(result.current.paletteItems.find(x => x.id === "a-refresh")!));
  expect(result.current.paletteOpen).toBe(true);
  expect(result.current.actionBusy).toBe(false);
  expect(result.current.actionFailed).toBe(true);
});

it("opens the visible capture form for New note from any app mode", async () => {
  const capture = vi.fn(); window.addEventListener("onden-open-quick-capture", capture);
  const opts = options();
  try {
    const { result } = renderHook(() => useCommandPalette(opts, usePaletteState()));
    act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">"); });
    const item = result.current.paletteItems.find(x => x.id === "a-new")!;
    expect(item).toMatchObject({ label: "Quick capture", shortcutId: "quick-capture" });
    await act(async () => result.current.runPaletteItem(item));
    expect(capture).toHaveBeenCalledOnce();
    expect(opts.setCreateOpen).not.toHaveBeenCalled();
    expect(result.current.paletteOpen).toBe(false);
  } finally { window.removeEventListener("onden-open-quick-capture", capture); }
});

it("opens the quick-add task sheet from 新增任務, and finds it by 任務 or 待辦", async () => {
  const open = vi.fn(); window.addEventListener("onden-open-quick-add-task", open);
  try {
    const { result } = renderHook(() => useCommandPalette(options(), usePaletteState()));
    act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">"); });
    const item = result.current.paletteItems.find(x => x.id === "a-add-task")!;
    expect(item).toMatchObject({ kind: "action", keywords: expect.arrayContaining(["任務", "待辦", "新增"]) });
    await act(async () => result.current.runPaletteItem(item));
    expect(open).toHaveBeenCalledOnce();
    expect(result.current.paletteOpen).toBe(false);
  } finally { window.removeEventListener("onden-open-quick-add-task", open); }
});

// D112: the palette's note commands are the selected note's action list
// (lib/data noteActionList), the same as the header ⋯ menu.
describe("note commands follow the selected note", () => {
  const text = { id: "n1", title: "Text", slug: "text", markdown: "Body", node_type: "content", source_type: "manual", space_id: "s1" } as ContentNode;
  const child = { ...text, id: "c1", title: "Child", parent_id: "n1" } as ContentNode;
  const ids = (result: { current: ReturnType<typeof useCommandPalette> }) => {
    act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">"); });
    return result.current.paletteItems.map(x => x.id);
  };
  beforeEach(() => resetAppState({ data: { ...noWorkspaceData, workspace: { ...noWorkspaceData.workspace, modules: ["slides", "skills"] } }, online: true }));
  afterEach(() => resetAppState());

  it("has no whole-note split, merge or send-to-Tasks command", () => {
    const list = ids(renderHook(() => useCommandPalette({ ...options(), selectedNode: { ...text, markdown: "- [ ] a" }, nodes: [text, child] }, usePaletteState())).result);
    for (const id of ["a-split-note", "a-merge-children", "a-checklist-tasks"]) expect(list).not.toContain(id);
  });

  it("gives a viewer no note command that writes", () => {
    const viewer = capabilitiesFor(false, [{ id: "s1", kind: "shared", permission: "view", can_manage: false } as Space], true);
    const list = ids(renderHook(() => useCommandPalette({ ...options(), selectedNode: text, nodes: [text, child], capabilities: viewer }, usePaletteState())).result);
    expect(list).not.toContain("a-pin-note");
    expect(list).toContain("a-copy-md");
  });

  it("keeps note commands listed, greyed, while no note is selected", () => {
    const { result } = renderHook(() => useCommandPalette(options(), usePaletteState()));
    act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">"); });
    const pin = result.current.paletteItems.find(x => x.id === "a-pin-note")!;
    expect(pin.kind === "action" && pin.when?.()).toBe(false);
  });
});

describe("history commands", () => {
  const text = { id: "n1", title: "Text", slug: "text", markdown: "Body", node_type: "content", source_type: "manual", space_id: "s1" } as ContentNode;
  const search = (query: string, selectedNode: ContentNode | null) => {
    const { result } = renderHook(() => useCommandPalette({ ...options(), selectedNode, nodes: selectedNode ? [selectedNode] : [] }, usePaletteState()));
    act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(`>${query}`); });
    return result;
  };

  it.each(["歷史", "版本", "復原", "變更"])("finds the workspace changes and this note's history by 「%s」", (word) => {
    const result = search(word, text);
    const ids = result.current.paletteItems.map(x => x.id);
    expect(ids).toContain("a-timeline");
    expect(ids).toContain("a-note-history");
    // 切換到歷史 (the note's History lens) is gone: a note's history is its time slider.
    expect(ids).not.toContain("a-history");
  });

  it.each(["log", "這則筆記的歷史"])("keeps finding this note's history by the old 「%s」 keyword", (word) => {
    expect(search(word, text).current.paletteItems.map(x => x.id)).toContain("a-note-history");
  });

  it("goes to the workspace changes view, and asks the editor to open this note's history", async () => {
    const opts = { ...options(), selectedNode: text, nodes: [text] };
    const { result } = renderHook(() => useCommandPalette(opts, usePaletteState()));
    act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">歷史"); });
    const seen = vi.fn(); window.addEventListener("onden-open-note-history", seen);
    await act(async () => { await result.current.runPaletteItem(result.current.paletteItems.find(x => x.id === "a-note-history")!); });
    expect(seen).toHaveBeenCalledTimes(1);
    act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">變更"); });
    await act(async () => { await result.current.runPaletteItem(result.current.paletteItems.find(x => x.id === "a-timeline")!); });
    expect(opts.setMode).toHaveBeenCalledWith("timeline");
    window.removeEventListener("onden-open-note-history", seen);
  });
});

it("lists each imported module's add dialog and opens it through openDialogEntry", async () => {
  const openDialogEntry = vi.fn();
  const { result } = renderHook(() => useCommandPalette({ ...options(), openDialogEntry }, usePaletteState()));
  act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">"); });
  const actions = result.current.paletteItems.flatMap(x => x.kind === "action" ? [x] : []);
  const labels = actions.map(x => x.label);
  expect(labels).toEqual(expect.arrayContaining(["Import SKILL.md…"]));
  const skill = actions.find(x => x.label === "Import SKILL.md…")!;
  await act(async () => { await result.current.runPaletteItem(skill); });
  expect(openDialogEntry).toHaveBeenCalledExactlyOnceWith("skills");
});
