// A phone (finger as the main input) is shown no keyboard hints.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useHasKeyboard, useKbdHint } from "../hooks/useKbdHint";

function pointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: coarse && query.includes("coarse"), media: query, addEventListener() {}, removeEventListener() {} }));
}
afterEach(() => vi.unstubAllGlobals());

describe("keyboard hints", () => {
  it("show on a mouse device", () => {
    pointer(false);
    expect(renderHook(() => useHasKeyboard()).result.current).toBe(true);
    expect(renderHook(() => useKbdHint("open-palette")).result.current).not.toBe("");
  });
  it("are empty on a touch device", () => {
    pointer(true);
    expect(renderHook(() => useHasKeyboard()).result.current).toBe(false);
    expect(renderHook(() => useKbdHint("open-palette")).result.current).toBe("");
  });
});
