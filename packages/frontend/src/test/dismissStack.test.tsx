import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDismiss, useEscapeKey } from "../hooks/useEscapeKey";
import { FakeCloseWatcher, installFakeCloseWatcher, liveWatchers, requestClose } from "./fakeCloseWatcher";

const esc = () => { const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); window.dispatchEvent(e); return e; };

describe("one stack for Esc and Back", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  describe("without CloseWatcher (Firefox): Esc closes the newest surface only", () => {
    it("goes newest first, one press each", () => {
      const closed: string[] = [];
      const a = renderHook(() => useDismiss(() => { closed.push("a"); }, true));
      const b = renderHook(() => useDismiss(() => { closed.push("b"); }, true));
      esc();
      expect(closed).toEqual(["b"]);
      b.unmount();
      esc();
      expect(closed).toEqual(["b", "a"]);
      a.unmount();
      esc();
      expect(closed).toEqual(["b", "a"]);
    });

    it("a surface that declines lets the one below take the key", () => {
      const closed: string[] = [];
      renderHook(() => useDismiss(() => { closed.push("below"); }, true));
      renderHook(() => useDismiss(() => false, true));
      expect(esc().defaultPrevented).toBe(true);
      expect(closed).toEqual(["below"]);
    });

    it("registers only while open", () => {
      const close = vi.fn();
      const { rerender } = renderHook(({ open }) => useDismiss(close, open), { initialProps: { open: false } });
      esc();
      expect(close).not.toHaveBeenCalled();
      rerender({ open: true });
      esc();
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  describe("with CloseWatcher (Chrome, Brave, Samsung Internet)", () => {
    beforeEach(() => { installFakeCloseWatcher(); });

    it("Back closes the newest surface; the one under it stays until the next Back", () => {
      const closed: string[] = [];
      renderHook(() => useDismiss(() => { closed.push("panel"); }, true));
      const menu = renderHook(({ open }) => useDismiss(() => { closed.push("menu"); }, open), { initialProps: { open: true } });
      requestClose();
      expect(closed).toEqual(["menu"]);
      menu.rerender({ open: false });
      requestClose();
      expect(closed).toEqual(["menu", "panel"]);
      expect(requestClose()).toBe(false); // nothing left: the browser's own Back
    });

    it("a closed surface leaves no watcher behind", () => {
      const { rerender, unmount } = renderHook(({ open }) => useDismiss(() => {}, open), { initialProps: { open: true } });
      expect(liveWatchers()).toHaveLength(1);
      rerender({ open: false });
      expect(liveWatchers()).toHaveLength(0);
      rerender({ open: true });
      unmount();
      expect(liveWatchers()).toHaveLength(0);
    });

    it("Esc is the browser's close request there: the key listener does not also close", () => {
      const close = vi.fn();
      renderHook(() => useDismiss(close, true));
      esc();
      expect(close).not.toHaveBeenCalled();
      requestClose();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("an Esc-only gesture above a surface takes the key and keeps the close request from also closing the surface", () => {
      const surface = vi.fn();
      const gesture = vi.fn();
      renderHook(() => useDismiss(surface, true));
      renderHook(() => useEscapeKey(() => { gesture(); }, true));
      expect(esc().defaultPrevented).toBe(true);
      expect(gesture).toHaveBeenCalledTimes(1);
      expect(surface).not.toHaveBeenCalled();
    });

    it("Back is not offered to an Esc-only gesture", () => {
      const gesture = vi.fn();
      renderHook(() => useEscapeKey(() => { gesture(); }, true));
      expect(FakeCloseWatcher.all).toHaveLength(0);
    });

    it("the handler learns it was Back", () => {
      const via = vi.fn();
      renderHook(() => useDismiss((v) => { via(v); }, true));
      requestClose();
      expect(via).toHaveBeenCalledWith("back");
    });
  });
});
