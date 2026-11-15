import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";
import { useVirtualKeyboard } from "../hooks/useVirtualKeyboard";
import { selectionBubblePosition } from "../lib/selectionBubble";

// A fake visualViewport the test resizes like an on-screen keyboard would.
function installViewport(height: number) {
  const listeners = new Set<() => void>();
  const vv = {
    height,
    offsetTop: 0,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return {
    resize(next: number) { vv.height = next; act(() => listeners.forEach((fn) => fn())); },
    pan(top: number) { vv.offsetTop = top; act(() => listeners.forEach((fn) => fn())); },
  };
}

function setCoarsePointer(coarse: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: coarse && query === "(pointer: coarse)",
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
});

describe("useVirtualKeyboard", () => {
  it("reports the keyboard opening and closing (Android Back closes it without a blur)", () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const vv = installViewport(800);
    const { result } = renderHook(() => useVirtualKeyboard(true));
    expect(result.current).toEqual({ open: false, inset: 0, height: 0 });

    vv.resize(450);
    expect(result.current).toEqual({ open: true, inset: 350, height: 350 });

    vv.resize(800);
    expect(result.current).toEqual({ open: false, inset: 0, height: 0 });
  });

  it("a pan of the visual viewport changes the inset but not the keyboard height", () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const vv = installViewport(800);
    const { result } = renderHook(() => useVirtualKeyboard(true));
    vv.resize(450);
    vv.pan(60);
    expect(result.current).toEqual({ open: true, inset: 290, height: 350 });
    vv.pan(0);
    expect(result.current).toEqual({ open: true, inset: 350, height: 350 });
  });

  it("detects the keyboard when the browser shrinks the whole layout", () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const vv = installViewport(800);
    const { result } = renderHook(() => useVirtualKeyboard(true));
    Object.defineProperty(window, "innerHeight", { value: 450, configurable: true });
    vv.resize(450);
    // The layout moved with the keyboard: nothing to lift the bar by, but it is open.
    expect(result.current).toEqual({ open: true, inset: 0, height: 0 });
  });

  it("ignores small viewport changes such as the URL bar collapsing", () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const vv = installViewport(800);
    const { result } = renderHook(() => useVirtualKeyboard(true));
    vv.resize(740);
    expect(result.current.open).toBe(false);
  });

  it("stays closed while inactive", () => {
    installViewport(400);
    const { result } = renderHook(() => useVirtualKeyboard(false));
    expect(result.current).toEqual({ open: false, inset: 0, height: 0 });
  });
});

describe("selectionBubblePosition", () => {
  const view = {
    coordsAtPos: (pos: number) => (pos === 5
      ? { left: 100, right: 110, top: 200, bottom: 220 }
      : { left: 300, right: 310, top: 260, bottom: 280 }),
  } as unknown as EditorView;

  it("sits above the selection start with a mouse", () => {
    setCoarsePointer(false);
    expect(selectionBubblePosition(view, 5, 9)).toEqual({ x: 100, y: 200, above: true });
  });

  it("goes below the selection end on touch, clear of the OS copy/paste menu", () => {
    setCoarsePointer(true);
    const at = selectionBubblePosition(view, 5, 9);
    expect(at).toEqual({ x: 100, y: 280 + 36 });
  });
});
