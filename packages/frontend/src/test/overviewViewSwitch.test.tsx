// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import OverviewEditor from "../components/OverviewEditor";
import type { NoteDisplayRow } from "../components/NoteActions";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { apiFetch, type ContentNode } from "../lib/api";
import { getSplit, onSplitDrop, setRight } from "../lib/splitViewStore";

// A wide screen shows the note one of three ways, picked from the icons beside ⋯
// (編輯｜並排｜預覽, ui/Segmented; 並排 is the workspace's side by side with this note on the right); ⋯ › 顯示… keeps full width and writing mode. Ctrl+E
// still flips edit ⇄ preview, and a click on the preview's blank space or a double-click
// on text returns to editing (never a link, a task box or an embed).

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn() }));

const note: ContentNode = { id: "n1", title: "Note", slug: "note", markdown: "", node_type: "content", source_type: "manual" };
const BODY = "first paragraph\n\n[site](https://example.com)\n\n- [ ] a task\n";

function respondWith(attrs: Array<{ key: string; value: string }>) {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    new Response(JSON.stringify(String(path).startsWith(`/api/nodes/${note.id}/attributes?`) ? attrs : []), { status: 200 }));
}

function Shortcuts({ setView }: { setView: import("react").Dispatch<import("react").SetStateAction<"edit" | "preview">> }) {
  const noop = () => {};
  useKeyboardShortcuts({
    mode: "notes", notesView: "editor", selectedId: note.id, setSelectedId: noop,
    createOpen: false, setCreateOpen: noop, createNote: noop, canvasSearch: "", setCanvasSearch: noop,
    onOpenOverviewSearch: noop, setPaletteOpen: noop, setPaletteQuery: noop, setPaletteIndex: noop,
    saveOverviewDraft: noop, setOverviewView: setView, openDailyNote: noop,
    setFocusMode: noop,
  });
  return null;
}

function Harness({ initial = "edit", noteActions }: { initial?: "edit" | "preview"; noteActions?: (n: { previewAvailable: boolean; displayRows: readonly NoteDisplayRow[]}) => ReactNode }) {
  const [view, setView] = useState<"edit" | "preview">(initial);
  const n = note;
  return <>
    <Shortcuts setView={setView} />
    <output data-testid="view">{view}</output>
    <OverviewEditor node={n} titleDraft="Note" onTitleChange={() => {}} draft={BODY} onDraftChange={() => {}}
      view={view} setView={setView} saveStatus="saved" onSave={() => {}} online nodes={[n]}
      onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} noteActions={noteActions} />
  </>;
}
const current = () => screen.getByTestId("view").textContent;

afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

describe("edit ⇄ preview without the pill", () => {
  it("edit, side by side and preview are three icons, the current one checked", { timeout: 20_000 }, async () => {
    respondWith([]);
    const { container } = render(<Harness />);
    expect(container.querySelector(".editor-view-toggle")).toBeNull();
    const modes = screen.getByRole("radiogroup", { name: "Display" });
    const button = (name: string) => within(modes).getByRole("radio", { name });
    expect(button("Edit").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(button("Preview"));
    expect(current()).toBe("preview");
    expect(button("Preview").getAttribute("aria-checked")).toBe("true");
    // 並排 opens this note's text on the right through the workspace's side by side.
    const off = onSplitDrop((target, side) => { if (side === "right") setRight(target); });
    fireEvent.click(button("Side by side"));
    expect(current()).toBe("edit");
    expect(getSplit().right).toEqual({ kind: "note", id: note.id, tab: "content" });
    expect(button("Side by side").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(button("Edit"));
    expect(getSplit().right).toBeNull();
    off();
  });

  it("⋯ › 顯示… keeps full width and writing mode; the three ways to show the text are not in it", { timeout: 20_000 }, () => {
    respondWith([]);
    render(<Harness noteActions={({ displayRows }) => <output data-testid="rows">{displayRows.map((row) => row.id).join(",")}</output>} />);
    expect(screen.getByTestId("rows").textContent).toBe("wide,zen");
  });

  it("Ctrl+E still toggles", { timeout: 20_000 }, () => {
    respondWith([]);
    render(<Harness />);
    fireEvent.keyDown(window, { key: "e", ctrlKey: true });
    expect(current()).toBe("preview");
    fireEvent.keyDown(window, { key: "e", ctrlKey: true });
    expect(current()).toBe("edit");
  });

  it("a click on blank preview space returns to editing; a link or task box does not", { timeout: 20_000 }, async () => {
    respondWith([]);
    const { container } = render(<Harness initial="preview" />);
    const article = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("article.obsidian-preview");
      expect(el).not.toBeNull();
      return el!;
    }, { timeout: 10_000 });
    fireEvent.click(await screen.findByRole("link", { name: "site" }));
    fireEvent.click(article.querySelector("input[type=checkbox], [role=checkbox]") ?? article.querySelector("li")!);
    fireEvent.doubleClick(screen.getByRole("link", { name: "site" }));
    expect(current()).toBe("preview");
    fireEvent.click(article);
    expect(current()).toBe("edit");
  });

  it("a double-click on a paragraph returns to editing with the caret near it", { timeout: 20_000 }, async () => {
    respondWith([]);
    const { container } = render(<Harness initial="preview" />);
    const p = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("article.obsidian-preview p");
      expect(el).not.toBeNull();
      return el!;
    }, { timeout: 10_000 });
    (document as unknown as { caretRangeFromPoint: unknown }).caretRangeFromPoint = () => ({ startContainer: p.firstChild, startOffset: 6 });
    fireEvent.doubleClick(p);
    expect(current()).toBe("edit");
    await waitFor(() => {
      const sel = container.querySelector<HTMLElement>(".cm-content")!;
      expect(sel).not.toBeNull();
      expect(sel.closest(".cm-editor")?.classList.contains("cm-focused")).toBe(true);
    }, { timeout: 10_000 });
    delete (document as unknown as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
  });

  it.each([
    ["PDF", [{ key: "pdf_url", value: "https://example.com/a.pdf" }]],
    ["handwriting", [{ key: "ink_data", value: JSON.stringify({ version: 1, strokes: [{ id: "s1", points: [[0, 0]], color: "#000", size: 2, toolId: "pen" }], erased: {}, page: { width: 1000 } }) }]],
  ])("a %s note offers no preview, wide or in the phone menu", { timeout: 20_000 }, async (_name, attrs) => {
    respondWith(attrs);
    let offered: boolean | null = null;
    let rows = "";
    render(<Harness noteActions={({ previewAvailable, displayRows }) => { offered = previewAvailable; rows = displayRows.map((row) => row.id).join(","); return null; }} />);
    await waitFor(() => expect(offered).toBe(false), { timeout: 10_000 });
    expect(screen.queryByRole("group", { name: "Display" })).toBeNull();
    // Only writing mode is left to show it: the surface already fills the page, and has no text to preview.
    expect(rows).toBe("zen");
  });
});
