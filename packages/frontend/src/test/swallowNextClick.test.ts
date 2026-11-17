// swallowNextClick (lib/touchHold): its timer can fire after the page that started it is gone. On CI the timer of
// timelineBlockDrag.test.tsx fired after the test's window was torn down and `window` was not defined: an unhandled
// error that failed the whole run with every test passing (public run 44074610697, 2026-11-17).
import { afterEach, describe, expect, it, vi } from "vitest";
import { swallowNextClick } from "../lib/touchHold";

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

  it("takes its listener off the window it started on, even when `window` is gone by then", () => {
    vi.useFakeTimers();
    const host = window;
    const removed = vi.spyOn(host, "removeEventListener");
    swallowNextClick(500);
    vi.stubGlobal("window", undefined);
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(removed).toHaveBeenCalledWith("click", expect.any(Function), true);
  });
});
