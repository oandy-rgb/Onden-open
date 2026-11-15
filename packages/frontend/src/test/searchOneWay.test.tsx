// The sidebar and the command palette are two doors to one search
// (reads.notes.search): the same query gives the same notes, offline gives the
// device's copy with a notice, and an answer that a newer keystroke overtook
// never replaces the newer one.

import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const localMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: (...args: unknown[]) => apiMock(...args) }));
vi.mock("../lib/localDb", () => ({ searchNodes: (...args: unknown[]) => localMock(...args) }));
import { useOverviewSearch } from "../hooks/useOverviewSearch";
import { useCommandPalette } from "../hooks/useCommandPalette";
import { usePaletteState } from "../hooks/usePaletteState";
import { SearchOfflineNotice } from "../components/SearchOfflineNotice";
import { capabilitiesFor } from "../lib/capabilities";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import { loadFuse } from "../lib/lazyFuse";

const nodes = [
  { id: "k", title: "Kafka streams", node_type: "content", markdown: "log processing", class_tag_ids: [], label_tag_ids: [] },
  { id: "p", title: "Kafka primer", node_type: "content", markdown: "intro", class_tag_ids: [], label_tag_ids: [] },
] as unknown as ContentNode[];
const row = (id: string, title: string) => ({ id, title, node_type: "content", snippet: null });
const paletteOptions = () => ({ setMode: vi.fn(), showTags: vi.fn(), setNotesView: vi.fn(), setSelectedId: vi.fn(), setCreateOpen: vi.fn(),
  setOverviewPane: vi.fn(), refresh: vi.fn(async () => {}), nodes, canvases: [], activeCanvasId: null as string | null,
  selectedNode: null as ContentNode | null, selectCanvas: vi.fn(), capabilities: capabilitiesFor(true, [], false) });

// Typo matching needs Fuse, which loads on first use (lib/lazyFuse). Under load that import can
// outlast the fake-timer windows below, and the search falls back to a plain match.
beforeAll(async () => { await loadFuse(); });
beforeEach(() => {
  vi.useFakeTimers(); apiMock.mockReset(); localMock.mockReset(); localStorage.clear(); vi.restoreAllMocks();
  resetAppState({ data: { ...noWorkspaceData, nodes } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function sidebarIds(query: string) {
  act(() => setAppState({ overviewSearch: query }));
  const { result } = renderHook(() => useOverviewSearch());
  await act(async () => { await vi.advanceTimersByTimeAsync(130); });
  return result.current;
}
async function paletteIds(query: string) {
  const { result } = renderHook(() => useCommandPalette(paletteOptions(), usePaletteState()));
  act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(`?${query}`); });
  await act(async () => { await vi.advanceTimersByTimeAsync(210); });
  return result.current;
}

describe("one search for both doors", () => {
  it("gives the same notes in the same order for the same query", async () => {
    apiMock.mockResolvedValue([row("p", "Kafka primer"), row("k", "Kafka streams")]);
    const sidebar = await sidebarIds("kafka");
    const palette = await paletteIds("kafka");
    expect(sidebar.overviewSearchResults.map((r) => r.id)).toEqual(["p", "k"]);
    expect(palette.paletteItems.map((i) => i.id)).toEqual(["p", "k"]);
  });

  it("finds a mistyped title through both doors", async () => {
    apiMock.mockResolvedValue([]);
    const sidebar = await sidebarIds("kafak streams");
    const palette = await paletteIds("kafak streams");
    expect(sidebar.overviewSearchResults.map((r) => r.id)).toEqual(["k"]);
    expect(palette.paletteItems.filter((i) => i.kind === "node").map((i) => i.id)).toEqual(["k"]);
  });

  it("offline, both use this device's copy and say so", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    localMock.mockResolvedValue([{ id: "k", snippet: null }]);
    const sidebar = await sidebarIds("kafka");
    const palette = await paletteIds("kafka");
    expect(sidebar.overviewSearchResults.map((r) => r.id)).toEqual(["k"]);
    expect(palette.paletteItems.map((i) => i.id)).toEqual(["k"]);
    expect(sidebar.overviewSearchOutcome?.offline).toBe(true);
    expect(palette.searchOutcome?.offline).toBe(true);
    const { container } = render(<SearchOfflineNotice outcome={sidebar.overviewSearchOutcome} />);
    expect(container.textContent).toBe("Offline results");
  });

  it("shows a note only the server named, with the server's title", async () => {
    apiMock.mockResolvedValue([row("remote", "Only on the server")]);
    const sidebar = await sidebarIds("server");
    expect(sidebar.overviewSearchResults).toMatchObject([{ id: "remote", title: "Only on the server", node: null, path: [] }]);
  });

  it("never lets a slow older answer replace the newer one", async () => {
    let releaseOld!: (rows: unknown[]) => void;
    apiMock.mockReturnValueOnce(new Promise((resolve) => { releaseOld = resolve; })).mockResolvedValueOnce([row("k", "Kafka streams")]);
    act(() => setAppState({ overviewSearch: "kaf" }));
    const { result } = renderHook(() => useOverviewSearch());
    await act(async () => { await vi.advanceTimersByTimeAsync(130); });
    act(() => setAppState({ overviewSearch: "kafka" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(130); });
    expect(result.current.overviewSearchResults.map((r) => r.id)).toEqual(["k"]);
    const signal = (apiMock.mock.calls[0][1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(true);
    await act(async () => releaseOld([row("p", "Kafka primer")]));
    expect(result.current.overviewSearchResults.map((r) => r.id)).toEqual(["k"]);
  });
});
