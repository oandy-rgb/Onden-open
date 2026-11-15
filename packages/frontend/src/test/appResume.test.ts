import { describe, it, expect, vi } from "vitest";
import { onAppResume } from "../lib/appResume";

describe("onAppResume", () => {
  it("runs on becoming visible and on the network returning, not on hiding", () => {
    const check = vi.fn();
    const off = onAppResume(check);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(check).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    expect(check).toHaveBeenCalledTimes(2);
    off();
    window.dispatchEvent(new Event("online"));
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("a page restored from the back/forward cache counts as coming back (phone browsers)", () => {
    const check = vi.fn();
    const off = onAppResume(check);
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(check).toHaveBeenCalledTimes(1);
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    expect(check).toHaveBeenCalledTimes(1);
    off();
  });
});
