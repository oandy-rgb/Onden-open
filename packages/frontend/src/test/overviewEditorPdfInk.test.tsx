import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import OverviewEditor from "../components/OverviewEditor";
import { apiFetch, type ContentNode } from "../lib/api";
import { saveInk } from "../lib/data/inkWriter";
import type { InkMultiPageDoc } from "../lib/pdf/pdfAdapter";
import { readPdfInk } from "../lib/pdf/pageUnits";
import { noteDoc, notePages, type InkDocument, type InkPages } from "@onden/markdown/ink";

// A PDF's drawing state is one ink_data envelope: per-page strokes and every
// highlight record together (W20). One edit is one save — never a second
// write to pdf_annotations whose undo or refusal could orphan the other half.
// PDFs saved before keep their records in pdf_annotations; those are read and
// folded in, never written again. Handwriting notes keep a single page.

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn() }));
vi.mock("../lib/data/inkWriter", async (original) => ({ ...await original<typeof import("../lib/data/inkWriter")>(), saveInk: vi.fn() }));
const seen = vi.hoisted(() => ({ pdf: null as InkMultiPageDoc | null, page: undefined as unknown }));
const RECORD = { id: "h1", position: {}, content: {} };
vi.mock("../components/PdfNodeView", () => ({
  default: ({ initialDoc, onChange }: { initialDoc: InkMultiPageDoc; onChange: (doc: InkMultiPageDoc, options?: { keepalive?: boolean }) => void }) => {
    seen.pdf = initialDoc;
    const next = { ...initialDoc, annotations: [...(initialDoc.annotations ?? []), RECORD as never] };
    return (
      <>
        <button onClick={() => onChange(next)}>Highlight</button>
        <button onClick={() => onChange(next, { keepalive: true })}>Highlight on exit</button>
      </>
    );
  },
}));
vi.mock("../components/InkNodeView", () => ({
  default: ({ initialPages, onPagesChange }: { initialPages: InkPages; onPagesChange: (pages: InkPages, options?: { keepalive?: boolean }) => void }) => {
    seen.page = initialPages;
    return <button onClick={() => onPagesChange(notePages({ ...(noteDoc(initialPages) as InkDocument), erased: { s1: [[0, 0]] } }), { keepalive: true })}>handwriting</button>;
  },
}));

const node: ContentNode = { id: "n1", title: "Paper", slug: "paper", markdown: "", node_type: "content", source_type: "manual" };
const page = { version: 1, strokes: [{ id: "s1", points: [[0, 0]], color: "#000", size: 2, toolId: "pen" }], erased: {}, page: { width: 1000 } };

function editor(attrs: Array<{ key: string; value: string }>) {
  vi.mocked(apiFetch).mockImplementation(async (path) => new Response(JSON.stringify(String(path).startsWith(`/api/nodes/${node.id}/attributes?`) ? attrs : []), { status: 200 }));
  return render(<OverviewEditor node={node} titleDraft="Paper" onTitleChange={() => {}} draft="" onDraftChange={() => {}}
    view="edit" setView={() => {}} saveStatus="saved" onSave={() => {}} online nodes={[node]}
    onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} />);
}

afterEach(() => { vi.mocked(saveInk).mockReset(); seen.pdf = null; seen.page = undefined; });

describe("PDF drawing state", () => {
  it("one edit is one ink_data save carrying strokes and records, at once", { timeout: 20_000 }, async () => {
    editor([{ key: "pdf_url", value: "https://example.com/a.pdf" }, { key: "ink_data", value: JSON.stringify({ version: 1, pages: { 1: page }, annotations: [] }) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Highlight" }, { timeout: 10_000 }));
    expect(saveInk).toHaveBeenCalledTimes(1);
    const [nodeId, doc] = vi.mocked(saveInk).mock.calls[0]!;
    expect(nodeId).toBe("n1");
    expect(doc).toMatchObject({ version: 1, pages: { 1: { strokes: [{ id: "s1" }] } }, annotations: [{ id: "h1" }] });
  });

  it("each save carries the envelope it was made from (D88: the server merges)", { timeout: 20_000 }, async () => {
    vi.mocked(saveInk).mockResolvedValue(true);
    const loaded = { version: 1, pages: { 1: page }, annotations: [] };
    editor([{ key: "pdf_url", value: "https://example.com/a.pdf" }, { key: "ink_data", value: JSON.stringify(loaded) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Highlight" }, { timeout: 10_000 }));
    await waitFor(() => expect(saveInk).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0)); // the server has accepted the first save: it is now the base
    fireEvent.click(screen.getByRole("button", { name: "Highlight" }));
    expect(saveInk).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(saveInk).mock.calls;
    expect(first![2]).toEqual(readPdfInk(JSON.stringify(loaded), null)); // as loaded, with its pages in page units
    expect(second![2]).toBe(first![1]);
  });

  it("a save made as the page goes away asks to outlive it (keepalive); an ordinary one does not", { timeout: 20_000 }, async () => {
    editor([{ key: "pdf_url", value: "https://example.com/a.pdf" }, { key: "ink_data", value: JSON.stringify({ version: 1, pages: { 1: page }, annotations: [] }) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Highlight" }, { timeout: 10_000 }));
    fireEvent.click(screen.getByRole("button", { name: "Highlight on exit" }));
    const [ordinary, onExit] = vi.mocked(saveInk).mock.calls;
    expect(ordinary![3]).toBeUndefined();
    expect(onExit![3]).toEqual({ keepalive: true });
  });

  it("folds a PDF's legacy pdf_annotations into the envelope", { timeout: 20_000 }, async () => {
    editor([
      { key: "pdf_url", value: "https://example.com/a.pdf" },
      { key: "pdf_annotations", value: JSON.stringify([{ id: "old-highlight" }]) },
      { key: "ink_data", value: JSON.stringify({ version: 1, pages: { 1: page } }) },
    ]);
    await screen.findByRole("button", { name: "Highlight" }, { timeout: 10_000 });
    expect(seen.pdf?.annotations).toEqual([{ id: "old-highlight" }]);
    expect(seen.pdf?.pages[1]?.strokes).toHaveLength(1);
    expect(seen.pdf?.units?.pages["pdf:1"]?.doc.strokes).toHaveLength(1); // read as page units
  });

  it("an envelope that already carries records ignores the stale legacy attribute", { timeout: 20_000 }, async () => {
    editor([
      { key: "pdf_url", value: "https://example.com/a.pdf" },
      { key: "pdf_annotations", value: JSON.stringify([{ id: "stale" }]) },
      { key: "ink_data", value: JSON.stringify({ version: 1, pages: {}, annotations: [{ id: "current" }] }) },
    ]);
    await screen.findByRole("button", { name: "Highlight" }, { timeout: 10_000 });
    expect(seen.pdf?.annotations).toEqual([{ id: "current" }]);
  });
});

describe("handwriting page", () => {
  it("opens a single-page ink_data as handwriting", { timeout: 20_000 }, async () => {
    editor([{ key: "ink_data", value: JSON.stringify(page) }]);
    await screen.findByText("handwriting", undefined, { timeout: 10_000 });
    // the note's one page, as pages: key `page`, a blank background
    expect(seen.page).toMatchObject({ pages: { page: { key: "page", background: { kind: "blank" }, doc: { strokes: [{ id: "s1" }] } } } });
  });

  it("saves the note's one page as its ink_data, as it always was: a single drawing (not an envelope)", { timeout: 20_000 }, async () => {
    editor([{ key: "ink_data", value: JSON.stringify(page) }]);
    fireEvent.click(await screen.findByText("handwriting", undefined, { timeout: 10_000 }));
    const [nodeId, doc, base, options] = vi.mocked(saveInk).mock.calls[0]!;
    expect(nodeId).toBe("n1");
    expect(doc).toMatchObject({ version: 1, strokes: [{ id: "s1" }], erased: { s1: [[0, 0]] }, page: { width: 1000 } });
    expect(doc).not.toHaveProperty("pages");
    expect(base).toMatchObject({ strokes: [{ id: "s1" }] });
    expect(options).toEqual({ keepalive: true });
  });

  // The whiteboard's pen layer is the note's board_ink. Drawing on the board must not turn the
  // content tab into a handwriting page, and a handwriting page's strokes are not the board's.
  it("a note with only board strokes stays a text note: the content tab is the text editor, not handwriting", { timeout: 20_000 }, async () => {
    const { container } = editor([{ key: "board_ink", value: JSON.stringify(page) }]);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".cm-editor, .markdown-body, [data-note-surface]")).not.toBeNull(), { timeout: 10_000 });
    expect(screen.queryByText("handwriting")).toBeNull();
    expect(seen.page).toBeUndefined();
  });

  it("asks the server for the note's content attributes only: board_ink is not among them", { timeout: 20_000 }, async () => {
    editor([{ key: "ink_data", value: JSON.stringify(page) }]);
    await screen.findByText("handwriting", undefined, { timeout: 10_000 });
    const asked = vi.mocked(apiFetch).mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/attributes?keys="));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.some((u) => u.includes("board_ink"))).toBe(false);
  });

  it("never opens a PDF envelope as handwriting (a save would overwrite it)", { timeout: 20_000 }, async () => {
    editor([{ key: "ink_data", value: JSON.stringify({ version: 1, pages: { 1: page } }) }]);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("handwriting")).toBeNull();
  });
});
