// swallowNextClick (lib/touchHold). It used to hold a timer that could fire after the page that started it was
// gone (public run 44074610697, 2026-11-17: `window` not defined, an unhandled error failing a run with every
// test passing). It now schedules nothing; touchHoldNoStrayTimers.test.tsx pins that.
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
});
