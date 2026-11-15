import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useZenMode } from "../hooks/useZenMode";

describe("writing mode lifecycle", () => {
  let fullscreen: Element | null;
  const changed = () => document.dispatchEvent(new Event("fullscreenchange"));
  const request = vi.fn(async () => { fullscreen = document.documentElement; changed(); });
  const exit = vi.fn(async () => { fullscreen = null; changed(); });
  beforeEach(() => {
    fullscreen = null;
    request.mockClear(); exit.mockClear();
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
    Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: request });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Escape restores the shell and exits fullscreen opened by writing mode", async () => {
    const { result } = renderHook(() => useZenMode());
    await act(async () => result.current[1]());
    expect(document.body.classList.contains("onden-zen")).toBe(true);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(result.current[0]).toBe(false);
    expect(exit).toHaveBeenCalledOnce();
    expect(document.body.classList.contains("onden-zen")).toBe(false);
  });

  it("browser-controlled fullscreen exit also restores the shell", async () => {
    const { result } = renderHook(() => useZenMode());
    await act(async () => result.current[1]());
    act(() => { fullscreen = null; changed(); });
    expect(result.current[0]).toBe(false);
    expect(document.body.classList.contains("onden-zen")).toBe(false);
  });

  it("still supports writing and a visible exit when fullscreen is refused", async () => {
    request.mockRejectedValueOnce(new Error("not permitted"));
    const { result } = renderHook(() => useZenMode());
    await act(async () => result.current[1]());
    expect(result.current[0]).toBe(true);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it("releases fullscreen that finishes opening after the editor unmounts", async () => {
    let resolve!: () => void;
    request.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
    const { result, unmount } = renderHook(() => useZenMode());
    act(() => result.current[1]());
    unmount();
    await act(async () => { fullscreen = document.documentElement; resolve(); });
    expect(exit).toHaveBeenCalledOnce();
    expect(document.body.classList.contains("onden-zen")).toBe(false);
  });

  it("leaves another surface's existing fullscreen alone", () => {
    fullscreen = document.createElement("div");
    const { result, unmount } = renderHook(() => useZenMode());
    act(() => result.current[1]());
    unmount();
    expect(request).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
