// A handwriting page going away (close, navigate, a phone switching apps) must
// not take the strokes still waiting for the engine's debounce: they are saved
// at once, as a save that outlives the page (keepalive).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubPagesNearScreen } from "./helpers/nearScreen";
import { act, cleanup, render } from "@testing-library/react";
import InkNodeView from "../components/InkNodeView";
import { noteDoc } from "@onden/markdown/ink";

function pointer(type: string, o: { x: number; y: number; t: number }): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerId: 1, pointerType: "mouse", button: 0, clientX: o.x, clientY: o.y, pressure: 0.5, getCoalescedEvents: () => [] });
  Object.defineProperty(e, "timeStamp", { value: o.t });
  return e;
}

function draw(container: HTMLElement) {
  const stage = container.querySelector(".page-ink-surface") as HTMLElement;
  Object.assign(stage, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
  act(() => {
    stage.dispatchEvent(pointer("pointerdown", { x: 200, y: 200, t: 1000 }));
    stage.dispatchEvent(pointer("pointermove", { x: 600, y: 500, t: 1020 }));
    stage.dispatchEvent(pointer("pointerup", { x: 600, y: 500, t: 1040 }));
  });
}

const hidden = (state: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  // jsdom has no layout: give the page's scroller the size of a 1000-unit page (1 px per unit).
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
  Reflect.deleteProperty(document, "visibilityState");
});

describe("InkNodeView when the page goes away", () => {
  it("pagehide saves the strokes still in the debounce, once, with keepalive", () => {
    const onPagesChange = vi.fn();
    const { container } = render(<InkNodeView onPagesChange={onPagesChange} />);
    draw(container);
    expect(onPagesChange).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(onPagesChange).toHaveBeenCalledTimes(1);
    const [pages, options] = onPagesChange.mock.calls[0]!;
    expect(options).toEqual({ keepalive: true });
    expect(pages.pages.page).toMatchObject({ key: "page", background: { kind: "blank" } });
    expect(noteDoc(pages)!.strokes).toHaveLength(1);
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(onPagesChange).toHaveBeenCalledTimes(1); // nothing left to save
  });

  it("switching away from the app (visibilitychange → hidden) saves them too; coming back does not", () => {
    const onPagesChange = vi.fn();
    const { container } = render(<InkNodeView onPagesChange={onPagesChange} />);
    draw(container);
    act(() => { hidden("visible"); });
    expect(onPagesChange).not.toHaveBeenCalled();
    act(() => { hidden("hidden"); });
    expect(onPagesChange).toHaveBeenCalledTimes(1);
    expect(onPagesChange.mock.calls[0]![1]).toEqual({ keepalive: true });
  });

  it("the ordinary debounced save is not a leaving save", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const onPagesChange = vi.fn();
      const { container } = render(<InkNodeView onPagesChange={onPagesChange} />);
      draw(container);
      act(() => { vi.advanceTimersByTime(2000); });
      expect(onPagesChange).toHaveBeenCalledTimes(1);
      expect(onPagesChange.mock.calls[0]![1]).toBeUndefined(); // no keepalive
    } finally {
      vi.useRealTimers();
    }
  });

  it("unmounting still flushes (the editor swapping notes), and the listeners go with it", () => {
    const onPagesChange = vi.fn();
    const { container, unmount } = render(<InkNodeView onPagesChange={onPagesChange} />);
    draw(container);
    unmount();
    expect(onPagesChange).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(onPagesChange).toHaveBeenCalledTimes(1);
  });
});
