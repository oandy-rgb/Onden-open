import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import OverviewEditor from "../components/OverviewEditor";
import { useCommandPalette } from "../hooks/useCommandPalette";
import { usePaletteState } from "../hooks/usePaletteState";
import { capabilitiesFor } from "../lib/capabilities";
import type { ContentNode } from "../lib/api";

// 指令面板的「寫作模式」不再點按鈕（⋯ › 顯示… 裡的選單項不在頁面上），
// 而是發出請求，由目前開著的筆記編輯器進入寫作模式。

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn(async () => new Response("[]", { status: 200 })) }));

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const note: ContentNode = { id: "note-a", title: "A", slug: "a", markdown: "text", node_type: "content", source_type: "manual" };

afterEach(() => { cleanup(); document.body.classList.remove("onden-zen"); });

describe("command palette › Writing mode", () => {
  it("enters writing mode in the open note", async () => {
    render(
      <OverviewEditor node={note} titleDraft={note.title} onTitleChange={() => {}} draft={note.markdown ?? ""} onDraftChange={() => {}}
        view="edit" setView={() => {}} saveStatus="saved" onSave={() => {}} online nodes={[note]}
        onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} />,
    );
    const { result } = renderHook(() => useCommandPalette({ setMode: vi.fn(), showTags: vi.fn(), setNotesView: vi.fn(), setSelectedId: vi.fn(),
      setCreateOpen: vi.fn(), setOverviewPane: vi.fn(), refresh: vi.fn(async () => {}), nodes: [note], canvases: [], activeCanvasId: null as string | null,
      selectedNode: note, selectCanvas: vi.fn(), capabilities: capabilitiesFor(true, [], false) }, usePaletteState()));
    act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">"); });
    const item = result.current.paletteItems.find((x) => x.id === "a-writing-mode")!;
    expect(document.body.classList.contains("onden-zen")).toBe(false);
    await act(async () => { await result.current.runPaletteItem(item); });
    expect(document.body.classList.contains("onden-zen")).toBe(true);
    // Running it again while already writing does not leave writing mode.
    act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">"); });
    await act(async () => { await result.current.runPaletteItem(result.current.paletteItems.find((x) => x.id === "a-writing-mode")!); });
    expect(document.body.classList.contains("onden-zen")).toBe(true);
  });
});
