// @vitest-environment jsdom
// The desktop side-pane handles: drag / keys / double-click end in one stored
// width per pane, the middle keeps 360px, and nothing shows without side columns.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import ColumnResizer from "../components/ui/ColumnResizer";
import PaneResizer from "../components/ui/PaneResizer";
import { fitPaneWidths, maxPaneWidth, setPaneWidth, useColumnWidth, usePaneWidthVars, type PaneColumn } from "../lib/paneWidths";
import { PREFS } from "../lib/prefs";

const BOTH = { sidebar: true, inspector: true };

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  act(() => { window.dispatchEvent(new Event("resize")); });
}

function Page({ inspector = true, sidebar = true }: { inspector?: boolean; sidebar?: boolean }) {
  usePaneWidthVars({ sidebar, inspector });
  return <><aside><PaneResizer side="sidebar" /></aside><aside><PaneResizer side="inspector" /></aside></>;
}

const sidebar = () => screen.getByRole("separator", { name: /sidebar|側欄/i });
const inspector = () => screen.getByRole("separator", { name: /info pane|資訊欄/i });
const now = (el: HTMLElement) => Number(el.getAttribute("aria-valuenow"));

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  setViewport(1920);
  act(() => { setPaneWidth("sidebar", null); setPaneWidth("inspector", null); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("PaneResizer", () => {
  it("is an accessible vertical separator with limits", () => {
    render(<Page />);
    const el = sidebar();
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
    expect(el.tabIndex).toBe(0);
    expect(el.getAttribute("aria-valuemin")).toBe("180");
    expect(el.getAttribute("aria-valuemax")).toBe("480");
    expect(inspector().getAttribute("aria-valuemin")).toBe("240");
    expect(inspector().getAttribute("aria-valuemax")).toBe("560");
  });

  it("drags the sidebar wider, stores it and publishes the CSS variable", () => {
    render(<Page />);
    const el = sidebar();
    fireEvent.pointerDown(el, { clientX: 240, pointerId: 1, button: 0 });
    expect(document.body.classList.contains("onden-pane-dragging")).toBe(true);
    fireEvent.pointerMove(el, { clientX: 360, pointerId: 1 });
    expect(now(el)).toBe(360);
    expect(localStorage.getItem("onden.sidebarWidth")).toBe("360");
    expect(document.documentElement.style.getPropertyValue("--onden-sidebar-width")).toBe("360px");
    fireEvent.pointerUp(el, { pointerId: 1 });
    expect(document.body.classList.contains("onden-pane-dragging")).toBe(false);
  });

  it("drags the inspector's left edge: moving left widens it", () => {
    render(<Page />);
    const el = inspector();
    const start = now(el);
    fireEvent.pointerDown(el, { clientX: 1500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(el, { clientX: 1400, pointerId: 1 });
    expect(now(el)).toBe(start + 100);
  });

  it("stops at each pane's own limits", () => {
    render(<Page />);
    const el = sidebar();
    fireEvent.pointerDown(el, { clientX: 240, pointerId: 1, button: 0 });
    fireEvent.pointerMove(el, { clientX: 2000, pointerId: 1 });
    expect(now(el)).toBe(480);
    fireEvent.pointerMove(el, { clientX: -2000, pointerId: 1 });
    expect(now(el)).toBe(180);
  });

  it("keeps 360px for the middle: the other pane's room is not taken", () => {
    setViewport(1100);
    render(<Page />);
    fireEvent.keyDown(inspector(), { key: "End" });
    // 1100 - 360 - sidebar 240
    expect(now(inspector())).toBe(500);
    expect(Number(sidebar().getAttribute("aria-valuemax"))).toBe(1100 - 360 - 500);
  });

  it("double-click returns to the default and forgets the stored width", () => {
    render(<Page />);
    fireEvent.keyDown(sidebar(), { key: "End" });
    expect(localStorage.getItem("onden.sidebarWidth")).toBe("480");
    fireEvent.doubleClick(sidebar());
    expect(localStorage.getItem("onden.sidebarWidth")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--onden-sidebar-width")).toBe("");
  });

  it("moves 16px per arrow key and jumps with Home / End", () => {
    render(<Page />);
    const el = sidebar();
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(now(el)).toBe(256);
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(now(el)).toBe(224);
    fireEvent.keyDown(el, { key: "Home" });
    expect(now(el)).toBe(180);
    fireEvent.keyDown(el, { key: "End" });
    expect(now(el)).toBe(480);
    const right = inspector();
    const before = now(right);
    fireEvent.keyDown(right, { key: "ArrowLeft" });
    expect(now(right)).toBe(before + 16);
  });

  it("reads the stored width on load and falls back to the default when storage throws", async () => {
    localStorage.setItem("onden.sidebarWidth", "333");
    vi.resetModules();
    const fresh = await import("../lib/paneWidths");
    expect(fresh.fitPaneWidths({ sidebar: 333, inspector: null }, 1920, BOTH).sidebar).toBe(333);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    vi.resetModules();
    const blocked = await import("../lib/paneWidths");
    const { default: Resizer } = await import("../components/ui/PaneResizer");
    render(<Resizer side="sidebar" />);
    expect(now(sidebar())).toBe(blocked.PANE_LIMITS.sidebar.fallback);
    expect(() => fireEvent.keyDown(sidebar(), { key: "ArrowRight" })).not.toThrow();
  });

  it("shows no handle without side columns (900px and below)", () => {
    setViewport(900);
    render(<Page />);
    expect(screen.queryAllByRole("separator")).toHaveLength(0);
    expect(document.documentElement.style.getPropertyValue("--onden-sidebar-width")).toBe("");
  });
});

describe("fitPaneWidths", () => {
  it("squeezes stored widths to keep the middle without changing what is stored", () => {
    const fit = fitPaneWidths({ sidebar: 480, inspector: 560 }, 1200, BOTH);
    expect(fit.sidebar! + fit.inspector!).toBe(1200 - 360);
    expect(fit.sidebar!).toBeGreaterThanOrEqual(180);
    expect(fit.inspector!).toBeGreaterThanOrEqual(240);
  });
  it("leaves widths alone when there is room, and unset stays unset", () => {
    expect(fitPaneWidths({ sidebar: 300, inspector: null }, 1920, BOTH)).toEqual({ sidebar: 300, inspector: null });
  });
  it("gives the whole budget to the sidebar when the inspector is hidden", () => {
    expect(fitPaneWidths({ sidebar: 480, inspector: null }, 900, { sidebar: true, inspector: false }).sidebar).toBe(480);
  });
  it("gives a folded sidebar's room to the info pane", () => {
    const hidden = { sidebar: false, inspector: true };
    // 1000px: with the list folded the pane keeps its 560; counting the list's 480 it would be squeezed to 240.
    expect(fitPaneWidths({ sidebar: 480, inspector: 560 }, 1000, hidden).inspector).toBe(560);
    expect(fitPaneWidths({ sidebar: 480, inspector: 560 }, 1000, BOTH).inspector).toBeLessThan(560);
    expect(maxPaneWidth("inspector", { sidebar: 480, inspector: 300 }, 1000, hidden)).toBe(560);
    expect(maxPaneWidth("inspector", { sidebar: 480, inspector: 300 }, 1000, BOTH)).toBeLessThan(560);
    expect(maxPaneWidth("sidebar", { sidebar: 300, inspector: 560 }, 1200, { sidebar: true, inspector: false })).toBe(480);
    expect(fitPaneWidths({ sidebar: 480, inspector: 560 }, 1000, hidden).sidebar).toBe(480); // folded: stored width passes through
  });
});

describe("ColumnResizer", () => {
  const COLUMN: PaneColumn = { min: 180, max: 560, fallback: 240, pref: PREFS.readerListWidth };
  function Reader() {
    const [width, setWidth] = useColumnWidth(COLUMN);
    return <main><aside><ColumnResizer column={COLUMN} width={width} onResize={setWidth} label="Resize list" /></aside></main>;
  }
  const handle = () => screen.getByRole("separator", { name: "Resize list" });
  const pageWidth = (px: number) => vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(px);

  it("stores the dragged width per device and goes back to the default on double-click", () => {
    render(<Reader />);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 240, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientX: 400, pointerId: 1 });
    expect(localStorage.getItem("onden.readerListWidth")).toBe("400");
    expect(now(handle())).toBe(400);

    fireEvent.doubleClick(handle());
    expect(localStorage.getItem("onden.readerListWidth")).toBeNull();
  });

  it("reads the stored width back and never folds the column", () => {
    localStorage.setItem("onden.readerListWidth", "333");
    render(<Reader />);
    expect(now(handle())).toBe(333);

    fireEvent.pointerDown(handle(), { button: 0, clientX: 333, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 0, pointerId: 1 });
    expect(handle().hasAttribute("data-collapsing")).toBe(false);
    fireEvent.pointerUp(handle(), { clientX: 0, pointerId: 1 });
    expect(localStorage.getItem("onden.readerListWidth")).toBe("180");
  });

  it("leaves the article its room on a narrow page", () => {
    pageWidth(700);
    render(<Reader />);
    expect(handle().getAttribute("aria-valuemax")).toBe("340");
    fireEvent.keyDown(handle(), { key: "End" });
    expect(localStorage.getItem("onden.readerListWidth")).toBe("340");
  });

  it("is not there without the desktop layout", () => {
    setViewport(800);
    render(<Reader />);
    expect(screen.queryByRole("separator")).toBeNull();
  });
});
