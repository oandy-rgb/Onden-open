import { legacyFingerprint } from "@onden/markdown/ink";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PdfNodeView from "../components/PdfNodeView";
import type { InkMultiPageDoc } from "../lib/pdf/pdfAdapter";

// The PDF host saves its whole envelope once per edit (W20): strokes and the
// highlight records together. (Drawing commits: pdfDrawSession addCaptures;
// the editor's single ink_data save: overviewEditorPdfInk.)
vi.mock("../lib/pdf/pdfjs", async () => (await import("./helpers/fakePdf")).fakePdfjsModule());
const confirmDialog = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../components/ConfirmDialog", () => ({ confirmDialog }));
afterEach(() => { cleanup(); confirmDialog.mockReset(); confirmDialog.mockImplementation(async () => true); });

/** Clear lives in the "⋯" menu now, behind a confirmation. */
const clearAll = () => {
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Clear all annotations" }));
};

const page = { version: 1 as const, strokes: [{ id: "d1", points: [[0, 0]] as [number, number][], color: "#000", size: 2, toolId: "pen" as const }], erased: {}, page: { width: 1000 } };
const loaded: InkMultiPageDoc = { version: 1, pages: { 1: page }, annotations: [{ id: "d1" } as never, { id: "text" } as never] };

describe("PDF host saves", () => {
  it("Clear all is one save of an empty envelope — strokes and records at once — after a confirmation", async () => {
    const onChange = vi.fn();
    render(<PdfNodeView pdfUrl="https://example.com/a.pdf" initialDoc={loaded} onChange={onChange} />);
    clearAll();
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith({ version: 1, pages: {}, annotations: [], units: { version: 1, pages: {} }, unitsFrom: legacyFingerprint({}) });
  });

  it("declining the confirmation clears nothing", async () => {
    confirmDialog.mockImplementation(async () => false);
    const onChange = vi.fn();
    render(<PdfNodeView pdfUrl="https://example.com/a.pdf" initialDoc={loaded} onChange={onChange} />);
    clearAll();
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opening the view saves nothing", () => {
    const onChange = vi.fn();
    const { unmount } = render(<PdfNodeView pdfUrl="https://example.com/a.pdf" initialDoc={loaded} onChange={onChange} />);
    unmount();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("PDF host on a drawing made with a newer version (T1-0)", () => {
  const gated: InkMultiPageDoc = { ...loaded, features: ["clips"], requires: ["clips"] };

  it("offers no Clear, and nothing is saved", () => {
    const onChange = vi.fn();
    render(<PdfNodeView pdfUrl="https://example.com/a.pdf" initialDoc={gated} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "Clear all annotations" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toMatch(/newer version/);
  });

  it("an envelope whose page requires an unknown feature is read-only too", () => {
    render(<PdfNodeView pdfUrl="https://example.com/a.pdf" initialDoc={{ ...loaded, pages: { 1: { ...page, requires: ["x"] } as never } }} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "Clear all annotations" })).toBeNull();
  });
});
