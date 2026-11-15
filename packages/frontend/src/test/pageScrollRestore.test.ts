import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearPageScrollMemory, consumeScrollTarget, markBackNavigation, rememberPageScroll, restoreWhenTall } from "../lib/pageScrollRestore";
import { renderHook } from "@testing-library/react";
import { usePageScrollRestore } from "../hooks/usePageScrollRestore";

describe("pageScrollRestore", () => {
  beforeEach(() => clearPageScrollMemory());

  it("restores the remembered position only after a Back", () => {
    rememberPageScroll("notes|list|", 1600.4);
    markBackNavigation();
    expect(consumeScrollTarget("notes|list|")).toBe(1600);
  });

  it("starts a forward navigation at the top and forgets the stale position", () => {
    rememberPageScroll("notes|edit|a", 500);
    expect(consumeScrollTarget("notes|edit|a")).toBe(0);
    markBackNavigation();
    expect(consumeScrollTarget("notes|edit|a")).toBe(0);
  });

  it("consumes the Back mark once", () => {
    rememberPageScroll("k", 300);
    markBackNavigation();
    consumeScrollTarget("other");
    expect(consumeScrollTarget("k")).toBe(0);
  });
});

describe("restoreWhenTall", () => {
  let scrollTo: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(5000);
    vi.stubGlobal("innerHeight", 800);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("scrolls at once when the page is tall enough: a screen painted first would show at the wrong place for a frame", () => {
    const cancel = restoreWhenTall(1600);
    expect(scrollTo).toHaveBeenCalledWith(0, 1600); // before any animation frame
    cancel();
  });

  it("with a page not tall enough yet, goes as far as it can now and the rest as it grows", async () => {
    const height = vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(1000);
    const cancel = restoreWhenTall(3000);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 200);
    height.mockReturnValue(5000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 3000);
    cancel();
  });
});

describe("usePageScrollRestore owns the scroll on a phone", () => {
  beforeEach(() => { vi.stubGlobal("scrollTo", vi.fn()); window.history.scrollRestoration = "auto"; });
  afterEach(() => { vi.unstubAllGlobals(); window.history.scrollRestoration = "auto"; });

  it("takes the restoring from the browser (it would move the page again after the app did) and gives it back", () => {
    const phone = renderHook(() => usePageScrollRestore("notes|list|", true));
    expect(window.history.scrollRestoration).toBe("manual");
    phone.unmount();
    expect(window.history.scrollRestoration).toBe("auto");
  });

  it("leaves the browser's restoring alone where the page does not own the scroll (desktop panes)", () => {
    renderHook(() => usePageScrollRestore("notes|list|", false));
    expect(window.history.scrollRestoration).toBe("auto");
  });
});
