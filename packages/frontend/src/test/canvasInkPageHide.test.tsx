// The whiteboard's pen layer going away (close the tab, switch apps) must not take the strokes
// still waiting for the engine's debounce: they are saved at once, as a save that outlives the
// page (keepalive) — the same leaving save the handwriting page and the PDF already have.
import { idleBoardHistory } from "./helpers/boardHistory";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactFlowProvider } from "@xyflow/react";
import { INK_COLORS } from "../components/InkToolbar";
import { INK_SIZES } from "../lib/inkSizes";
import { useInkPen } from "../hooks/useInkPen";

const saveInk = vi.hoisted(() => vi.fn());
vi.mock("../lib/data", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/data")>()), saveInk }));
vi.mock("../lib/ink/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ink/store")>()),
  loadInkPage: vi.fn(async () => null),
}));

function pointer(type: string, o: { x: number; y: number; t: number }): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerId: 1, pointerType: "mouse", button: 0, clientX: o.x, clientY: o.y, pressure: 0.5, getCoalescedEvents: () => [] });
  Object.defineProperty(e, "timeStamp", { value: o.t });
  return e;
}

async function mountAndDraw() {
  const { default: CanvasInkLayer } = await import("../components/CanvasInkLayer");
  function Host() {
    const pen = useInkPen({ color: INK_COLORS[0].value, sizeId: INK_SIZES[1].id });
    return <ReactFlowProvider><CanvasInkLayer boardHistory={idleBoardHistory} canvasId="c1" penActive spaceHeld={false} pen={pen} /></ReactFlowProvider>;
  }
  const view = render(<Host />);
  await waitFor(() => expect(view.container.querySelector("[data-ink-renderer]")?.getAttribute("data-ink-renderer")).toBeTruthy());
  const capture = view.container.querySelector(".canvas-ink-capture") as HTMLElement;
  Object.assign(capture, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
  act(() => {
    capture.dispatchEvent(pointer("pointerdown", { x: 20, y: 20, t: 1000 }));
    capture.dispatchEvent(pointer("pointermove", { x: 60, y: 50, t: 1020 }));
    capture.dispatchEvent(pointer("pointerup", { x: 60, y: 50, t: 1040 }));
  });
  return view;
}

const hidden = (state: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("CanvasInkLayer when the page goes away", () => {
  beforeEach(() => {
    saveInk.mockClear();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, "visibilityState"); });

  it("pagehide saves the strokes still in the debounce, once, with keepalive", async () => {
    await mountAndDraw();
    expect(saveInk).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(saveInk).toHaveBeenCalledTimes(1);
    const [id, doc, , options] = saveInk.mock.calls[0]!;
    expect(id).toBe("c1");
    expect(doc.strokes).toHaveLength(1);
    expect(options).toMatchObject({ keepalive: true });
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(saveInk).toHaveBeenCalledTimes(1); // nothing left to save
  });

  it("switching away from the app (visibilitychange → hidden) saves them too", async () => {
    await mountAndDraw();
    act(() => { hidden("hidden"); });
    expect(saveInk).toHaveBeenCalledTimes(1);
    expect(saveInk.mock.calls[0]![3]).toMatchObject({ keepalive: true });
  });

  it("control: the stroke is really in the engine — unmounting flushes it, without keepalive", async () => {
    const view = await mountAndDraw();
    expect(saveInk).not.toHaveBeenCalled();
    view.unmount();
    expect(saveInk).toHaveBeenCalledTimes(1);
    expect(saveInk.mock.calls[0]![1].strokes).toHaveLength(1);
    expect(saveInk.mock.calls[0]![3]?.keepalive).toBeUndefined();
  });
});
