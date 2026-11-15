// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useLayoutEffect, useRef } from "react";
import { act, render, screen } from "@testing-library/react";
import OverviewEditor from "../components/OverviewEditor";
import { apiFetch, type ContentNode } from "../lib/api";
import { saveInk } from "../lib/data/inkWriter";

// Scan finding #3: the editor is not remounted per note. On the first render
// after switching from a PDF to another note, the PDF view stayed mounted with
// the NEW note's save callback, and its unmount flush (strokes drawn in the
// last second) was saved into the new note. The mock commits on unmount the
// way PdfNodeView does: through a ref an effect keeps pointed at the latest
// callback.

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn() }));
vi.mock("../lib/data/inkWriter", async (original) => ({
  ...await original<typeof import("../lib/data/inkWriter")>(), saveInk: vi.fn(),
}));
const LAST_STROKES = { pages: { 1: { version: 1, strokes: [{ id: "s" }], erased: {}, page: { width: 1 } } } };
function MockPdfView({ onChange }: { onChange: (doc: unknown) => void }) {
  const onInkRef = useRef(onChange);
  useEffect(() => { onInkRef.current = onChange; }, [onChange]);
  useLayoutEffect(() => () => onInkRef.current(LAST_STROKES), []);
  return <div>pdf view</div>;
}
vi.mock("../components/PdfNodeView", () => ({ default: MockPdfView }));

const pdf: ContentNode = { id: "pdf-a", title: "Paper", slug: "paper", markdown: "", node_type: "content", source_type: "manual" };
const other: ContentNode = { id: "note-b", title: "Other", slug: "other", markdown: "text", node_type: "content", source_type: "manual" };

function editorFor(node: ContentNode) {
  return <OverviewEditor node={node} titleDraft={node.title} onTitleChange={() => {}} draft={node.markdown ?? ""} onDraftChange={() => {}}
    view="edit" setView={() => {}} saveStatus="saved" onSave={() => {}} online nodes={[pdf, other]}
    onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} />;
}

afterEach(() => { vi.mocked(saveInk).mockReset(); });

describe("switching notes away from a PDF", () => {
  it("saves the PDF's last strokes to the PDF, never to the next note", { timeout: 20_000 }, async () => {
    vi.mocked(apiFetch).mockImplementation(async (path) => new Response(JSON.stringify(
      String(path).startsWith(`/api/nodes/${pdf.id}/attributes?`) ? [{ key: "pdf_url", value: "https://example.com/a.pdf" }] : []), { status: 200 }));
    const { rerender, unmount } = render(editorFor(pdf));
    await screen.findByText("pdf view", undefined, { timeout: 10_000 });

    await act(async () => { rerender(editorFor(other)); });
    expect(screen.queryByText("pdf view")).toBeNull();
    unmount();

    expect(vi.mocked(saveInk).mock.calls.map(([nodeId]) => nodeId)).toEqual([pdf.id]);
  });
});

// 「在裡面新增」 asks the editor to take the new note's title
// (lib/cardTitleFocus): once, for that note only.
describe("title focus for a note just made", () => {
  it("focuses and selects the title when the requested note is shown, then never again", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response("[]", { status: 200 }));
    const { requestNoteTitleFocus } = await import("../lib/cardTitleFocus");
    const { rerender, unmount } = render(editorFor(pdf));
    const title = () => screen.getByRole("textbox", { name: "Note title" });
    expect(document.activeElement).not.toBe(title());
    requestNoteTitleFocus(other.id);
    await act(async () => { rerender(editorFor(other)); });
    expect(document.activeElement).toBe(title());
    title().blur();
    await act(async () => { rerender(editorFor(pdf)); });
    await act(async () => { rerender(editorFor(other)); });
    expect(document.activeElement).not.toBe(title());
    // Already showing it: the request is taken at once.
    await act(async () => { requestNoteTitleFocus(other.id); });
    expect(document.activeElement).toBe(title());
    unmount();
  });
});
