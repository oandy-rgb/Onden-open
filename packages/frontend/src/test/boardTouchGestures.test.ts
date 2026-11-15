// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { attachBoardTouchGestures } from "../lib/boardTouchGestures";
import { BOX_SELECT_HOLD_MS as HOLD_MS, HOLD_SLOP as HOLD_SLOP_PX } from "../lib/touchHold";

// A pane and a card inside the board's wrapper. React Flow's pane listens for pointer-downs (box start) and
// pointer-ups (box end); the spies stand in for it.
let wrap: HTMLElement, pane: HTMLElement, card: HTMLElement;
let paneDown: Mock<(e: PointerEvent) => void>, paneUp: Mock<(e: PointerEvent) => void>, armedLog: boolean[], cancelled: Mock<() => void>;
let enabled = true;
let detach = () => {};

function pointer(type: string, target: Element, init: { id?: number; kind?: string; x?: number; y?: number } = {}) {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: init.id ?? 1, pointerType: init.kind ?? "touch", isPrimary: (init.id ?? 1) === 1, button: 0, clientX: init.x ?? 100, clientY: init.y ?? 100 });
  target.dispatchEvent(event);
  return event;
}
function touchMoveReaches(target: Element, touches = 1) {
  const reached = vi.fn();
  target.addEventListener("touchmove", reached);
  const event = new Event("touchmove", { bubbles: true, cancelable: true }) as Event & { touches: unknown[] };
  event.touches = Array.from({ length: touches }, () => ({}));
  target.dispatchEvent(event);
  target.removeEventListener("touchmove", reached);
  return reached.mock.calls.length > 0;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `<div id="wrap"><div class="react-flow__pane"></div><div class="react-flow__node"></div></div>`;
  wrap = document.getElementById("wrap")!;
  pane = wrap.querySelector(".react-flow__pane")!;
  card = wrap.querySelector(".react-flow__node")!;
  paneDown = vi.fn<(e: PointerEvent) => void>(); paneUp = vi.fn<(e: PointerEvent) => void>(); cancelled = vi.fn<() => void>(); armedLog = []; enabled = true;
  // React's root listener sits below window in the capture order; the wrapper stands in for it.
  wrap.addEventListener("pointerdown", paneDown);
  wrap.addEventListener("pointerup", paneUp);
  detach = attachBoardTouchGestures({ container: wrap, isEnabled: () => enabled, onArmedChange: (a) => armedLog.push(a), onSelectionCancelled: cancelled });
});
afterEach(() => { detach(); vi.useRealTimers(); });

describe("one finger on the bare pane", () => {
  it("drags the board: the pane never gets a box-starting pointer-down", () => {
    pointer("pointerdown", pane);
    pointer("pointermove", pane, { x: 100 + HOLD_SLOP_PX + 20 });
    vi.advanceTimersByTime(HOLD_MS * 2);
    pointer("pointerup", pane);
    expect(paneDown).not.toHaveBeenCalled();
    expect(armedLog).toEqual([]);
  });

  it("a tap that lifts before the hold starts no box, and the pane still gets the tap (to deselect)", () => {
    pointer("pointerdown", pane, { x: 70, y: 80 });
    vi.advanceTimersByTime(HOLD_MS - 50);
    pointer("pointerup", pane, { x: 70, y: 80 });
    vi.advanceTimersByTime(HOLD_MS);
    expect(armedLog).toEqual([]);
    expect(cancelled).not.toHaveBeenCalled();
    // one replayed down/up pair from the tap's spot (the finger's own pointer-up follows it)
    expect(paneDown).toHaveBeenCalledTimes(1);
    expect(paneUp.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect([paneDown.mock.calls[0][0].clientX, paneDown.mock.calls[0][0].clientY]).toEqual([70, 80]);
  });

  it("press and hold, then drag, draws the box: the pane gets the pointer-down at the same spot and the pan stops", () => {
    pointer("pointerdown", pane, { x: 40, y: 60 });
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(paneDown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(armedLog).toEqual([true]);
    expect(paneDown).toHaveBeenCalledTimes(1);
    const replayed = paneDown.mock.calls[0][0];
    expect([replayed.clientX, replayed.clientY, replayed.pointerType, replayed.button]).toEqual([40, 60, "touch", 0]);
    // the finger's touch moves no longer reach the pan; a pinch's moves still do
    expect(touchMoveReaches(pane, 1)).toBe(false);
    expect(touchMoveReaches(pane, 2)).toBe(true);
    pointer("pointerup", pane);
    expect(armedLog).toEqual([true, false]);
    expect(touchMoveReaches(pane, 1)).toBe(true);
  });

  it("moving a little during the hold still counts as a hold", () => {
    pointer("pointerdown", pane);
    pointer("pointermove", pane, { x: 100 + HOLD_SLOP_PX - 1 });
    vi.advanceTimersByTime(HOLD_MS);
    expect(armedLog).toEqual([true]);
  });
});

describe("a second finger", () => {
  it("before the hold: a pinch, no box ever opens", () => {
    pointer("pointerdown", pane, { id: 1 });
    vi.advanceTimersByTime(100);
    pointer("pointerdown", pane, { id: 2, x: 200 });
    vi.advanceTimersByTime(HOLD_MS * 2);
    // only the second, non-primary finger reaches the pane, and React Flow ignores a non-primary pointer
    expect(paneDown.mock.calls.map(([e]) => e.pointerId)).toEqual([2]);
    expect(armedLog).toEqual([]);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("while a box is open: the box is closed and the selection handed back at once", () => {
    pointer("pointerdown", pane, { id: 1 });
    vi.advanceTimersByTime(HOLD_MS);
    paneUp.mockClear();
    pointer("pointerdown", pane, { id: 2, x: 200 });
    expect(armedLog).toEqual([true, false]);
    expect(paneUp).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(touchMoveReaches(pane, 2)).toBe(true);
    // the opened box does not come back when the first finger lifts
    pointer("pointerup", pane, { id: 1 });
    pointer("pointerup", pane, { id: 2 });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});

describe("what is left alone", () => {
  it("a tap on a card reaches the card (selects it) untouched", () => {
    pointer("pointerdown", card);
    expect(paneDown).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(armedLog).toEqual([]);
    expect(paneDown).toHaveBeenCalledTimes(1);
  });

  it("a mouse keeps its drag-to-select and a stylus is not a finger", () => {
    for (const kind of ["mouse", "pen"]) {
      paneDown.mockClear();
      pointer("pointerdown", pane, { kind });
      expect(paneDown).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(HOLD_MS * 2);
      pointer("pointerup", pane, { kind });
    }
    expect(armedLog).toEqual([]);
  });

  it("does nothing while the tool is not select-like (pen, hand)", () => {
    enabled = false;
    pointer("pointerdown", pane);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(armedLog).toEqual([]);
  });

  it("detaching removes every listener", () => {
    detach();
    pointer("pointerdown", pane);
  });
});
