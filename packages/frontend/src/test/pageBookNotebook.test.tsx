// The handwriting note as a notebook (InkNodeView over src/pagebook): pages in order, "+ Add page",
// each page its own engine near the screen, edits of every page saved in one InkPages, undo on the
// page drawn on last, nothing drawn outside a page, read-only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { INK_NOTE_MIN_HEIGHT, emptyInkPages, inkPageOrder, noteDoc, notePages, withPageAppended, type InkPages } from "@onden/markdown/ink";
import InkNodeView from "../components/InkNodeView";
import { emptyInkDocument } from "../lib/ink";
import { stubPagesNearScreen } from "./helpers/nearScreen";

function pointer(type: string, o: { x: number; y: number; t: number }): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerId: 1, pointerType: "mouse", button: 0, clientX: o.x, clientY: o.y, pressure: 0.5, getCoalescedEvents: () => [] });
  Object.defineProperty(e, "timeStamp", { value: o.t });
  return e;
}

let clock = 1000;
/** One stroke on `el`, then the pen is up. */
function drawOn(el: Element) {
  Object.assign(el, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
  clock += 1000;
  act(() => {
    el.dispatchEvent(pointer("pointerdown", { x: 200, y: 200, t: clock }));
    el.dispatchEvent(pointer("pointermove", { x: 600, y: 500, t: clock + 20 }));
    el.dispatchEvent(pointer("pointerup", { x: 600, y: 500, t: clock + 40 }));
  });
}
const surfaces = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>(".page-ink-surface"));
const leave = () => act(() => { window.dispatchEvent(new Event("pagehide")); });

const twoPages = (): InkPages => withPageAppended(notePages(emptyInkDocument()), "second");

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1400);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  stubPagesNearScreen();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a notebook's pages", () => {
  it("are laid out top to bottom in the order the envelope says, each a fixed sheet", () => {
    const pages = withPageAppended(withPageAppended(notePages(emptyInkDocument()), "b"), "a");
    const { container } = render(<InkNodeView initialPages={{ ...pages, order: ["page", "a", "b"] }} />);
    expect(Array.from(container.querySelectorAll("[data-page-key]"), (el) => (el as HTMLElement).dataset.pageKey)).toEqual(["page", "a", "b"]);
    const box = container.querySelector<HTMLElement>('[data-page-key="a"]')!;
    const ratio = parseFloat(box.style.getPropertyValue("--pagebook-h")) / parseFloat(box.style.getPropertyValue("--pagebook-w"));
    expect(ratio).toBeCloseTo(INK_NOTE_MIN_HEIGHT / 1000, 6);
  });

  it("a note without a drawing yet still has its first page, and a long page keeps its height", () => {
    const { container, unmount } = render(<InkNodeView initialPages={emptyInkPages()} />);
    expect(container.querySelectorAll('[data-page-key="page"]')).toHaveLength(1);
    unmount();
    const long = notePages({ ...emptyInkDocument(), strokes: [{ id: "s", toolId: "pen", color: "#000", size: 4, points: [[10, 10], [20, 3000]] }] });
    const view = render(<InkNodeView initialPages={long} />);
    const box = view.container.querySelector<HTMLElement>('[data-page-key="page"]')!;
    expect(parseFloat(box.style.getPropertyValue("--pagebook-h")) / parseFloat(box.style.getPropertyValue("--pagebook-w"))).toBeCloseTo(3, 6);
  });
});

describe("+ Add page", () => {
  it("adds a blank page last, with its own key written into the order, and scrolls to it", () => {
    const onPagesChange = vi.fn();
    const { container } = render(<InkNodeView onPagesChange={onPagesChange} />);
    const scroller = container.querySelector<HTMLElement>(".pagebook-scroll")!;
    scroller.scrollTop = 0;
    // The new page will be 900 px below the top of the view once it is laid out.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = this.dataset.pageKey && this.dataset.pageKey !== "page" ? 900 : 0;
      return { top, bottom: top + 10, left: 0, right: 10, width: 10, height: 10, x: 0, y: top, toJSON: () => ({}) };
    });
    fireEvent.click(screen.getByRole("button", { name: "+ Add page" }));
    expect(onPagesChange).toHaveBeenCalledTimes(1);
    const pages = onPagesChange.mock.calls[0]![0] as InkPages;
    const order = inkPageOrder(pages);
    expect(order).toHaveLength(2);
    expect(order[0]).toBe("page");
    expect(pages.order).toEqual(order);
    expect(pages.pages[order[1]!]!.size).toEqual({ width: 1000, height: INK_NOTE_MIN_HEIGHT });
    expect(pages.pages[order[1]!]!.doc.strokes).toEqual([]);
    expect(container.querySelector(`[data-page-key="${order[1]}"]`)).not.toBeNull();
    expect(scroller.scrollTop).toBe(888); // its top at the top of the view, less the gutter
  });

  it("gives every added page a key of its own", () => {
    const onPagesChange = vi.fn();
    render(<InkNodeView onPagesChange={onPagesChange} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add page" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add page" }));
    const pages = onPagesChange.mock.calls[1]![0] as InkPages;
    const order = inkPageOrder(pages);
    expect(order).toHaveLength(3);
    expect(new Set(order).size).toBe(3);
  });

  it("is not there in a note that cannot be edited, and no page takes a stroke", () => {
    const onPagesChange = vi.fn();
    const { container } = render(<InkNodeView readOnly initialPages={twoPages()} onPagesChange={onPagesChange} />);
    expect(screen.queryByRole("button", { name: "+ Add page" })).toBeNull();
    expect(surfaces(container)).toHaveLength(0);
    leave();
    expect(onPagesChange).not.toHaveBeenCalled();
  });
});

describe("saving a notebook", () => {
  it("a stroke on the second page comes back in morePages; the first page stays at the top", () => {
    const onPagesChange = vi.fn();
    const { container } = render(<InkNodeView initialPages={twoPages()} onPagesChange={onPagesChange} />);
    drawOn(surfaces(container)[1]!);
    leave();
    expect(onPagesChange).toHaveBeenCalledTimes(1);
    const [pages, options] = onPagesChange.mock.calls[0]!;
    expect(options).toEqual({ keepalive: true });
    const stored = noteDoc(pages)!;
    expect(stored.strokes).toHaveLength(0);
    expect(stored.morePages!.pages.second!.doc.strokes).toHaveLength(1);
    expect(stored.morePages!.order).toEqual(["page", "second"]);
    // and the note reads back as the same two pages
    expect(inkPageOrder(notePages(stored))).toEqual(["page", "second"]);
  });

  it("strokes on both pages go out together, each on its own page", () => {
    const onPagesChange = vi.fn();
    const { container } = render(<InkNodeView initialPages={twoPages()} onPagesChange={onPagesChange} />);
    drawOn(surfaces(container)[0]!);
    drawOn(surfaces(container)[1]!);
    leave();
    const pages = onPagesChange.mock.calls.at(-1)![0] as InkPages;
    expect(pages.pages.page!.doc.strokes).toHaveLength(1);
    expect(pages.pages.second!.doc.strokes).toHaveLength(1);
  });

  it("the ordinary save comes about a second after the pen lifts, without keepalive", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const onPagesChange = vi.fn();
      const { container } = render(<InkNodeView initialPages={twoPages()} onPagesChange={onPagesChange} />);
      drawOn(surfaces(container)[1]!);
      expect(onPagesChange).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(2000); });
      expect(onPagesChange).toHaveBeenCalledTimes(1);
      expect(onPagesChange.mock.calls[0]![1]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a page whose engine is dropped (scrolled far away) hands its strokes over first, and shows them again later", () => {
    const callbacks: Array<{ target: Element; cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void }> = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private readonly cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) {}
      observe(target: Element) { callbacks.push({ target, cb: this.cb }); this.cb([{ isIntersecting: true, target }]); }
      disconnect() {}
    });
    const onPagesChange = vi.fn();
    const { container } = render(<InkNodeView initialPages={twoPages()} onPagesChange={onPagesChange} />);
    const second = surfaces(container)[1]!;
    drawOn(second);
    expect(onPagesChange).not.toHaveBeenCalled(); // still in the pen-up pause
    const mine = callbacks.find((c) => c.target === second)!;
    act(() => mine.cb([{ isIntersecting: false, target: second }]));
    // Dropped: its strokes were handed over at once, and the picture of them is there.
    expect(onPagesChange).toHaveBeenCalledTimes(1);
    expect((onPagesChange.mock.calls[0]![0] as InkPages).pages.second!.doc.strokes).toHaveLength(1);
    expect(container.querySelectorAll(".page-ink-canvas")).toHaveLength(2); // only the first page's engine is left
    expect(container.querySelector('[data-page-key="second"] .page-ink-svg')).not.toBeNull();
    act(() => mine.cb([{ isIntersecting: true, target: second }]));
    expect(container.querySelectorAll(".page-ink-canvas")).toHaveLength(4);
    leave();
    expect(onPagesChange).toHaveBeenCalledTimes(1); // nothing new to save, nothing lost
  });
});

describe("drawing", () => {
  it("a stroke that starts outside every page (the gap, the scroller) is not drawn", () => {
    const onPagesChange = vi.fn();
    const { container } = render(<InkNodeView initialPages={twoPages()} onPagesChange={onPagesChange} />);
    drawOn(container.querySelector(".pagebook-scroll")!);
    drawOn(container.querySelector(".pagebook-pages")!);
    leave();
    expect(onPagesChange).not.toHaveBeenCalled();
  });

  it("a stroke dragged past the bottom edge stays on the page, so the first page does not grow when reopened", () => {
    const onPagesChange = vi.fn();
    const { container } = render(<InkNodeView onPagesChange={onPagesChange} />);
    const el = surfaces(container)[0]!;
    Object.assign(el, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
    clock += 1000;
    act(() => {
      el.dispatchEvent(pointer("pointerdown", { x: 200, y: 200, t: clock }));
      el.dispatchEvent(pointer("pointermove", { x: 1200, y: 5000, t: clock + 20 }));
      el.dispatchEvent(pointer("pointerup", { x: 1200, y: 5000, t: clock + 40 }));
    });
    leave();
    const saved = onPagesChange.mock.calls.at(-1)![0] as InkPages;
    const points = saved.pages.page!.doc.strokes.flatMap((s) => s.points);
    expect(points.length).toBeGreaterThan(0);
    expect(Math.max(...points.map((p) => p[0]))).toBeLessThanOrEqual(1000);
    expect(Math.max(...points.map((p) => p[1]))).toBeLessThanOrEqual(INK_NOTE_MIN_HEIGHT);
    expect(notePages(noteDoc(saved)).pages.page!.size.height).toBe(INK_NOTE_MIN_HEIGHT);
  });

  it("Undo goes to the page drawn on last, then the one before", () => {
    const onPagesChange = vi.fn();
    const { container } = render(<InkNodeView initialPages={twoPages()} onPagesChange={onPagesChange} />);
    drawOn(surfaces(container)[0]!);
    drawOn(surfaces(container)[1]!);
    const undo = () => fireEvent.keyDown(container.querySelector(".ink-note")!, { key: "z", ctrlKey: true });
    undo();
    leave();
    let pages = onPagesChange.mock.calls.at(-1)![0] as InkPages;
    expect(pages.pages.page!.doc.strokes).toHaveLength(1);
    expect(pages.pages.second!.doc.strokes).toHaveLength(0);
    undo();
    leave();
    pages = onPagesChange.mock.calls.at(-1)![0] as InkPages;
    expect(pages.pages.page!.doc.strokes).toHaveLength(0);
  });
});

describe("zoom", () => {
  const zoomOf = (container: HTMLElement) => Number(container.querySelector<HTMLElement>(".pagebook")!.dataset.pagebookZoom);
  // This environment's WheelEvent drops ctrlKey, so the event is made by hand.
  const wheel = (container: HTMLElement, deltaY: number) => act(() => {
    const e = Object.assign(new Event("wheel", { bubbles: true, cancelable: true }), { ctrlKey: true, deltaY, clientX: 100, clientY: 100 });
    container.querySelector(".pagebook-scroll")!.dispatchEvent(e);
  });

  it("⌘ / Ctrl + wheel zooms between 0.5× and 4×; the chip shows it and goes back to fit width", () => {
    const { container } = render(<InkNodeView />);
    expect(zoomOf(container)).toBe(1);
    wheel(container, -100);
    expect(zoomOf(container)).toBeGreaterThan(1);
    for (let i = 0; i < 20; i++) wheel(container, -300);
    expect(zoomOf(container)).toBe(4);
    for (let i = 0; i < 40; i++) wheel(container, 300);
    expect(zoomOf(container)).toBe(0.5);
    expect(screen.getByRole("button", { name: /Zoom 50%/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Zoom 50%/ }));
    expect(zoomOf(container)).toBe(1);
  });

  it("zooming changes the sheets' width, not the page's units", () => {
    const { container } = render(<InkNodeView />);
    const width = () => parseFloat(container.querySelector<HTMLElement>('[data-page-key="page"]')!.style.getPropertyValue("--pagebook-w"));
    const fit = width();
    wheel(container, -69.3147); // the factor is 2^(-deltaY × 0.01)
    expect(width() / fit).toBeCloseTo(Math.pow(2, 0.693147), 3);
  });
});
