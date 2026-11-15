// @vitest-environment jsdom
// Regression tests for applyPersistedSettings (settings/registry.tsx).
//
// Bug [darkmode-no-persist]: the boot loop read localStorage.getItem(def.id),
// but theme.dark persists under key "theme" (and language.app under
// "onden.locale"). So getItem("theme.dark") was always null → set(default) →
// dark mode silently reverted to light on every reload. The fix routes settings
// that define their own get() through it (it knows the real key + fallback).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyPersistedSettings } from "../settings/registry";
import { getLaunchPreference } from "../lib/launchPreference";

describe("applyPersistedSettings — dark-mode persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("re-applies persisted dark theme on boot (the bug)", () => {
    // Simulate what theme.dark.set(true) wrote in a previous session.
    localStorage.setItem("theme", "dark");

    applyPersistedSettings();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("applies light when nothing is stored", () => {
    applyPersistedSettings();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("does not clobber a persisted locale stored under its real key", () => {
    // language.app persists under "onden.locale", not "language.app".
    localStorage.setItem("onden.locale", "zh-TW");

    applyPersistedSettings();

    // The boot loop must read the real value via get(), not overwrite it
    // with the "system" default.
    expect(localStorage.getItem("onden.locale")).toBe("zh-TW");
  });

  it("an unreadable launch preference cannot block initialization or overwrite the original choice", () => {
    localStorage.setItem("home.landing", "home");
    localStorage.setItem("theme", "dark");
    const original = Storage.prototype.getItem;
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function(this: Storage, key: string) {
      if (key === "home.landing") throw new DOMException("Storage read denied", "SecurityError");
      return original.call(this, key);
    });
    try {
      expect(() => applyPersistedSettings()).not.toThrow();
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(getLaunchPreference()).toBe("today");
      expect(original.call(localStorage, "home.landing")).toBe("home");
    } finally { read.mockRestore(); }
    expect(getLaunchPreference()).toBe("home");
  });
});

describe("boot replay covers every setting with a side effect", () => {
  it("no registry setting outside APPEARANCE_SETTINGS has an apply", async () => {
    const { SETTINGS } = await import("../settings/registry");
    const { APPEARANCE_SETTINGS } = await import("../settings/appearance");
    const missed = SETTINGS.filter((d) => "apply" in d && d.apply && !APPEARANCE_SETTINGS.includes(d)).map((d) => d.id);
    expect(missed).toEqual([]);
    expect(APPEARANCE_SETTINGS.every((d) => SETTINGS.includes(d))).toBe(true);
  });
});
