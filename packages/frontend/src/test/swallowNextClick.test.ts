// swallowNextClick (lib/touchHold). It used to hold a timer that could fire after the page that started it was
// gone (public run 44074610697, 2026-11-17: `window` not defined, an unhandled error failing a run with every
// test passing). It now schedules nothing; touchHoldNoStrayTimers.test.tsx pins that.
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginTouchHold, createTouchPressGuard, HOLD_MS, swallowNextClick } from "../lib/touchHold";

describe("swallowNextClick", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("swallows the next click, once", () => {
    swallowNextClick();
    const first = new MouseEvent("click", { cancelable: true });
    window.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    const second = new MouseEvent("click", { cancelable: true });
    window.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
  });

  it("ends without touching the window, so a window torn down by then cannot fail it (public run 44675180019)", () => {
    vi.useFakeTimers();
    const host = window;
    swallowNextClick(500);
    const removeEventListener = host.removeEventListener;
    // @ts-expect-error a torn-down window has lost its methods
    host.removeEventListener = undefined;
    try {
      expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    } finally { host.removeEventListener = removeEventListener; }
    const late = new MouseEvent("click", { cancelable: true });
    window.dispatchEvent(late);
    expect(late.defaultPrevented).toBe(false); // the swallow is over
  });
});

describe("what a swallow or a hold leaves behind", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("a hold whose element left the page before the lift does not lift; it is aborted and takes its listeners off", () => {
    vi.useFakeTimers();
    const row = document.createElement("div");
    document.body.append(row);
    const h = { onLift: vi.fn(), onDrag: vi.fn(), onRelease: vi.fn(), onAbort: vi.fn() };
    const down = new PointerEvent("pointerdown", { pointerType: "touch", button: 0, bubbles: true });
    row.addEventListener("pointerdown", (e) => { beginTouchHold(e, createTouchPressGuard(), h); });
    row.dispatchEvent(down);
    row.remove();
    const removed = vi.spyOn(window, "removeEventListener");
    vi.advanceTimersByTime(HOLD_MS);
    expect(h.onLift).not.toHaveBeenCalled();
    expect(h.onAbort).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith("pointerup", expect.any(Function));
  });
});
