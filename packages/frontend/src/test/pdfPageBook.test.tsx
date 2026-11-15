// @vitest-environment jsdom
// A PDF note is a page book (src/pagebook): one book page per PDF page, drawn by pdf.js where it is
// near the screen; the PDF's own layers (text selection, highlights, area select, links) over it.
// What these pin: the pages' keys, order and shape; which pages draw and when they redraw; that the
// select tool leaves the text layer reachable; that a highlight saved by the old viewer lands in the
// same place on the sheet; that a link scrolls to its page; that a page measured late does not move
// what is on the screen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import PdfNodeView from "../components/PdfNodeView";
import { PageBook } from "../pagebook";
import { scaledPositionToViewport, type PdfHighlightRecord } from "../lib/pdf/coords";
import { usePdfPageShapes } from "../components/pdf";
import type { PdfDocument } from "../components/pdf/usePdfDocument";
import { addDrawingToPage, emptyMultiPageDoc, type InkMultiPageDoc } from "../lib/pdf/pdfAdapter";
import { drawingRecord } from "../lib/pdf/capture";
import { createPdfDrawSession } from "../lib/pdf/drawSession";
import { blankPageRecord, type InkPages } from "@onden/markdown/ink";
import { fakePdf, releaseRenders, settlePdf } from "./helpers/fakePdf";

vi.mock("../lib/pdf/pdfjs", async () => (await import("./helpers/fakePdf")).fakePdfjsModule());

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const sheet = (n: number) => document.querySelector(`[data-page-key="pdf:${n}"]`) as HTMLElement;
const sheets = () => [...document.querySelectorAll<HTMLElement>("[data-page-key]")];
const scroller = () => document.querySelector(".pagebook-scroll") as HTMLElement;
const zoomValue = () => Number(document.querySelector(".pagebook")!.getAttribute("data-pagebook-zoom"));
const wheelZoom = (deltaY: number) => act(() => { scroller().dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY, bubbles: true, cancelable: true })); });
const pick = (tool: string) => fireEvent.click(document.querySelector(`[data-ink-tool="${tool}"], [data-pdf-tool="${tool}"]`)!);

/** Observers by the element they watch, so a test can say which pages are on the screen. */
function stubIntersection() {
  const watching: Array<{ target: Element; cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void }> = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private readonly cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) {}
    observe(target: Element) { watching.push({ target, cb: this.cb }); }
    disconnect() {}
    unobserve() {}
  });
  return (target: Element, isIntersecting: boolean) => {
    act(() => { for (const w of watching) if (w.target === target) w.cb([{ isIntersecting, target }]); });
  };
}

async function mount(props: Partial<React.ComponentProps<typeof PdfNodeView>> = {}) {
  const onChange = vi.fn();
  const view = render(<PdfNodeView pdfUrl="https://example.com/a.pdf" onChange={onChange} {...props} />);
  await settlePdf();
  return { onChange, ...view };
}
let clock = 0;
/** A pen drag on the first ink surface. */
function drag(points: Array<[number, number]>) {
  const surface = document.querySelector(".page-ink-surface") as HTMLElement;
  Object.assign(surface, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
  const event = (type: string, [x, y]: [number, number], t: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { pointerId: 1, pointerType: "pen", button: 0, clientX: x, clientY: y, pressure: 0.5, getCoalescedEvents: () => [] });
    Object.defineProperty(e, "timeStamp", { value: t });
    return e;
  };
  clock += 2000;
  act(() => {
    surface.dispatchEvent(event("pointerdown", points[0]!, clock));
    points.slice(1).forEach((p, i) => surface.dispatchEvent(event("pointermove", p, clock + 20 * (i + 1))));
    surface.dispatchEvent(event("pointerup", points[points.length - 1]!, clock + 20 * points.length));
  });
}
/** Let the draw timers (a first draw is immediate, a redraw waits for the zoom to settle) run. */
const runTimers = (ms = 300) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  fakePdf.reset();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // jsdom has no layout: the book's view is 624 px wide (fit width 600), a canvas has a context.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("pagebook-scroll") ? 624 : 0; });
  // pdf.js's canvas has a context; the ink engine's canvases (jsdom has none) stay constructible without one.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return (this.classList.contains("page-ink-canvas") ? null : {}) as unknown as CanvasRenderingContext2D;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the pages of a PDF in the book", () => {
  it("one sheet per PDF page, keyed pdf:<n>, in page order", async () => {
    fakePdf.pages = [{ width: 600, height: 800 }, { width: 600, height: 800 }, { width: 600, height: 800 }];
    await mount();
    expect(sheets().map((s) => s.dataset.pageKey)).toEqual(["pdf:1", "pdf:2", "pdf:3"]);
    expect([...document.querySelectorAll("[data-pdf-page]")].map((el) => el.getAttribute("data-pdf-page"))).toEqual(["1", "2", "3"]);
  });

  it("a sheet is the page's own shape — its viewport, page rotation included", async () => {
    fakePdf.pages = [{ width: 600, height: 800 }, { width: 600, height: 800, rotation: 90 }, { width: 800, height: 600 }];
    await mount();
    const size = (n: number) => [sheet(n).style.getPropertyValue("--pagebook-w"), sheet(n).style.getPropertyValue("--pagebook-h")];
    expect(size(1)).toEqual(["600px", "800px"]);
    expect(size(2)).toEqual(["600px", "450px"]); // turned: 800 wide, 600 tall
    expect(size(3)).toEqual(["600px", "450px"]);
  });

  it("no sheet before the PDF is open; an unreadable PDF says so and has none", async () => {
    const { container } = render(<PdfNodeView pdfUrl="https://example.com/a.pdf" />);
    expect(container.querySelector("[data-page-key]")).toBeNull();
    await settlePdf();
    expect(container.querySelector("[data-page-key]")).not.toBeNull();
    cleanup();
    fakePdf.failOpen = true;
    const failed = render(<PdfNodeView pdfUrl="https://example.com/b.pdf" />);
    await settlePdf();
    expect(failed.container.querySelector("[data-page-key]")).toBeNull();
    expect(failed.container.querySelector(".pdf-node-error")?.textContent).toBe("Failed to load this PDF.");
  });

  it("the sheet has no border and no padding: its box is the page's box (the frame highlights are measured against)", () => {
    const css = readFileSync(join(__dirname, "../pagebook/PageBook.css"), "utf8");
    const rule = /\.pagebook-page\s*\{([^}]*)\}/.exec(css)![1]!.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rule).not.toMatch(/(^|[;\s])(border|border-width|padding)\s*:/m);
    expect(css).toMatch(/\.pagebook-page::after\s*\{[^}]*inset:\s*-1px/);
  });
});

describe("page shapes (usePdfPageShapes)", () => {
  const docOf = () => ({
    get numPages() { return fakePdf.pages.length; },
    getPage: async (n: number) => ({ getViewport: ({ scale }: { scale: number }) => ({ width: fakePdf.pages[n - 1]!.width * scale, height: fakePdf.pages[n - 1]!.height * scale }) }),
  }) as unknown as PdfDocument;
  const settle = () => act(async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); });

  it("every page has the first page's shape once page 1 is read; a PDF whose pages are alike never changes state again", async () => {
    fakePdf.pages = Array.from({ length: 300 }, () => ({ width: 600, height: 800 }));
    const seen = new Set<unknown>();
    const doc = docOf();
    const { result } = renderHook(() => { const shapes = usePdfPageShapes(doc); if (shapes) seen.add(shapes); return shapes; });
    await settle();
    expect(result.current!.count).toBe(300);
    expect(result.current!.ratio(250)).toBeCloseTo(4 / 3);
    expect(seen.size).toBe(1);
  });

  it("a page that differs is corrected when it has been read; the others keep the first page's shape", async () => {
    fakePdf.pages = Array.from({ length: 60 }, (_, i) => (i === 39 ? { width: 800, height: 600 } : { width: 600, height: 800 }));
    const doc = docOf();
    const { result } = renderHook(() => usePdfPageShapes(doc));
    await settle();
    expect(result.current!.ratio(40)).toBeCloseTo(0.75);
    expect(result.current!.ratio(41)).toBeCloseTo(4 / 3);
    expect(result.current!.ratio(1)).toBeCloseTo(4 / 3);
  });
});

describe("only the pages near the screen draw", () => {
  it("a page draws its picture and text when it is near, at its box's pixels, and lets go when it is not", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fakePdf.pages = [{ width: 600, height: 800 }, { width: 600, height: 800 }];
    const setNear = stubIntersection();
    await mount();
    await runTimers();
    expect(fakePdf.renders).toEqual([]); // nothing reported near yet
    expect(fakePdf.textLayers).toEqual([]);

    setNear(sheet(2), true);
    await settlePdf();
    await runTimers();
    expect(fakePdf.renders.map((r) => r.page)).toEqual([2]);
    expect(fakePdf.renders[0]!.scale).toBe(1); // 600 px wide at 1 px per CSS px (jsdom's ratio) on a 600-pt page
    expect(fakePdf.textLayers).toEqual([2]);
    expect(sheet(2).querySelectorAll(".pdf-page-canvas canvas")).toHaveLength(1);
    expect(sheet(1).querySelectorAll(".pdf-page-canvas canvas")).toHaveLength(0);

    setNear(sheet(2), false);
    await runTimers();
    expect(sheet(2).querySelectorAll(".pdf-page-canvas canvas")).toHaveLength(0); // its pixels are released
    expect(fakePdf.cleaned).toContain(2);
  });

  it("a zoom redraws at the new resolution once it settles; the old picture stays up until the new one is done", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await mount();
    await runTimers();
    const first = sheet(1).querySelector(".pdf-page-canvas canvas") as HTMLCanvasElement;
    expect(first.width).toBe(600);
    expect(fakePdf.renders).toHaveLength(1);

    fakePdf.holdRenders = true;
    wheelZoom(-100); // ×2
    expect(zoomValue()).toBe(2);
    expect(fakePdf.renders).toHaveLength(1); // not yet: a zoom burst redraws once
    await runTimers();
    expect(fakePdf.renders).toHaveLength(2);
    expect(fakePdf.renders[1]!.scale).toBe(2);
    expect(sheet(1).querySelector(".pdf-page-canvas canvas")).toBe(first); // the old picture still stands, stretched

    await releaseRenders();
    const second = sheet(1).querySelector(".pdf-page-canvas canvas") as HTMLCanvasElement;
    expect(second).not.toBe(first);
    expect(second.width).toBe(1200);
    expect(sheet(1).querySelectorAll(".pdf-page-canvas canvas")).toHaveLength(1);
  });

  it("a zoom burst draws once, and a zoom that cancels an unfinished draw cancels it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await mount();
    await runTimers();
    fakePdf.holdRenders = true;
    wheelZoom(-100);
    await runTimers(150);
    expect(fakePdf.renders).toHaveLength(2);
    wheelZoom(-100); // ×4 total, while the ×2 draw is unfinished
    await runTimers(150);
    expect(fakePdf.renders[1]!.cancelled).toBe(true);
    expect(fakePdf.renders).toHaveLength(3);
    expect(fakePdf.renders[2]!.scale).toBe(4);
  });
});

describe("the select tool leaves the text layer reachable", () => {
  it("no ink surface over the pages with Select or Text; one per page with an ink tool", async () => {
    fakePdf.pages = [{ width: 600, height: 800 }, { width: 600, height: 800 }];
    await mount({ pageText: { nodeId: "n", initial: null } });
    expect(document.querySelectorAll(".page-ink-surface")).toHaveLength(0);
    expect(document.querySelectorAll(".pdf-text-layer")).toHaveLength(2);
    pick("text");
    expect(document.querySelectorAll(".page-ink-surface")).toHaveLength(0);
    pick("pen");
    expect(document.querySelectorAll(".page-ink-surface")).toHaveLength(2);
    pick("select");
    expect(document.querySelectorAll(".page-ink-surface")).toHaveLength(0);
  });
});

describe("highlights saved by the old viewer land where they did", () => {
  // The old viewer's page div was `scale` × the page's points wide (removePageBorders: no border), and
  // stored rects were measured against it. The sheet at the same width is the same frame.
  const text = (page: number, x1: number, y1: number, x2: number, y2: number, capture: { width: number; height: number }): PdfHighlightRecord => ({
    id: `h${page}`, type: "text", content: { text: "t" },
    position: { boundingRect: { x1, y1, x2, y2, ...capture, pageNumber: page }, rects: [{ x1, y1, x2, y2, ...capture, pageNumber: page }] },
  });
  const styled = (el: Element) => ["left", "top", "width", "height"].map((k) => parseFloat((el as HTMLElement).style.getPropertyValue(`--pdf-hl-${k}`)));

  for (const [label, deltaY, scale] of [["fit width", 0, 1], ["×2", -100, 2], ["4×", -200, 4]] as const) {
    it(`at ${label}`, async () => {
      // Captured when the old viewer showed the page 780 px wide (scale 1.3 of 600 pt).
      const record = text(1, 110, 220, 330, 240, { width: 780, height: 1040 });
      await mount({ initialDoc: { ...emptyMultiPageDoc(), annotations: [record] } });
      if (deltaY) wheelZoom(deltaY);
      expect(zoomValue()).toBe(scale);
      // What the old viewer drew at this zoom: its viewport was 600·scale × 800·scale.
      const oldViewer = { width: 600 * scale, height: 800 * scale };
      const expected = scaledPositionToViewport(record.position, oldViewer).rects[0]!;
      const drawn = styled(sheet(1).querySelector(".pdf-hl-text")!);
      expect(drawn[0]).toBeCloseTo(expected.left, 6);
      expect(drawn[1]).toBeCloseTo(expected.top, 6);
      expect(drawn[2]).toBeCloseTo(expected.width, 6);
      expect(drawn[3]).toBeCloseTo(expected.height, 6);
      // …in a sheet of the same size
      expect(sheet(1).style.getPropertyValue("--pagebook-w")).toBe(`${oldViewer.width}px`);
      expect(sheet(1).style.getPropertyValue("--pagebook-h")).toBe(`${oldViewer.height}px`);
    });
  }
});

describe("saving what the PDF's own layers make", () => {
  it("Alt+drag selects an area on the page it started on, and saves it as one edit", async () => {
    const { onChange } = await mount();
    sheet(1).getBoundingClientRect = () => box(0, 0, 600, 800);
    const down = Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), { altKey: true, button: 0, clientX: 100, clientY: 100 });
    act(() => { scroller().dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);
    const up = Object.assign(new Event("pointerup"), { clientX: 300, clientY: 250 });
    act(() => { window.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 200, clientY: 200 })); window.dispatchEvent(up); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const saved = onChange.mock.calls[0]![0] as InkMultiPageDoc;
    expect(saved.annotations).toHaveLength(1);
    expect(saved.annotations![0]).toMatchObject({ type: "area", position: { boundingRect: { x1: 100, y1: 100, x2: 300, y2: 250, width: 600, height: 800, pageNumber: 1 } } });
  });

  it("a stroke saves the envelope with its page in units and the older fields beside it", async () => {
    const { onChange } = await mount();
    pick("pen");
    drag([[100, 100], [160, 130], [220, 160]]);
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const [saved, options] = onChange.mock.calls[0]! as [InkMultiPageDoc, unknown];
    expect(options).toEqual({ keepalive: true }); // the page is going away: the save must outlive it
    expect(saved.units!.pages["pdf:1"]!.doc.strokes).toHaveLength(1);
    expect(saved.units!.pages["pdf:1"]!.size).toEqual({ width: 1000, height: (1000 * 800) / 600 });
    expect(saved.pages[1]!.strokes).toHaveLength(1); // the older fields, for an older app
    expect(saved.annotations!.filter((a) => a.type === "drawing")).toHaveLength(1);
  });
});

describe("another version of the drawing arrives", () => {
  it("the engines are rebuilt from it, and the pages show it", async () => {
    const strokeDoc = (id: string): InkMultiPageDoc => {
      const record = drawingRecord(id, 1, [{ points: [{ x: 100, y: 100 }, { x: 200, y: 100 }], color: "#7a2e33", width: 2.5 }], { width: 600, height: 800 })!;
      return addDrawingToPage({ ...emptyMultiPageDoc(), annotations: [record] }, 1, id, record.content!.strokes!);
    };
    const onChange = vi.fn();
    const view = render(<PdfNodeView pdfUrl="https://example.com/a.pdf" initialDoc={strokeDoc("a")} onChange={onChange} />);
    await settlePdf();
    pick("pen");
    const before = document.querySelector(".page-ink-surface");
    view.rerender(<PdfNodeView pdfUrl="https://example.com/a.pdf" initialDoc={emptyMultiPageDoc()} onChange={onChange} />);
    expect(document.querySelector(".page-ink-surface")).not.toBe(before);
    pick("select");
    expect(document.querySelectorAll(".page-ink-svg")).toHaveLength(0); // the other version has no ink
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("links", () => {
  const link = (extra: Record<string, unknown>) => ({ subtype: "Link", rect: [60, 700, 180, 720], ...extra });

  it("an outside address opens in a new tab, as a plain link; an address that is not http, https or mailto is not offered", async () => {
    fakePdf.annotations[1] = [link({ url: "https://example.com/x" }), link({ url: "javascript:alert(1)", rect: [60, 600, 180, 620] })];
    await mount();
    const anchors = sheet(1).querySelectorAll<HTMLAnchorElement>("a.pdf-link");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute("href")).toBe("https://example.com/x");
    expect(anchors[0]!.getAttribute("target")).toBe("_blank");
    expect(anchors[0]!.getAttribute("rel")).toBe("noopener noreferrer");
    // laid out in percent of the page, so it follows any zoom: 600 × 800 pt, rect from the bottom
    expect(anchors[0]!.style.getPropertyValue("--pdf-link-left")).toBe("10%");
    expect(anchors[0]!.style.getPropertyValue("--pdf-link-width")).toBe("20%");
    expect(parseFloat(anchors[0]!.style.getPropertyValue("--pdf-link-top"))).toBeCloseTo(10);
  });

  it("a link inside the document scrolls the book to that page", async () => {
    fakePdf.pages = [{ width: 600, height: 800 }, { width: 600, height: 800 }];
    fakePdf.destinations.chapter2 = [{ num: 2 }, { name: "XYZ" }];
    fakePdf.annotations[1] = [link({ dest: "chapter2" })];
    await mount();
    scroller().getBoundingClientRect = () => box(0, 0, 624, 500);
    sheet(2).getBoundingClientRect = () => box(12, 824, 600, 800);
    await act(async () => {
      fireEvent.click(sheet(1).querySelector("a.pdf-link")!);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    expect(scroller().scrollTop).toBe(824 - 12); // page 2's top at the top of the view, less the gutter
  });
});

describe("a page measured late does not move what is on the screen", () => {
  /** A layout for jsdom: sheets stack at their own heights in the scroller, minus the scroll. */
  function fakeLayout() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("pagebook-scroll")) return box(0, 0, 624, 500);
      if (this.dataset.pageKey) {
        const all = [...this.parentElement!.querySelectorAll<HTMLElement>("[data-page-key]")];
        let top = 12 - scroller().scrollTop;
        for (const el of all) {
          if (el === this) break;
          top += parseFloat(el.style.getPropertyValue("--pagebook-h")) + 12;
        }
        return box(12, top, parseFloat(this.style.getPropertyValue("--pagebook-w")), parseFloat(this.style.getPropertyValue("--pagebook-h")));
      }
      return box(0, 0, 0, 0);
    });
  }
  const book = (heights: number[]): InkPages => ({
    version: 1,
    pages: Object.fromEntries(heights.map((h, i) => { const r = blankPageRecord(`p${i}`); return [`p${i}`, { ...r, size: { width: 1000, height: h } }]; })),
    order: heights.map((_, i) => `p${i}`),
  });
  const props = (pages: InkPages): React.ComponentProps<typeof PageBook> => ({
    pages, session: createPdfDrawSession(), tool: null,
    pen: { color: "#000", size: 3, shapeKind: "rectangle", shapeFill: "none", autoShape: false },
    penDraws: true, stylusOnly: false, onPenSeen: () => {}, onPenShortcut: () => {}, t: (k) => k,
  });

  beforeEach(() => fakeLayout());

  it("a page above the view growing keeps the page point at the top of the view where it was", () => {
    const view = render(<PageBook {...props(book([1000, 1000, 1000]))} />);
    scroller().scrollTop = 700; // 600 px pages: this is page 2, 88 px down
    view.rerender(<PageBook {...props(book([1500, 1000, 1000]))} />); // page 1: 600 → 900 px
    expect(scroller().scrollTop).toBe(700 + 300);
  });

  it("the page at the top of the view growing keeps the same content at the top, not the same fraction", () => {
    const view = render(<PageBook {...props(book([1000, 1000]))} />);
    scroller().scrollTop = 300; // 288 px into page 1 = 480 units
    view.rerender(<PageBook {...props(book([2000, 1000]))} />);
    expect(scroller().scrollTop).toBe(300);
  });

  it("pages that change below the view move nothing", () => {
    const view = render(<PageBook {...props(book([1000, 1000, 1000]))} />);
    scroller().scrollTop = 100;
    view.rerender(<PageBook {...props(book([1000, 1000, 1800]))} />);
    expect(scroller().scrollTop).toBe(100);
  });
});
