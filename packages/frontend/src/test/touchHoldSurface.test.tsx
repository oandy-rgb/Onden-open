import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { beginTouchHold, createTouchPressGuard, holdSurface, HOLD_MS } from "../lib/touchHold";

// Chromium makes a touch sequence cancelable only if a non-passive touchstart listener exists when the
// finger lands (see holdSurface). jsdom cannot show that, so this checks the listener and the preventDefault timing.

describe("holdSurface", () => {
  it("puts a non-passive touchstart listener on the container, once, and does not cancel anything", () => {
    const el = document.createElement("div");
    const add = vi.spyOn(el, "addEventListener");
    holdSurface(el);
    holdSurface(el);
    expect(add).toHaveBeenCalledWith("touchstart", expect.any(Function), { passive: false });
    const listener = add.mock.calls[0]![1] as EventListener;
    const start = new Event("touchstart", { cancelable: true });
    el.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(false);
    expect(add.mock.calls.every(([, fn]) => fn === listener)).toBe(true); // same function: the DOM keeps one
    expect(() => holdSurface(null)).not.toThrow();
  });
});

describe("beginTouchHold touchmove", () => {
  beforeEach(() => { vi.useFakeTimers(); navigator.vibrate = vi.fn(() => true); });
  afterEach(() => { act(() => { vi.runOnlyPendingTimers(); }); vi.useRealTimers(); });

  function start() {
    const handlers = { onLift: vi.fn(), onDrag: vi.fn(), onRelease: vi.fn(), onAbort: vi.fn() };
    const down = new PointerEvent("pointerdown", { pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    beginTouchHold(down, createTouchPressGuard(), handlers);
    return handlers;
  }
  const touchMove = (cancelable: boolean) => {
    const ev = new Event("touchmove", { cancelable });
    window.dispatchEvent(ev);
    return ev;
  };

  it("lets a cancelable touchmove through before the lift and stops it after", () => {
    const h = start();
    expect(touchMove(true).defaultPrevented).toBe(false);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    expect(h.onLift).toHaveBeenCalled();
    expect(touchMove(true).defaultPrevented).toBe(true);
    expect(h.onAbort).not.toHaveBeenCalled();
  });

  it("gives up on a non-cancelable touchmove (the browser is already scrolling)", () => {
    const h = start();
    touchMove(false);
    expect(h.onAbort).toHaveBeenCalledTimes(1);
  });
});
