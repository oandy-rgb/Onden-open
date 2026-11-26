// @vitest-environment jsdom
// The PDF has ONE toolbar (the handwriting note's InkToolbar) and no drawing
// mode: Select (default), the ink tools, the shapes. Tools / colour / size reach
// what is stored; the eraser reaches earlier drawings; plus undo, stylus mode,
// the S Pen button, and the "⋯" menu (zoom, clear all after a confirmation).
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PdfNodeView from "../components/PdfNodeView";
import { emitPenShortcut } from "../lib/penShortcutBridge";
import { drawingRecord, shapeRecord } from "../lib/pdf/capture";
import { addDrawingToPage, addShapeToPage, emptyMultiPageDoc, type InkMultiPageDoc } from "../lib/pdf/pdfAdapter";
import { pdfPageDoc } from "../lib/pdf/pageUnits";
import { legacyFingerprint } from "@onden/markdown/ink";
import { fakePdf, settlePdf } from "./helpers/fakePdf";

/** The book's scrolling element (touch events and scroll positions are the book's), set by renderView. */
let scroller: HTMLElement;
const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
/** The 600 × 800 page's sheet (its client rect is what a selection is measured against). */
const sheet = () => document.querySelector('[data-page-key="pdf:1"]') as HTMLElement;
const confirmDialog = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../components/ConfirmDialog", () => ({ confirmDialog }));
vi.mock("../lib/pdf/pdfjs", async () => (await import("./helpers/fakePdf")).fakePdfjsModule());

const URL_ = "https://example.com/a.pdf";

function pointer(type: string, o: { id: number; kind: "pen" | "touch" | "mouse"; x: number; y: number; t: number; pressure?: number }): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerId: o.id, pointerType: o.kind, button: 0, clientX: o.x, clientY: o.y, pressure: o.pressure ?? 0.5, getCoalescedEvents: () => [] });
  Object.defineProperty(e, "timeStamp", { value: o.t });
  return e;
}
let clock = 0;
function drag(kind: "pen" | "touch" | "mouse", pts: Array<[number, number]>, pressure?: number) {
  const surface = document.querySelector(".page-ink-surface") as HTMLElement;
  Object.assign(surface, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
  clock += 2000;
  act(() => {
    surface.dispatchEvent(pointer("pointerdown", { id: 1, kind, x: pts[0][0], y: pts[0][1], t: clock, pressure }));
    pts.slice(1).forEach(([x, y], i) => surface.dispatchEvent(pointer("pointermove", { id: 1, kind, x, y, t: clock + 20 * (i + 1), pressure })));
    const [lx, ly] = pts[pts.length - 1];
    surface.dispatchEvent(pointer("pointerup", { id: 1, kind, x: lx, y: ly, t: clock + 20 * pts.length, pressure }));
  });
}

const stored = (): InkMultiPageDoc => {
  const record = drawingRecord("d1", 1, [{ points: [{ x: 100, y: 100 }, { x: 150, y: 100 }, { x: 200, y: 100 }], color: "#7a2e33", width: 2.5 }], { width: 600, height: 800 })!;
  return addDrawingToPage({ ...emptyMultiPageDoc(), annotations: [record] }, 1, "d1", record.content!.strokes!);
};

/** Mount the view and let the PDF open: the page book lays the pages out (the view is 624 px wide, so a
 *  600 × 800 page is 600 × 800 px at zoom 1). */
async function renderView(props: Partial<React.ComponentProps<typeof PdfNodeView>> = {}) {
  const onChange = vi.fn();
  render(<PdfNodeView pdfUrl={URL_} onChange={onChange} {...props} />);
  await settlePdf();
  scroller = document.querySelector(".pagebook-scroll") as HTMLElement;
  sheet().getBoundingClientRect = () => box(0, 0, 600, 800) as DOMRect;
  return onChange;
}
/** jsdom has no maxTouchPoints: define it for this test, removed in afterEach. */
const touchDevice = () => Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
/** Pick a tool on the one toolbar (ink tools carry data-ink-tool; Select and the shapes data-pdf-tool). */
const pick = (tool: string) => fireEvent.click(document.querySelector(`[data-ink-tool="${tool}"], [data-pdf-tool="${tool}"]`)!);
/** The shape button: choose the tool, then a shape from its list. */
const pickShape = (kind: string) => {
  const button = document.querySelector('[data-ink-tool="shape"]') as HTMLElement;
  if (button.getAttribute("aria-pressed") !== "true" || button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
  fireEvent.click(document.querySelector(`[data-ink-shape="${kind}"]`)!);
};
const toolIds = () => [...document.querySelectorAll('[role="group"][aria-label="Tool"] > button')].map((b) => b.getAttribute("data-ink-tool") ?? b.getAttribute("data-pdf-tool"));
const pressedTool = () => document.querySelector('[role="group"][aria-label="Tool"] [aria-pressed="true"]');
const undoButton = () => screen.getByTitle(/^Undo/) as HTMLButtonElement;
const openMore = () => fireEvent.click(screen.getByRole("button", { name: "More" }));
/** The ⋯ menu's 「Finger draws too」 switch (the device's finger setting): turn it off = fingers only scroll. */
function fingersOnlyScroll() {
  openMore();
  const item = screen.getByRole("menuitemradio", { name: "Finger draws too" });
  if (item.getAttribute("aria-checked") === "true") fireEvent.click(item);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
}
const surface = () => document.querySelector(".page-ink-surface") as HTMLElement;
/** A touch event on the PDF's scroller; touches are [id, x, y]. */
function touchEvent(type: string, touches: Array<[number, number, number]>): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { changedTouches: touches.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY })) });
  act(() => { scroller.dispatchEvent(e); });
  return e;
}
const lastSaved = (onChange: ReturnType<typeof vi.fn>): InkMultiPageDoc => onChange.mock.calls[onChange.mock.calls.length - 1][0];
const selectedTool = () => document.querySelector('[data-ink-tool][aria-pressed="true"]')?.getAttribute("data-ink-tool");

beforeEach(() => {
  fakePdf.reset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // jsdom has no layout: the book's view is 624 px wide (fit width 600).
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("pagebook-scroll") ? 624 : 0; });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "maxTouchPoints");
  confirmDialog.mockReset();
  confirmDialog.mockImplementation(async () => true);
  window.getSelection()?.removeAllRanges();
});

describe("the toolbar", () => {
  it("is ONE toolbar, always the same: no second row, no drawing mode", async () => {
    await renderView();
    expect(document.querySelector(".pdf-node-toolbar")).toBeNull();
    expect(document.querySelectorAll(".ink-note-toolbar")).toHaveLength(1);
    expect(screen.getAllByRole("group", { name: "Tool" })).toHaveLength(1);
    expect(toolIds()).toEqual(["select", "pen", "highlighter", "eraser", "shape", "hand", "text"]);
    expect(screen.queryByRole("button", { name: /Stop drawing/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^✏|Draw$/ })).toBeNull();
    expect(screen.queryByText(/annotation/)).toBeNull(); // no count
    expect(screen.queryByText(/Alt\+drag/)).toBeNull(); // no hint line: it is the Select tooltip
    pick("pen");
    expect(document.querySelectorAll(".ink-note-toolbar")).toHaveLength(1);
    expect(toolIds()).toHaveLength(7);
    pick("select");
    expect(document.querySelectorAll(".ink-note-toolbar")).toHaveLength(1);
  });

  it("starts on Select, whose tooltip carries the hint; the shape tool is one icon button", async () => {
    await renderView();
    expect(pressedTool()?.getAttribute("data-pdf-tool")).toBe("select");
    const select = document.querySelector('[data-pdf-tool="select"]')!;
    expect(select.getAttribute("title")).toMatch(/Alt\+drag selects an area/);
    expect(select.getAttribute("aria-label")).toBe(select.getAttribute("title"));
    expect(document.querySelector('[data-ink-tool="shape"]')!.textContent).toBe("");
    expect(document.querySelector(".page-ink-surface")).toBeNull();
  });

  it("read-only: just Select, Hand and ⋯ (zoom only) — no drawing tools, shapes, colour, size, history or Clear", async () => {
    await renderView({ readOnly: true });
    expect(toolIds()).toEqual(["select", "hand"]);
    expect(screen.queryByRole("group", { name: "Color" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Size" })).toBeNull();
    expect(screen.queryByRole("group", { name: "History" })).toBeNull();
    expect(document.querySelector('[data-ink-tool="pen"]')).toBeNull();
    openMore();
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Handwriting settings…", "Zoom in", "Zoom out", "Fit width"]);
    expect(document.querySelector(".page-ink-surface")).toBeNull();
  });

  it("the ⋯ menu always has 「Finger draws too」 and it is the device's finger setting (shared with the notes)", async () => {
    await renderView();
    openMore();
    const item = screen.getByRole("menuitemradio", { name: "Finger draws too" });
    expect(item.getAttribute("aria-checked")).toBe("true"); // a finger follows the toolbar until a choice or a pen says otherwise
    fireEvent.click(item);
    expect(screen.getByRole("menuitemradio", { name: "Finger draws too" }).getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("onden.ink.stylusOnly")).toBe("1");
  });
});

describe("what the tools write", () => {
  it("highlighter, colour and size reach the stored stroke; pen pressure is kept", async () => {
    const onChange = await renderView();
    pick("highlighter");
    fireEvent.click(screen.getByTitle("Blue"));
    fireEvent.click(screen.getByTitle("Broad"));
    drag("pen", [[50, 60], [90, 70], [130, 80]], 0.8);
    pick("select");
    expect(onChange).toHaveBeenCalledTimes(1);
    const saved = lastSaved(onChange);
    // The page is in page units: the 7 px pen at this 600 px page is 7 · 1000 / 600 units wide.
    const units = 7 * (1000 / 600);
    const [stroke] = pdfPageDoc(saved, 1)!.strokes;
    expect(stroke).toMatchObject({ toolId: "highlighter", color: "#315f8f" });
    expect(stroke!.size).toBeCloseTo(units, 9);
    expect(stroke!.points[0]![2]).toBe(0.8);
    // …and the older form, for an older app, says the same drawing
    expect(saved.annotations).toHaveLength(1);
    expect(saved.annotations![0].type).toBe("drawing");
    expect(saved.annotations![0].content!.strokes![0]).toMatchObject({ color: "#315f8f", toolId: "highlighter" });
    expect(saved.annotations![0].content!.strokes![0].width).toBeCloseTo(units, 9);
    expect(saved.annotations![0].content!.strokes![0].points[0].p).toBe(0.8);
    expect(saved.pages[1].strokes[0]).toMatchObject({ toolId: "highlighter", color: "#315f8f" });
  });

  it("changing colour mid-session keeps the strokes already drawn", async () => {
    const onChange = await renderView();
    pick("pen");
    drag("mouse", [[10, 10], [60, 40]]);
    fireEvent.click(screen.getByTitle("Red"));
    drag("mouse", [[100, 100], [160, 140]]);
    pick("select");
    const saved = lastSaved(onChange);
    expect(pdfPageDoc(saved, 1)!.strokes.map((s) => s.color)).toEqual(["#7a2e33", "#c43c3c"]);
    expect(saved.annotations!.flatMap((a) => a.content!.strokes!.map((s) => s.color))).toEqual(["#7a2e33", "#c43c3c"]);
  });

  it("the eraser removes an earlier drawing, and undo gives it back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const onChange = await renderView({ initialDoc: stored() });
      pick("eraser");
      drag("mouse", [[90, 100], [210, 100]]);
      act(() => { vi.advanceTimersByTime(1100); }); // settles → one save
      expect(onChange).toHaveBeenCalledTimes(1);
      // The stroke stays (strokes are immutable); every point of it is erased, in both forms.
      expect(Object.keys(pdfPageDoc(lastSaved(onChange), 1)!.erased)).toEqual(["d1"]);
      expect(Object.keys(lastSaved(onChange).pages[1].erased)).toEqual(["d1"]);

      fireEvent.click(screen.getByTitle(/^Undo/));
      act(() => { vi.advanceTimersByTime(1100); });
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(pdfPageDoc(lastSaved(onChange), 1)!.erased).toEqual({});
      expect(lastSaved(onChange).pages[1].erased).toEqual({});
      expect(lastSaved(onChange).annotations?.map((a) => a.id)).toEqual(["d1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drawings are shown by the engine while drawing, by the page overlay otherwise", async () => {
    await renderView({ initialDoc: stored() });
    expect(document.querySelectorAll(".page-ink-svg")).toHaveLength(1);
    pick("pen");
    expect(document.querySelectorAll(".page-ink-svg")).toHaveLength(0);
    pick("select");
    expect(document.querySelectorAll(".page-ink-svg")).toHaveLength(1);
  });

  it("only a page near the screen gets an engine; until then its drawings stay the SVG copy", async () => {
    const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.push(cb); }
      observe() {}
      disconnect() {}
    });
    await renderView({ initialDoc: stored() });
    pick("pen");
    // Not reported near yet: no canvases, the drawing still shows, touches pass through.
    expect(document.querySelectorAll(".page-ink-canvas")).toHaveLength(0);
    expect(document.querySelectorAll(".page-ink-svg")).toHaveLength(1);
    expect(document.querySelector(".page-ink-surface")).toHaveClass("is-idle");
    act(() => { for (const cb of observers) cb([{ isIntersecting: true }]); });
    expect(document.querySelectorAll(".page-ink-canvas")).toHaveLength(2);
    expect(document.querySelectorAll(".page-ink-svg")).toHaveLength(0);
    // Scrolled away again: canvases go, the SVG copy comes back.
    act(() => { for (const cb of observers) cb([{ isIntersecting: false }]); });
    expect(document.querySelectorAll(".page-ink-canvas")).toHaveLength(0);
    expect(document.querySelectorAll(".page-ink-svg")).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("Clear all while drawing empties the pages too — nothing comes back on leaving the tool", async () => {
    const onChange = await renderView({ initialDoc: stored() });
    pick("pen");
    openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear all annotations" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    pick("select");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastSaved(onChange)).toEqual({ version: 1, pages: {}, annotations: [], units: { version: 1, pages: {} }, unitsFrom: legacyFingerprint(emptyMultiPageDoc()) });
  });
});

describe("Select, and moving between tools", () => {
  it("Select is the text tool: a selection offers Mark, which saves a highlight", async () => {
    const onChange = await renderView();
    // The text layer is the page's own: a selection in it is measured against the page's sheet.
    const layer = document.querySelector('[data-pdf-page="1"] .pdf-text-layer') as HTMLElement;
    layer.textContent = "hello world";
    const range = document.createRange();
    range.selectNodeContents(layer.firstChild!);
    range.getClientRects = () => [box(10, 10, 80, 12)] as unknown as DOMRectList;
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent(scroller, new Event("pointerup", { bubbles: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastSaved(onChange).annotations![0]).toMatchObject({ type: "text", content: { text: "hello world" } });
    // …measured in the page's own 600 × 800 frame, as the old viewer measured it
    expect(lastSaved(onChange).annotations![0].position.boundingRect).toMatchObject({ x1: 10, y1: 10, x2: 90, y2: 22, width: 600, height: 800, pageNumber: 1 });
  });

  it("every ink tool, the shape tool included, mounts an engine; Select does not", async () => {
    await renderView();
    for (const tool of ["pen", "highlighter", "eraser", "shape", "hand"]) {
      pick(tool);
      expect(document.querySelectorAll(".page-ink-surface"), tool).toHaveLength(1);
    }
    pick("select");
    expect(document.querySelector(".page-ink-surface")).toBeNull();
  });

  it("going back to Select saves the strokes first, then takes the engine down", async () => {
    const stateAtSave: boolean[] = [];
    const onChange = vi.fn(() => stateAtSave.push(document.querySelector(".page-ink-surface") !== null));
    await renderView({ onChange });
    pick("pen");
    drag("mouse", [[10, 10], [60, 40]]);
    pick("select");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(stateAtSave).toEqual([true]); // the engine was still mounted when the save was made
    expect(document.querySelector(".page-ink-surface")).toBeNull();
    expect(pressedTool()?.getAttribute("data-pdf-tool")).toBe("select");
  });

  it("going from the pen to a shape keeps the strokes on the same page surface (one engine, one history)", async () => {
    const onChange = await renderView();
    pick("pen");
    drag("mouse", [[10, 10], [60, 40]]);
    const before = document.querySelector(".page-ink-surface");
    pickShape("diamond");
    expect(document.querySelector(".page-ink-surface")).toBe(before);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Esc returns to Select and keeps (saves) what was drawn", async () => {
    const onChange = await renderView();
    pick("pen");
    drag("mouse", [[10, 10], [60, 40]]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastSaved(onChange).annotations).toHaveLength(1);
    expect(pressedTool()?.getAttribute("data-pdf-tool")).toBe("select");
    expect(document.querySelector(".page-ink-surface")).toBeNull();
  });

  it("Esc inside the ⋯ menu closes the menu, not the tool", async () => {
    await renderView();
    pick("pen");
    openMore();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(pressedTool()?.getAttribute("data-ink-tool")).toBe("pen");
  });
});

describe("shapes are tools", () => {
  it("draw two in a row with the current colour and size; the tool stays", async () => {
    const onChange = await renderView();
    fireEvent.click(screen.getByTitle("Red"));
    fireEvent.click(screen.getByTitle("Broad"));
    pickShape("rectangle");
    drag("mouse", [[50, 60], [100, 100], [150, 140]]);
    drag("mouse", [[200, 200], [260, 250], [320, 300]]);
    expect(selectedTool()).toBe("shape");
    // The shapes are saved with the page's strokes, a moment after the pen lifts.
    fireEvent.keyDown(document, { key: "Escape" });
    const records = lastSaved(onChange).annotations!;
    expect(records).toHaveLength(2);
    // (page units: the Broad pen is 7 px on this 600 px page = 7·1000/600 units, a shape 1 + 1.2 × that)
    const width = 1 + 1.2 * 7 * (1000 / 600);
    for (const r of records) {
      expect(r.type).toBe("shape");
      expect(r.content!.shape).toMatchObject({ shapeType: "rectangle", strokeColor: "#c43c3c" });
      expect(r.content!.shape!.strokeWidth).toBeCloseTo(width, 9);
    }
    expect(lastSaved(onChange).pages[1].shapes).toHaveLength(2);
    expect(pdfPageDoc(lastSaved(onChange), 1)!.shapes).toHaveLength(2);
  });

  it("switching shape keeps drawing; a changed colour applies to the next one", async () => {
    const onChange = await renderView();
    pickShape("ellipse");
    drag("mouse", [[50, 60], [100, 100], [150, 140]]);
    fireEvent.click(screen.getByTitle("Blue"));
    pickShape("arrow");
    drag("mouse", [[20, 20], [70, 50], [120, 90]]);
    fireEvent.keyDown(document, { key: "Escape" });
    const shapes = lastSaved(onChange).annotations!.map((r) => r.content!.shape);
    expect(shapes.map((x) => x!.shapeType)).toEqual(["ellipse", "arrow"]);
    expect(shapes.map((x) => x!.strokeColor)).toEqual(["#7a2e33", "#315f8f"]);
  });

  it("a stored shape comes back into the engine: the eraser takes it, the record goes", async () => {
    const rec = shapeRecord("sh1", 1, { x: 100, y: 100 }, { x: 300, y: 220 }, { shapeType: "rectangle", strokeColor: "#315f8f", strokeWidth: 3 }, { width: 600, height: 800 })!;
    const doc = addShapeToPage({ ...emptyMultiPageDoc(), annotations: [rec] }, 1, "sh1", rec.content!.shape!);
    const onChange = await renderView({ initialDoc: doc });
    pick("eraser");
    drag("mouse", [[90, 160], [110, 160]]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastSaved(onChange).annotations).toEqual([]);
    expect(lastSaved(onChange).pages[1].shapes).toEqual([]);
  });

  it("while a shape tool is on, the page's own SVG copy of a stored shape hides (the engine draws it)", async () => {
    const rec = shapeRecord("sh1", 1, { x: 100, y: 100 }, { x: 300, y: 220 }, { shapeType: "diamond", strokeColor: "#315f8f", strokeWidth: 3 }, { width: 600, height: 800 })!;
    await renderView({ initialDoc: addShapeToPage({ ...emptyMultiPageDoc(), annotations: [rec] }, 1, "sh1", rec.content!.shape!) });
    expect(document.querySelector(".page-ink-svg path")).not.toBeNull();
    pick("shape");
    expect(document.querySelector(".page-ink-svg")).toBeNull();
    pick("select");
    expect(document.querySelector(".page-ink-svg path")).not.toBeNull();
  });

  it("undo takes a shape back out of the saved page", async () => {
    const onChange = await renderView();
    pickShape("triangle");
    drag("mouse", [[50, 60], [100, 100], [150, 140]]);
    fireEvent.click(undoButton());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled(); // nothing was ever saved: the shape was undone before it settled
  });
});

describe("a shape tool owns the touch, like the pen and the highlighter", () => {
  // Reported on a Galaxy Tab S9: with a shape tool chosen the drag was cut off
  // by the browser's scroll ("shapes can't be drawn"). The touch layer only
  // treated the ink tools as owning the pen, and the shape surface let the
  // browser claim finger drags.
  const penTouch = (type: string, x: number, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { changedTouches: [{ identifier: 7, clientX: x, clientY: y, touchType: "stylus" }], touches: type === "touchend" ? [] : [{ identifier: 7, clientX: x, clientY: y }] });
    act(() => { scroller.dispatchEvent(e); });
    return e;
  };

  for (const tool of ["pen", "highlighter", "eraser", "shape"]) {
    it(`${tool}: the pen's touch is taken from the browser, so it cannot scroll away from the drag`, async () => {
      await renderView();
      pick(tool);
      expect(penTouch("touchstart", 100, 100).defaultPrevented).toBe(true);
      expect(penTouch("touchmove", 140, 130).defaultPrevented).toBe(true);
      penTouch("touchend", 140, 130);
    });
  }

  it("Select: the pen's touch stays the browser's (select text, scroll)", async () => {
    await renderView();
    expect(penTouch("touchstart", 100, 100).defaultPrevented).toBe(false);
    penTouch("touchend", 100, 100);
  });

  const captureSurface = () => document.querySelector(".page-ink-surface") as HTMLElement;

  it("a shape tool: the page takes finger drags too (touch-action none), as the pen tool does", async () => {
    await renderView();
    pick("pen");
    const forPen = captureSurface().style.touchAction;
    pick("shape");
    expect(forPen).toBe("none");
    expect(captureSurface().style.touchAction).toBe("none");
  });

  it("stylus mode: with a shape tool, fingers scroll natively", async () => {
    touchDevice();
    await renderView();
    fingersOnlyScroll();
    pick("shape");
    expect(captureSurface().style.touchAction).toBe("pan-x pan-y");
  });
});

describe("⋯ menu", () => {
  it("one icon button enlarges and shrinks the PDF inside the app; a double tap on the PDF does nothing", async () => {
    await renderView();
    fireEvent.dblClick(sheet());
    const toggle = () => document.querySelector("[data-pdf-expand]") as HTMLButtonElement;
    expect(document.querySelector(".pane--expanded")).toBeNull();
    expect(toggle().textContent).toBe(""); // icon only
    expect(toggle()).toHaveAttribute("aria-label", "Enlarge");
    fireEvent.click(toggle());
    expect(document.querySelector(".pane--expanded")).not.toBeNull();
    expect(toggle()).toHaveAttribute("aria-label", "Shrink (Esc)");
    fireEvent.click(toggle());
    expect(document.querySelector(".pane--expanded")).toBeNull();
    expect(toggle()).toHaveAttribute("aria-label", "Enlarge");
  });

  it("zoom in, zoom out and fit width", async () => {
    await renderView();
    const zoom = () => Number(document.querySelector(".pagebook")!.getAttribute("data-pagebook-zoom"));
    openMore();
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Handwriting settings…", "Zoom in", "Zoom out", "Fit width", "Clear all annotations"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Zoom in" }));
    expect(zoom()).toBeCloseTo(1.2);
    openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Zoom in" }));
    expect(zoom()).toBeCloseTo(1.44);
    openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Zoom out" }));
    expect(zoom()).toBeCloseTo(1.2);
    openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Fit width" }));
    expect(zoom()).toBe(1);
  });

  it("clearing asks first; declining keeps everything", async () => {
    confirmDialog.mockImplementation(async () => false);
    const onChange = await renderView({ initialDoc: stored() });
    openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear all annotations" }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("undo and redo", () => {
  it("sit on the one toolbar in every tool; they act on the ink tools' strokes", async () => {
    await renderView();
    expect(undoButton().disabled).toBe(true); // nothing to undo yet
    pick("pen");
    drag("mouse", [[10, 10], [60, 40]]);
    expect(undoButton().disabled).toBe(false);
    pick("hand");
    expect(undoButton().disabled).toBe(false); // Hand keeps the engine, so the stroke can still be undone
    pick("select");
    expect(undoButton().disabled).toBe(true); // the engine is gone; its undo stack with it
  });
});

describe("input rules", () => {
  it("the Hand tool: a finger is left to the browser's scroll; the pen draws (it draws in every tool)", async () => {
    const onChange = await renderView();
    pick("hand");
    expect(surface().style.touchAction).toBe("pan-x pan-y");
    drag("touch", [[100, 300], [100, 200]]);
    expect(scroller.scrollTop).toBe(0);
    drag("pen", [[100, 300], [100, 200]]);
    expect(scroller.scrollTop).toBe(0);
    pick("select");
    expect(lastSaved(onChange).annotations).toHaveLength(1);
  });

  it("the pen setting 「follows the toolbar」: with the Hand tool the pen drags the PDF, as a finger would", async () => {
    localStorage.setItem("onden.ink.penDraws", "0");
    const onChange = await renderView();
    pick("hand");
    drag("pen", [[100, 300], [100, 200]]);
    expect(scroller.scrollTop).toBe(100);
    pick("select");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stylus mode: a finger is left to the browser's scroll, the pen still draws", async () => {
    touchDevice();
    const onChange = await renderView();
    pick("pen");
    expect(surface().style.touchAction).toBe("none");
    fingersOnlyScroll();
    expect(surface().style.touchAction).toBe("pan-x pan-y");
    drag("touch", [[100, 300], [100, 200]]);
    expect(scroller.scrollTop).toBe(0);
    drag("pen", [[20, 20], [60, 50]]);
    pick("select");
    expect(lastSaved(onChange).annotations).toHaveLength(1);
  });

  it("the pen's touches are kept from the browser while an ink tool is on; a finger's are not", async () => {
    await renderView();
    pick("pen");
    const penDown = () => scroller.dispatchEvent(pointer("pointerdown", { id: 7, kind: "pen", x: 50, y: 50, t: clock }));
    act(() => { penDown(); });
    expect(touchEvent("touchstart", [[1, 50, 50]]).defaultPrevented).toBe(true);
    expect(touchEvent("touchmove", [[1, 60, 60]]).defaultPrevented).toBe(true);
    touchEvent("touchend", [[1, 60, 60]]);
    act(() => { scroller.dispatchEvent(pointer("pointerup", { id: 7, kind: "pen", x: 60, y: 60, t: clock })); });
    // A palm right after the pen is held too; a finger later scrolls.
    expect(touchEvent("touchstart", [[2, 300, 300]]).defaultPrevented).toBe(true);
    touchEvent("touchend", [[2, 300, 300]]);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1000);
    expect(touchEvent("touchstart", [[3, 300, 300]]).defaultPrevented).toBe(false);
    touchEvent("touchend", [[3, 300, 300]]);
    // With Select the pen is the browser's.
    pick("select");
    act(() => { penDown(); });
    expect(touchEvent("touchstart", [[4, 50, 50]]).defaultPrevented).toBe(false);
    vi.restoreAllMocks();
  });

  it("without stylus mode a finger draws", async () => {
    touchDevice();
    const onChange = await renderView();
    pick("pen");
    drag("touch", [[100, 300], [100, 200]]);
    expect(scroller.scrollTop).toBe(0);
    pick("select");
    expect(lastSaved(onChange).annotations).toHaveLength(1);
  });

  it("the S Pen side button (contextmenu) switches pen ↔ eraser in the toolbar", async () => {
    await renderView();
    pick("pen");
    expect(selectedTool()).toBe("pen");
    const surface = document.querySelector(".page-ink-surface") as HTMLElement;
    fireEvent(surface, new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(selectedTool()).toBe("eraser");
  });

  it("a native shell's pen shortcut flips pen ↔ eraser while an ink tool is on, and is not taken in Select", async () => {
    await renderView();
    let taken = true;
    act(() => { taken = emitPenShortcut("s-pen-button"); });
    expect(taken).toBe(false); // Select: no ink tool, the view does not take it
    expect(selectedTool()).toBeUndefined();
    pick("pen");
    act(() => { taken = emitPenShortcut("apple-pencil-double-tap"); });
    expect(taken).toBe(true);
    expect(selectedTool()).toBe("eraser");
    act(() => { emitPenShortcut(); });
    expect(selectedTool()).toBe("pen");
  });

  it("a read-only PDF does not take the shortcut", async () => {
    await renderView({ readOnly: true });
    let taken = true;
    act(() => { taken = emitPenShortcut("s-pen-button"); });
    expect(taken).toBe(false);
  });

  it("two fingers pinch the PDF: a live preview, applied when they lift", async () => {
    await renderView();
    pick("pen");
    const pages = document.querySelector(".pagebook-pages")!;
    const start = touchEvent("touchstart", [[1, 100, 300], [2, 200, 300]]);
    expect(start.defaultPrevented).toBe(true);
    expect(pages.classList.contains("is-pinching")).toBe(true);
    touchEvent("touchmove", [[2, 300, 300]]); // 100 → 200 apart: ×2
    expect((pages as HTMLElement).style.transform).toContain("scale(2)");
    expect(document.querySelector(".pagebook")!.getAttribute("data-pagebook-zoom")).toBe("1"); // not laid out yet
    touchEvent("touchend", [[2, 300, 300]]);
    expect(pages.classList.contains("is-pinching")).toBe(false);
    expect(document.querySelector(".pagebook")!.getAttribute("data-pagebook-zoom")).toBe("2");
    touchEvent("touchend", [[1, 100, 300]]);
  });

  it("⌘ / Ctrl + wheel zooms the PDF around the cursor", async () => {
    await renderView();
    const wheel = new WheelEvent("wheel", { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true });
    act(() => { scroller.dispatchEvent(wheel); });
    expect(wheel.defaultPrevented).toBe(true);
    expect(document.querySelector(".pagebook")!.getAttribute("data-pagebook-zoom")).toBe("2");
  });

  it("after a zoom the pen draws where it touches, in page units: the engine stays", async () => {
    const onChange = await renderView();
    pick("pen");
    const before = surface();
    drag("pen", [[300, 300], [360, 330]]); // 600 px wide: 500, 500 units
    act(() => { scroller.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true })); }); // ×2: 1200 px wide
    expect(sheet().style.getPropertyValue("--pagebook-w")).toBe("1200px");
    pick("highlighter"); // any re-render of the page
    pick("pen");
    expect(surface()).toBe(before);
    drag("pen", [[600, 600], [720, 660]]); // 1200 px wide: the same 500, 500 units
    pick("select");
    const [first, second] = pdfPageDoc(lastSaved(onChange), 1)!.strokes;
    expect(first!.points[0]![0]).toBeCloseTo(500, 6);
    expect(second!.points[0]![0]).toBeCloseTo(500, 6);
    expect(second!.points[0]![1]).toBeCloseTo(500, 6);
    // the pen is the same size on screen: half the units at twice the zoom
    expect(second!.size).toBeCloseTo(first!.size / 2, 6);
    // …and the older form is a record per stroke, placed in the page's reference viewport
    expect(lastSaved(onChange).annotations!.at(-1)!.position.boundingRect.width).toBe(1000);
  });

  it("opens with the pen when stylus mode is on (fingers only scroll anyway), else with Select", async () => {
    touchDevice();
    await renderView();
    expect(pressedTool()?.getAttribute("data-pdf-tool")).toBe("select");
    pick("pen");
    fingersOnlyScroll();
    cleanup();
    await renderView();
    expect(selectedTool()).toBe("pen");
    cleanup();
    await renderView({ readOnly: true });
    expect(pressedTool()?.getAttribute("data-pdf-tool")).toBe("select");
  });
});

describe("the page going away", () => {
  const hidden = (state: "hidden" | "visible") => {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => { Reflect.deleteProperty(document, "visibilityState"); });

  it("pagehide saves strokes still waiting for the pen-up debounce, as a save that outlives the page", async () => {
    const onChange = await renderView();
    pick("pen");
    drag("mouse", [[10, 10], [60, 40]]);
    expect(onChange).not.toHaveBeenCalled(); // the debounce has not elapsed
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![1]).toEqual({ keepalive: true });
    expect(pdfPageDoc(lastSaved(onChange), 1)!.strokes).toHaveLength(1);
    // nothing more to write: a second signal saves nothing
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("switching away from the app (visibilitychange → hidden, no pagehide) saves them too; coming back does not", async () => {
    const onChange = await renderView();
    pick("pen");
    drag("mouse", [[10, 10], [60, 40]]);
    act(() => { hidden("visible"); });
    expect(onChange).not.toHaveBeenCalled();
    act(() => { hidden("hidden"); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![1]).toEqual({ keepalive: true });
  });

  it("the settle that follows is not a second save of the same strokes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const onChange = await renderView();
      pick("pen");
      drag("mouse", [[10, 10], [60, 40]]);
      act(() => { window.dispatchEvent(new Event("pagehide")); });
      act(() => { vi.advanceTimersByTime(1500); });
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("with no ink tool and nothing drawn, it saves nothing", async () => {
    const onChange = await renderView({ initialDoc: stored() });
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("pen-up keeps only the new stroke (lib/ink/surfaceSaver keepAdded)", () => {
  // Review of PR #1958 (property 1): at pen-up the view hands over the stroke just drawn — the envelope of only it, in both
  // forms — and nothing that grows with the drawing; the whole envelope still waits for the settle.
  it("at pen-up, onAdded gets an envelope with only the new stroke; onChange waits for the settle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const onAdded = vi.fn();
      const onChange = await renderView({ initialDoc: stored(), onAdded });
      pick("pen");
      drag("mouse", [[10, 10], [60, 40]]);
      expect(onAdded).toHaveBeenCalledTimes(1);
      const only = onAdded.mock.calls[0]![0] as InkMultiPageDoc;
      expect(pdfPageDoc(only, 1)!.strokes).toHaveLength(1); // the new one, not the stored d1
      expect(only.annotations!.map((a) => a.id)).not.toContain("d1");
      expect(onChange).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(1100); });
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(pdfPageDoc(lastSaved(onChange), 1)!.strokes).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
});
