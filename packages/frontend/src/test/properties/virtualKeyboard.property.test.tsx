// Random keyboard sessions against hooks/useVirtualKeyboard.ts, on a browser that resizes the layout with the
// keyboard (Android resizes-content: innerHeight and the visual viewport shrink together). The bar that follows the
// keyboard is switched on at a random moment, e.g. after the keyboard is already up (scan 01 #7).
// Invariant: once active, `open` is "the tallest height seen is more than 150 px above the current one", however
// late the hook was switched on.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/virtualKeyboard

import { describe, expect, it, afterEach } from "vitest";
import fc from "fast-check";
import { act, renderHook } from "@testing-library/react";
import { useVirtualKeyboard } from "../../hooks/useVirtualKeyboard";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const params = { numRuns: Math.min(PROPS_RUNS, 100), seed: PROPS_SEED };
const FULL = 800;

class FakeViewport extends EventTarget {
  height = FULL;
  offsetTop = 0;
}
function install(): FakeViewport {
  const vv = new FakeViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: FULL });
  return vv;
}
const resizeTo = (vv: FakeViewport, h: number) => act(() => {
  vv.height = h;
  (window as unknown as { innerHeight: number }).innerHeight = h;
  vv.dispatchEvent(new Event("resize"));
});

afterEach(() => { Reflect.deleteProperty(window, "visualViewport"); });

describe("useVirtualKeyboard baseline (scan 01 #7)", () => {
  it("a bar switched on while the keyboard is already open still sees it close", () => {
    const vv = install();
    const { result, rerender } = renderHook(({ on }) => useVirtualKeyboard(on), { initialProps: { on: false } });
    resizeTo(vv, 500); // the keyboard opens (title tapped), the layout shrinks with it
    rerender({ on: true }); // the toolbar appears now
    expect(result.current.open).toBe(true);
    resizeTo(vv, FULL); // Android back key closes the keyboard
    expect(result.current.open).toBe(false);
  });

  it("random heights and a random moment of switching on: open = tallest seen minus current is over the threshold", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 300, max: FULL }), { minLength: 1, maxLength: 8 }), fc.nat(8), (heights, onAt) => {
      const vv = install();
      const { result, rerender, unmount } = renderHook(({ on }) => useVirtualKeyboard(on), { initialProps: { on: false } });
      const switchAt = Math.min(onAt, heights.length);
      let tallest = FULL;
      heights.forEach((h, i) => {
        if (i === switchAt) rerender({ on: true });
        resizeTo(vv, h);
        tallest = Math.max(tallest, h);
      });
      if (switchAt === heights.length) rerender({ on: true });
      const last = heights[heights.length - 1];
      expect(result.current.open).toBe(tallest - last > 150);
      unmount();
    }), params);
  });
});
