import { afterEach, describe, expect, it } from "vitest";
import { pixelRatio, windowGlobal } from "./pageEnvironment";

afterEach(() => { delete (window as unknown as Record<string, unknown>).__X__; });

describe("pageEnvironment", () => {
  it("pixelRatio falls back to 1", () => {
    const real = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: 0, configurable: true });
    expect(pixelRatio()).toBe(1);
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    expect(pixelRatio()).toBe(2);
    Object.defineProperty(window, "devicePixelRatio", { value: real, configurable: true });
  });

  it("windowGlobal reads an untyped global", () => {
    expect(windowGlobal<string>("__X__")).toBeUndefined();
    (window as unknown as Record<string, string>).__X__ = "v";
    expect(windowGlobal<string>("__X__")).toBe("v");
  });
});
