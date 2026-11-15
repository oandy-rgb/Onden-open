// Pens on every device (docs/architecture "各裝置的筆"): the iPad Safari event
// sequences that must never switch tools, the hover preview, coalesced events,
// and the native-shell entry. iPad itself is untested on a device: these are the
// sequences WebKit documents, replayed in jsdom.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { InkEngine } from "../lib/ink/engine";
import type { ICommittedRenderer } from "../lib/ink/committed";
import { PEN_HOVER_IDLE_MS } from "../lib/ink/penHover";
import { emitPenShortcut, installPenShortcutBridge, PEN_SHORTCUT_EVENT } from "../lib/penShortcutBridge";
import { usePenShortcutTool } from "../lib/ink";
import type { InkActiveTool } from "../lib/ink/types";

function stubRenderer(): ICommittedRenderer {
  return { kind: "canvas2d", commitStrokes() {}, setView() {}, resize() {}, destroy() {} };
}

function pointer(
  type: string,
  o: { id?: number; pointerType: string; x?: number; y?: number; buttons?: number; t: number; coalesced?: Array<{ x: number; y: number }> },
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, {
    pointerId: o.id ?? 1,
    pointerType: o.pointerType,
    button: 0,
    buttons: o.buttons ?? 0,
    clientX: o.x ?? 0,
    clientY: o.y ?? 0,
    pressure: 0.4,
  });
  if (o.coalesced) {
    Object.assign(e, {
      getCoalescedEvents: () => o.coalesced!.map((c) => ({ clientX: c.x, clientY: c.y, pressure: 0.4, pointerType: o.pointerType })),
    });
  }
  Object.defineProperty(e, "timeStamp", { value: o.t });
  return e;
}

/** Safari's contextmenu is a plain MouseEvent: no pointerType property at all. */
function safariContextMenu(t: number): Event {
  const e = new Event("contextmenu", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "timeStamp", { value: t });
  return e;
}

let frames: FrameRequestCallback[] = [];
const flushFrames = () => { const run = frames; frames = []; run.forEach((cb) => cb(0)); };

function makeEngine(onPenShortcut?: () => void) {
  const el = document.createElement("div");
  Object.assign(el, { setPointerCapture() {}, releasePointerCapture() {} });
  document.body.appendChild(el);
  const engine = new InkEngine({
    committedRenderer: stubRenderer(),
    wetCanvas: document.createElement("canvas"),
    manageCanvasSize: false,
    onPenShortcut,
  });
  engine.addPointerHandlers(el);
  return { engine, el };
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("iPad Safari sequences never switch tools", () => {
  it("Pencil hover (M2+): pen moves with buttons 0, for seconds", () => {
    const onPenShortcut = vi.fn();
    const { el } = makeEngine(onPenShortcut);
    for (let t = 0; t < 3000; t += 16) el.dispatchEvent(pointer("pointermove", { pointerType: "pen", x: t / 10, y: 5, t }));
    expect(onPenShortcut).not.toHaveBeenCalled();
  });

  it("Pencil stroke: hover, down, moves, up, hover again", () => {
    const onPenShortcut = vi.fn();
    const { el, engine } = makeEngine(onPenShortcut);
    el.dispatchEvent(pointer("pointermove", { pointerType: "pen", t: 0 }));
    el.dispatchEvent(pointer("pointerdown", { pointerType: "pen", x: 10, y: 10, buttons: 1, t: 20 }));
    for (let t = 30; t < 400; t += 16) el.dispatchEvent(pointer("pointermove", { pointerType: "pen", x: t, y: 10, buttons: 1, t }));
    el.dispatchEvent(pointer("pointerup", { pointerType: "pen", x: 400, y: 10, t: 420 }));
    el.dispatchEvent(pointer("pointermove", { pointerType: "pen", x: 401, y: 10, t: 440 }));
    expect(engine.serialize().strokes).toHaveLength(1);
    expect(onPenShortcut).not.toHaveBeenCalled();
  });

  it("Pencil long-press: down, held still, menu while down", () => {
    const onPenShortcut = vi.fn();
    const { el } = makeEngine(onPenShortcut);
    el.dispatchEvent(pointer("pointerdown", { pointerType: "pen", x: 10, y: 10, buttons: 1, t: 1000 }));
    const menu = safariContextMenu(1600);
    el.dispatchEvent(menu);
    expect(onPenShortcut).not.toHaveBeenCalled();
    expect(menu.defaultPrevented).toBe(false);
  });

  it("Pencil long-press that iOS cancels first, menu well after the quiet window", () => {
    const onPenShortcut = vi.fn();
    const { el } = makeEngine(onPenShortcut);
    el.dispatchEvent(pointer("pointerdown", { pointerType: "pen", x: 10, y: 10, buttons: 1, t: 1000 }));
    el.dispatchEvent(pointer("pointercancel", { pointerType: "pen", t: 1500 }));
    const menu = safariContextMenu(1500 + 1200);
    el.dispatchEvent(menu);
    expect(onPenShortcut).not.toHaveBeenCalled();
    expect(menu.defaultPrevented).toBe(false);
  });

  it("finger long-press (callout / magnifier): touch down, cancelled, menu later", () => {
    const onPenShortcut = vi.fn();
    const { el } = makeEngine(onPenShortcut);
    el.dispatchEvent(pointer("pointerdown", { pointerType: "touch", x: 50, y: 50, t: 2000 }));
    el.dispatchEvent(pointer("pointercancel", { pointerType: "touch", t: 2500 }));
    const menu = safariContextMenu(2500 + 1300);
    el.dispatchEvent(menu);
    expect(onPenShortcut).not.toHaveBeenCalled();
    expect(menu.defaultPrevented).toBe(false);
  });

  it("finger scroll: touch down, many moves, up (or cancelled)", () => {
    const onPenShortcut = vi.fn();
    const { el } = makeEngine(onPenShortcut);
    el.dispatchEvent(pointer("pointerdown", { id: 3, pointerType: "touch", x: 50, y: 200, t: 3000 }));
    for (let t = 3010; t < 3400; t += 16) el.dispatchEvent(pointer("pointermove", { id: 3, pointerType: "touch", x: 50, y: 200 - (t - 3000) / 2, t }));
    el.dispatchEvent(pointer("pointercancel", { id: 3, pointerType: "touch", t: 3410 }));
    el.dispatchEvent(safariContextMenu(3410 + 900));
    expect(onPenShortcut).not.toHaveBeenCalled();
  });

  it("the S Pen press-and-hold contextmenu (no contact before it) still switches", () => {
    const onPenShortcut = vi.fn();
    const { el } = makeEngine(onPenShortcut);
    el.dispatchEvent(pointer("pointerdown", { pointerType: "pen", x: 10, y: 10, t: 100 }));
    el.dispatchEvent(pointer("pointerup", { pointerType: "pen", x: 10, y: 10, t: 200 }));
    el.dispatchEvent(safariContextMenu(5000));
    expect(onPenShortcut).toHaveBeenCalledTimes(1);
  });
});

describe("hover preview", () => {
  const marker = (el: HTMLElement) => el.querySelector<HTMLElement>("[data-pen-hover]");
  const hoverAt = (el: HTMLElement, x: number, y: number, t: number, pointerType = "pen") => {
    el.dispatchEvent(pointer("pointermove", { pointerType, x, y, t }));
    act(() => flushFrames());
  };

  it("appears under a hovering pen, follows it, and is a dot in the tool's colour and size", () => {
    const { el, engine } = makeEngine();
    engine.setColor("#ff0000");
    engine.setSize(8);
    hoverAt(el, 100, 60, 1);
    const m = marker(el)!;
    expect(m.dataset.penHover).toBe("dot");
    expect(m.style.display).toBe("block");
    expect(m.style.width).toBe("8px");
    expect(m.style.transform).toBe("translate(96px, 56px)");
    hoverAt(el, 120, 80, 17);
    expect(m.style.transform).toBe("translate(116px, 76px)");
  });

  it("the eraser shows a ring of its radius", () => {
    const { el, engine } = makeEngine();
    engine.setTool("eraser");
    hoverAt(el, 10, 10, 1);
    const m = marker(el)!;
    expect(m.dataset.penHover).toBe("ring");
    expect(m.style.width).toBe("24px");
    expect(m.style.background).toBe("transparent");
  });

  it("a mouse or a finger shows nothing", () => {
    const { el } = makeEngine();
    hoverAt(el, 10, 10, 1, "mouse");
    hoverAt(el, 10, 10, 2, "touch");
    expect(marker(el)).toBeNull();
  });

  it("the hand tool shows nothing", () => {
    const { el, engine } = makeEngine();
    engine.setTool("hand");
    hoverAt(el, 10, 10, 1);
    expect(marker(el)?.style.display ?? "none").toBe("none");
  });

  it("disappears when the pen touches down, and again on the hover after lifting", () => {
    const { el } = makeEngine();
    hoverAt(el, 10, 10, 1);
    el.dispatchEvent(pointer("pointerdown", { pointerType: "pen", x: 10, y: 10, buttons: 1, t: 20 }));
    expect(marker(el)!.style.display).toBe("none");
    el.dispatchEvent(pointer("pointermove", { pointerType: "pen", x: 30, y: 10, buttons: 1, t: 30 }));
    act(() => flushFrames());
    expect(marker(el)!.style.display).toBe("none"); // no marker while drawing
    el.dispatchEvent(pointer("pointerup", { pointerType: "pen", x: 30, y: 10, t: 40 }));
    hoverAt(el, 31, 10, 60);
    expect(marker(el)!.style.display).toBe("block");
  });

  it("disappears when the pen leaves the surface", () => {
    const { el } = makeEngine();
    hoverAt(el, 10, 10, 1);
    el.dispatchEvent(pointer("pointerleave", { pointerType: "pen", t: 5 }));
    expect(marker(el)!.style.display).toBe("none");
  });

  it("disappears after no hover event for a while", () => {
    vi.useFakeTimers();
    const { el } = makeEngine();
    hoverAt(el, 10, 10, 1);
    vi.advanceTimersByTime(PEN_HOVER_IDLE_MS - 50);
    expect(marker(el)!.style.display).toBe("block");
    hoverAt(el, 12, 10, 2); // still in range: the clock restarts
    vi.advanceTimersByTime(PEN_HOVER_IDLE_MS - 50);
    expect(marker(el)!.style.display).toBe("block");
    vi.advanceTimersByTime(100);
    expect(marker(el)!.style.display).toBe("none");
  });

  it("is removed with the engine's handlers", () => {
    const el = document.createElement("div");
    document.body.append(el);
    const engine = new InkEngine({ committedRenderer: stubRenderer(), wetCanvas: document.createElement("canvas"), manageCanvasSize: false });
    const dispose = engine.addPointerHandlers(el);
    hoverAt(el, 10, 10, 1);
    expect(marker(el)).not.toBeNull();
    dispose();
    expect(marker(el)).toBeNull();
  });
});

describe("smooth lines: coalesced events", () => {
  it("every coalesced point of a move becomes a stroke point", () => {
    const { engine, el } = makeEngine();
    el.dispatchEvent(pointer("pointerdown", { pointerType: "pen", x: 0, y: 0, buttons: 1, t: 1 }));
    el.dispatchEvent(pointer("pointermove", {
      pointerType: "pen", x: 40, y: 0, buttons: 1, t: 2,
      coalesced: [{ x: 10, y: 1 }, { x: 20, y: 2 }, { x: 30, y: 1 }, { x: 40, y: 0 }],
    }));
    el.dispatchEvent(pointer("pointerup", { pointerType: "pen", x: 40, y: 0, t: 3 }));
    const xs = engine.serialize().strokes[0].points.map((p) => p[0]);
    expect(xs).toEqual(expect.arrayContaining([10, 20, 30, 40]));
    expect(xs.length).toBeGreaterThanOrEqual(6);
  });

  it("without getCoalescedEvents the move itself is the point", () => {
    const { engine, el } = makeEngine();
    el.dispatchEvent(pointer("pointerdown", { pointerType: "pen", x: 0, y: 0, buttons: 1, t: 1 }));
    el.dispatchEvent(pointer("pointermove", { pointerType: "pen", x: 40, y: 0, buttons: 1, t: 2 }));
    el.dispatchEvent(pointer("pointerup", { pointerType: "pen", x: 40, y: 0, t: 3 }));
    expect(engine.serialize().strokes[0].points.map((p) => p[0])).toEqual([0, 40, 40]);
  });
});

describe("iPad Safari default behaviours", () => {
  it("the surface opts out of callout, selection and browser touch gestures", () => {
    // jsdom's CSS parser drops -webkit-* properties, so watch the calls.
    const set = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
    const { el } = makeEngine();
    expect(el.style.touchAction).toBe("none");
    expect(el.style.userSelect).toBe("none");
    expect(set).toHaveBeenCalledWith("-webkit-touch-callout", "none");
    expect(set).toHaveBeenCalledWith("-webkit-user-select", "none");
    set.mockRestore();
  });

  it("selectstart is cancelled; touchmove only while a pen is down", () => {
    const { el } = makeEngine();
    const select = new Event("selectstart", { bubbles: true, cancelable: true });
    el.dispatchEvent(select);
    expect(select.defaultPrevented).toBe(true);
    const finger = new Event("touchmove", { bubbles: true, cancelable: true });
    el.dispatchEvent(finger);
    expect(finger.defaultPrevented).toBe(false);
    el.dispatchEvent(pointer("pointerdown", { pointerType: "pen", x: 1, y: 1, buttons: 1, t: 1 }));
    const palm = new Event("touchmove", { bubbles: true, cancelable: true });
    el.dispatchEvent(palm);
    expect(palm.defaultPrevented).toBe(true);
    el.dispatchEvent(pointer("pointerup", { pointerType: "pen", x: 1, y: 1, t: 2 }));
    const after = new Event("touchmove", { bubbles: true, cancelable: true });
    el.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("a Pencil's pressure is kept as real pressure", () => {
    const { engine, el } = makeEngine();
    el.dispatchEvent(pointer("pointerdown", { pointerType: "pen", x: 0, y: 0, buttons: 1, t: 1 }));
    el.dispatchEvent(pointer("pointermove", { pointerType: "pen", x: 5, y: 0, buttons: 1, t: 2 }));
    el.dispatchEvent(pointer("pointerup", { pointerType: "pen", x: 5, y: 0, t: 3 }));
    const stroke = engine.serialize().strokes[0];
    expect(stroke.points.every((p) => p[2] === 0.4)).toBe(true);
  });
});

describe("native shell entry", () => {
  function useHost(initial: InkActiveTool = "pen", enabled = true) {
    const [tool, setTool] = useState<InkActiveTool>(initial);
    usePenShortcutTool(tool, setTool, enabled);
    return tool;
  }

  it("onden:pen-shortcut and window.ondenPenShortcut switch pen ↔ eraser", () => {
    installPenShortcutBridge();
    const { result } = renderHook(() => useHost());
    act(() => { window.dispatchEvent(new CustomEvent(PEN_SHORTCUT_EVENT, { detail: { source: "s-pen-button" }, cancelable: true })); });
    expect(result.current).toBe("eraser");
    let handled = false;
    act(() => { handled = window.ondenPenShortcut!("apple-pencil-double-tap"); });
    expect(handled).toBe(true);
    expect(result.current).toBe("pen");
  });

  it("two hosts: only one takes the shortcut", () => {
    const a = renderHook(() => useHost());
    const b = renderHook(() => useHost());
    act(() => { emitPenShortcut("apple-pencil-squeeze"); });
    expect([a.result.current, b.result.current].filter((t) => t === "eraser")).toHaveLength(1);
  });

  it("a disabled host ignores it, and with no host nothing happens", () => {
    const off = renderHook(() => useHost("pen", false));
    let handled = true;
    act(() => { handled = emitPenShortcut(); });
    expect(handled).toBe(false);
    expect(off.result.current).toBe("pen");
    off.unmount();
    expect(emitPenShortcut()).toBe(false);
  });
});
