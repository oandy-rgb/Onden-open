// @vitest-environment jsdom
import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useExpandedPane } from "../hooks/useExpandedPane";
import { bindAccountStorage } from "../lib/accountStorage";

beforeAll(() => { bindAccountStorage("u", ""); });

let fullscreenElement: Element | null = null;
function fakeFullscreen() {
  fullscreenElement = null;
  Object.defineProperty(document, "fullscreenElement", { get: () => fullscreenElement, configurable: true });
  const request = vi.fn(async () => { fullscreenElement = document.documentElement; document.dispatchEvent(new Event("fullscreenchange")); });
  const exit = vi.fn(async () => { fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange")); });
  Object.defineProperty(document.documentElement, "requestFullscreen", { value: request, configurable: true });
  Object.defineProperty(document, "exitFullscreen", { value: exit, configurable: true });
  return { request, exit };
}

afterEach(() => {
  localStorage.clear();
  delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
  delete (document as { exitFullscreen?: unknown }).exitFullscreen;
  delete (document as { fullscreenElement?: unknown }).fullscreenElement;
});

describe("useExpandedPane", () => {
  it("remembers each note's enlarged state across remounts (leave and return, reload)", () => {
    const first = renderHook(() => useExpandedPane("a"));
    expect(first.result.current.expanded).toBe(false);
    act(() => first.result.current.enter());
    expect(first.result.current.expanded).toBe(true);
    first.unmount();
    expect(renderHook(() => useExpandedPane("a")).result.current.expanded).toBe(true);
    expect(renderHook(() => useExpandedPane("b")).result.current.expanded).toBe(false);
  });

  it("switching to another note reads that note's own state", () => {
    const { result, rerender } = renderHook(({ id }) => useExpandedPane(id), { initialProps: { id: "a" } });
    act(() => result.current.enter());
    rerender({ id: "b" });
    expect(result.current.expanded).toBe(false);
    rerender({ id: "a" });
    expect(result.current.expanded).toBe(true);
  });

  it("asks the browser to fullscreen the whole page, and leaving the note keeps it", () => {
    const { request, exit } = fakeFullscreen();
    const { result, unmount } = renderHook(() => useExpandedPane("a"));
    act(() => result.current.enter());
    expect(request).toHaveBeenCalledTimes(1);
    expect(fullscreenElement).toBe(document.documentElement);
    unmount();
    expect(exit).not.toHaveBeenCalled();
    expect(fullscreenElement).toBe(document.documentElement);
  });

  it("the browser leaving fullscreen by itself keeps the enlargement", () => {
    fakeFullscreen();
    const { result } = renderHook(() => useExpandedPane("a"));
    act(() => result.current.enter());
    act(() => { fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange")); });
    expect(result.current.expanded).toBe(true);
  });

  it("exit and Esc end both and forget the note", () => {
    const { exit } = fakeFullscreen();
    const { result } = renderHook(() => useExpandedPane("a"));
    act(() => result.current.enter());
    act(() => result.current.exit());
    expect(result.current.expanded).toBe(false);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(renderHook(() => useExpandedPane("a")).result.current.expanded).toBe(false);

    act(() => result.current.enter());
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(result.current.expanded).toBe(false);
    expect(renderHook(() => useExpandedPane("a")).result.current.expanded).toBe(false);
  });

  it("an Esc already used (closing a menu, leaving a pen tool) does not shrink", () => {
    const { result } = renderHook(() => useExpandedPane("a"));
    act(() => result.current.enter());
    const used = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    used.preventDefault();
    act(() => { window.dispatchEvent(used); });
    expect(result.current.expanded).toBe(true);
  });

  it("works without fullscreen support or readable storage", () => {
    const { result } = renderHook(() => useExpandedPane("a"));
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    act(() => result.current.enter());
    expect(result.current.expanded).toBe(true);
    spy.mockRestore();
  });

  it("a PDF without a note id enlarges for this page only", () => {
    const { result } = renderHook(() => useExpandedPane(undefined));
    act(() => result.current.enter());
    expect(result.current.expanded).toBe(true);
    expect(localStorage.length).toBe(0);
  });
});
