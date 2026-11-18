// touchHold's "swallow the click that follows a lift" must not leave a timer behind: a timer outlives the
// element (and the test's jsdom), and when it fires `window` is gone (ReferenceError, 2026-11-17 CI).
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLongPress } from "../hooks/useLongPress";
import { createTouchPressGuard, swallowNextClick } from "../lib/touchHold";

afterEach(() => vi.useRealTimers());

const click = () => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
};

describe("touchHold leaves no timer behind", () => {
  it("swallowNextClick: swallows the click right after, not one after its time, and schedules nothing", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    swallowNextClick(500);
    expect(vi.getTimerCount()).toBe(0);
    expect(click()).toBe(true);
    swallowNextClick(500);
    vi.advanceTimersByTime(501);
    expect(click()).toBe(false);
  });
  it("swallowNextClick: a fake clock swapped for the real one does not leave a click swallowed", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.advanceTimersByTime(10_000);
    swallowNextClick(500);
    vi.useRealTimers();
    expect(click()).toBe(false);
  });
  it("swallowNextClick: repeated calls do not pile up listeners", () => {
    const add = vi.spyOn(window, "addEventListener");
    for (let i = 0; i < 5; i++) swallowNextClick(500);
    expect(add.mock.calls.filter(([type]) => type === "click")).toHaveLength(1);
    click();
    add.mockRestore();
  });
  it("the press guard keeps swallowing the trailing contextmenu for a moment after the lift, with no timer", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const guard = createTouchPressGuard();
    guard.begin();
    guard.end();
    expect(vi.getTimerCount()).toBe(0);
    const ev = { preventDefault: vi.fn() };
    expect(guard.swallow(ev)).toBe(true);
    vi.advanceTimersByTime(401);
    expect(guard.swallow(ev)).toBe(false);
  });
  it("useLongPress: an element that goes away mid-press takes its timer with it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const onLongPress = vi.fn();
    const { result, unmount } = renderHook(() => useLongPress(onLongPress));
    result.current.onPointerDown({ pointerType: "touch", button: 0, clientX: 1, clientY: 1 } as never);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
