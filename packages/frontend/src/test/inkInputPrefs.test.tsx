// Retiring the hidden finger state: the old "fingers pan" settings are carried
// over VISIBLY (stylus mode on + a notice), never silently kept or dropped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const addToast = vi.fn();
vi.mock("../lib/appStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/appStore")>()),
  addToast: (...args: unknown[]) => addToast(...args),
}));

import { migrateLegacyFingerPrefs, useInkInputPrefs } from "../hooks/useInkInputPrefs";

const MODE = "onden.ink.fingerMode";
const SEEN = "onden.ink.penSeen";
const STYLUS = "onden.ink.stylusOnly";

beforeEach(() => { localStorage.clear(); addToast.mockClear(); });
afterEach(() => localStorage.clear());

describe("migrateLegacyFingerPrefs", () => {
  it("nothing stored: nothing happens, stylus mode stays at its default (off)", () => {
    expect(migrateLegacyFingerPrefs()).toBe(false);
    expect(localStorage.getItem(STYLUS)).toBeNull();
  });

  it("an iPad that had seen a pen (auto + penSeen): stylus mode ON, old keys gone", () => {
    localStorage.setItem(MODE, "auto");
    localStorage.setItem(SEEN, "1");
    expect(migrateLegacyFingerPrefs()).toBe(true);
    expect(localStorage.getItem(STYLUS)).toBe("1");
    expect(localStorage.getItem(MODE)).toBeNull();
    expect(localStorage.getItem(SEEN)).toBeNull();
  });

  it("fingers pinned to pan (the old hand toggle): stylus mode ON", () => {
    localStorage.setItem(MODE, "pan");
    localStorage.setItem(SEEN, "0");
    expect(migrateLegacyFingerPrefs()).toBe(true);
    expect(localStorage.getItem(STYLUS)).toBe("1");
  });

  it("fingers drew before (auto without pen, or 'draw' even with a pen): they still draw", () => {
    localStorage.setItem(MODE, "auto");
    localStorage.setItem(SEEN, "0");
    expect(migrateLegacyFingerPrefs()).toBe(false);
    expect(localStorage.getItem(STYLUS)).toBeNull();
    localStorage.setItem(MODE, "draw");
    localStorage.setItem(SEEN, "1");
    expect(migrateLegacyFingerPrefs()).toBe(false);
    expect(localStorage.getItem(STYLUS)).toBeNull();
  });

  it("runs once, and never overwrites a choice already made with the new setting", () => {
    localStorage.setItem(MODE, "pan");
    expect(migrateLegacyFingerPrefs()).toBe(true);
    expect(migrateLegacyFingerPrefs()).toBe(false);
    localStorage.setItem(MODE, "pan");
    localStorage.setItem(STYLUS, "0");
    expect(migrateLegacyFingerPrefs()).toBe(false);
    expect(localStorage.getItem(STYLUS)).toBe("0");
  });
});

describe("useInkInputPrefs", () => {
  // The notice flag is module state: drain what the direct migrate calls above left.
  beforeEach(() => { renderHook(() => useInkInputPrefs()).unmount(); addToast.mockClear(); localStorage.clear(); });
  it("defaults to stylus mode OFF (fingers draw with a drawing tool)", () => {
    const { result } = renderHook(() => useInkInputPrefs());
    expect(result.current.stylusOnly).toBe(false);
    expect(addToast).not.toHaveBeenCalled();
  });

  it("a migrated device opens with stylus mode ON and says so once", () => {
    localStorage.setItem(MODE, "auto");
    localStorage.setItem(SEEN, "1");
    const first = renderHook(() => useInkInputPrefs());
    expect(first.result.current.stylusOnly).toBe(true);
    expect(addToast).toHaveBeenCalledTimes(1);
    const second = renderHook(() => useInkInputPrefs());
    expect(second.result.current.stylusOnly).toBe(true);
    expect(addToast).toHaveBeenCalledTimes(1);
  });
});
