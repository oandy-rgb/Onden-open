import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendToBody, clearSelection, createElement, elementAtPoint, isDarkTheme, observeTheme, rootAttribute,
  setBodyClass, setMeta, setRootAttribute, setRootStyle,
} from "./documentAccess";

afterEach(() => {
  setRootAttribute("data-theme", null);
  setRootStyle("--t", null);
  document.head.querySelectorAll("meta[name='theme-color']").forEach((m) => m.remove());
});

describe("documentAccess", () => {
  it("sets and removes root attributes and styles", () => {
    setRootAttribute("data-theme", "dark");
    expect(rootAttribute("data-theme")).toBe("dark");
    expect(isDarkTheme()).toBe(true);
    setRootAttribute("data-theme", null);
    expect(rootAttribute("data-theme")).toBeNull();
    setRootStyle("--t", "1");
    expect(document.documentElement.style.getPropertyValue("--t")).toBe("1");
    setRootStyle("--t", null);
    expect(document.documentElement.style.getPropertyValue("--t")).toBe("");
  });

  it("observeTheme reports a theme switch until stopped", async () => {
    const seen = vi.fn();
    const stop = observeTheme(seen);
    setRootAttribute("data-theme", "dark");
    await Promise.resolve();
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    setRootAttribute("data-theme", "light");
    await Promise.resolve();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("setMeta creates the tag once and then updates it", () => {
    setMeta("theme-color", "#111");
    setMeta("theme-color", "#222");
    const metas = document.querySelectorAll<HTMLMetaElement>("meta[name='theme-color']");
    expect(metas).toHaveLength(1);
    expect(metas[0].content).toBe("#222");
  });

  it("setBodyClass toggles a body class", () => {
    setBodyClass("x-test", true);
    expect(document.body.classList.contains("x-test")).toBe(true);
    setBodyClass("x-test", false);
    expect(document.body.classList.contains("x-test")).toBe(false);
  });

  it("appendToBody returns its own removal", () => {
    const el = createElement("div");
    const remove = appendToBody(el);
    expect(el.isConnected).toBe(true);
    remove();
    expect(el.isConnected).toBe(false);
  });

  it("is safe where the DOM cannot hit-test or select", () => {
    expect(elementAtPoint(1, 1)).toBeNull();
    expect(() => clearSelection()).not.toThrow();
  });
});
