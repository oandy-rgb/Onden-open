// The text tool on both page surfaces — a PDF page and a handwriting page —
// is the same layer and the same toolbar entry: tap adds a box, typing is saved
// after a pause, leaving the page (pagehide) saves what is pending, Undo (button
// and Ctrl+Z) undoes boxes, other tools leave them alone, and a note's
// text boxes never touch its drawing save.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubPagesNearScreen } from "./helpers/nearScreen";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { decodePageText } from "@onden/markdown/page-text";
import InkNodeView from "../components/InkNodeView";
import PdfNodeView from "../components/PdfNodeView";
import { SAVE_PAUSE_MS } from "../lib/pageText";
import { fakePdf, settlePdf } from "./helpers/fakePdf";

const savePageText = vi.hoisted(() => vi.fn<(nodeId: string, value: string, base: string | null) => void>());
vi.mock("../lib/data/pageTextWriter", () => ({ savePageText }));

vi.mock("../lib/pdf/pdfjs", async () => (await import("./helpers/fakePdf")).fakePdfjsModule());

const pick = (tool: string) => fireEvent.click(document.querySelector(`[data-ink-tool="${tool}"]`)!);
const tap = (el: Element, x = 120, y = 140) => {
  fireEvent.pointerDown(el, { clientX: x, clientY: y, pointerId: 1, pointerType: "touch", button: 0 });
  fireEvent.pointerUp(el, { clientX: x, clientY: y, pointerId: 1, pointerType: "touch", button: 0 });
};
const saved = (call = savePageText.mock.calls.length - 1) => decodePageText(savePageText.mock.calls[call]![1]);

beforeEach(() => {
  vi.useFakeTimers();
  stubPagesNearScreen();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  savePageText.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("handwriting page", () => {
  const renderInk = (props: Partial<React.ComponentProps<typeof InkNodeView>> = {}) =>
    render(<InkNodeView pageText={{ nodeId: "note-1", initial: null }} {...props} />);

  it("the Text tool: tap the page, type, and it is saved after a pause under the page's key", () => {
    const { container } = renderInk();
    pick("text");
    const stage = container.querySelector(".page-ink-surface") as HTMLElement;
    expect(container.querySelector(".ink-note")!.className).toContain("ink-note--text");
    act(() => tap(stage));
    const area = screen.getByRole("textbox");
    act(() => { fireEvent.change(area, { target: { value: "標題 one" } }); });
    expect(savePageText).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(SAVE_PAUSE_MS); });
    expect(savePageText).toHaveBeenCalledTimes(1);
    expect(savePageText.mock.calls[0]![0]).toBe("note-1");
    expect(savePageText.mock.calls[0]![2]).toBeNull();
    expect(saved().pages["page"]!.boxes[0]).toMatchObject({ text: "標題 one", size: 22, w: 320 });
  });

  it("leaving the page saves what is pending at once", () => {
    const { container } = renderInk();
    pick("text");
    act(() => tap(container.querySelector(".page-ink-surface")!));
    act(() => { fireEvent.change(screen.getByRole("textbox"), { target: { value: "unsaved" } }); });
    expect(savePageText).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(savePageText).toHaveBeenCalledTimes(1);
    expect(saved().pages["page"]!.boxes[0]!.text).toBe("unsaved");
  });

  it("unmounting saves too, and a box left empty saves nothing", () => {
    const { container, unmount } = renderInk();
    pick("text");
    act(() => tap(container.querySelector(".page-ink-surface")!));
    act(() => { fireEvent.change(screen.getByRole("textbox"), { target: { value: "bye" } }); });
    unmount();
    expect(savePageText).toHaveBeenCalledTimes(1);
    savePageText.mockReset();
    const second = renderInk();
    pick("text");
    act(() => tap(second.container.querySelector(".page-ink-surface")!));
    second.unmount();
    expect(savePageText).not.toHaveBeenCalled();
  });

  it("Undo undoes the box in the Text tool, and the drawing in the pen tool", () => {
    const { container } = renderInk();
    pick("text");
    act(() => tap(container.querySelector(".page-ink-surface")!));
    act(() => { fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } }); });
    act(() => { fireEvent.blur(screen.getByRole("textbox")); });
    const undo = screen.getAllByRole("button").find((b) => b.getAttribute("title")?.startsWith("Undo"))!;
    expect((undo as HTMLButtonElement).disabled).toBe(false);
    act(() => { fireEvent.click(undo); });
    act(() => { fireEvent.click(undo); });
    expect(document.querySelector("[data-page-text-box]")).toBeNull();
    expect(saved().pages["page"]).toBeUndefined();
    pick("pen");
    expect((undo as HTMLButtonElement).disabled).toBe(true); // nothing drawn: the pen has nothing to undo
  });

  it("in the pen tool the boxes are shown and taking no taps", () => {
    const { container } = renderInk({ pageText: { nodeId: "note-1", initial: JSON.stringify({ v: 1, pages: { page: { boxes: [{ id: "a", x: 5, y: 5, w: 200, text: "kept", size: 22, color: "#15130d", align: "left", updated_at: "" }] } } }) } });
    expect(screen.getByText("kept")).toBeTruthy();
    act(() => tap(container.querySelector(".page-ink-surface")!));
    expect(document.querySelectorAll("[data-page-text-box]")).toHaveLength(1);
    expect(savePageText).not.toHaveBeenCalled();
  });

  it("a drawing that needs a newer version shows no Text tool", () => {
    renderInk({ readOnly: true });
    expect(document.querySelector('[data-ink-tool="text"]')).toBeNull();
  });
});

describe("PDF", () => {
  beforeEach(() => {
    fakePdf.reset();
    fakePdf.pages = [{ width: 600, height: 800 }, { width: 600, height: 800 }];
  });
  const renderPdf = async (props: Partial<React.ComponentProps<typeof PdfNodeView>> = {}) => {
    render(<PdfNodeView pdfUrl="https://example.com/a.pdf" pageText={{ nodeId: "pdf-1", initial: null }} {...props} />);
    await settlePdf();
  };
  const sheetOf = (n: number) => document.querySelector(`[data-page-key="pdf:${n}"]`)!;

  it("the Text tool on page 2 saves under pdf:2, in 1000-unit page coordinates", async () => {
    await renderPdf();
    pick("text");
    const capture = sheetOf(2).querySelector("[data-page-text-capture]")!;
    act(() => tap(capture, 60, 80));
    act(() => { fireEvent.change(screen.getByRole("textbox"), { target: { value: "p2" } }); });
    act(() => { vi.advanceTimersByTime(SAVE_PAUSE_MS); });
    expect(savePageText).toHaveBeenCalledTimes(1);
    const boxes = saved().pages["pdf:2"]!.boxes;
    expect(boxes[0]).toMatchObject({ text: "p2", x: 60, w: 320 });
    expect(saved().pages["pdf:1"]).toBeUndefined();
  });

  it("page 1 and page 2 each have their own boxes", async () => {
    const initial = JSON.stringify({ v: 1, pages: {
      "pdf:1": { boxes: [{ id: "a", x: 5, y: 5, w: 200, text: "on one", size: 22, color: "#15130d", align: "left", updated_at: "" }] },
      "pdf:2": { boxes: [{ id: "b", x: 5, y: 5, w: 200, text: "on two", size: 22, color: "#15130d", align: "left", updated_at: "" }] },
    } });
    await renderPdf({ pageText: { nodeId: "pdf-1", initial } });
    expect(sheetOf(1).textContent).toContain("on one");
    expect(sheetOf(1).textContent).not.toContain("on two");
    expect(sheetOf(2).textContent).toContain("on two");
  });

  it("Ctrl+Z in the Text tool undoes the box", async () => {
    await renderPdf();
    pick("text");
    act(() => tap(sheetOf(1).querySelector("[data-page-text-capture]")!));
    act(() => { fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } }); });
    act(() => { fireEvent.blur(screen.getByRole("textbox")); });
    expect(document.querySelectorAll("[data-page-text-box]")).toHaveLength(1);
    act(() => { fireEvent.keyDown(document, { key: "z", ctrlKey: true }); });
    act(() => { fireEvent.keyDown(document, { key: "z", ctrlKey: true }); });
    expect(document.querySelectorAll("[data-page-text-box]")).toHaveLength(0);
  });

  it("a PDF made with a newer version has no Text tool", async () => {
    await renderPdf({ readOnly: true });
    expect(document.querySelector('[data-ink-tool="text"]')).toBeNull();
  });
});
