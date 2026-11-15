// D92: one root for both entries. The web build (index.astro) and the
// Vite/Capacitor build (main.tsx) both mount AppRoot, which runs
// bootApp once: the same error boundary, persistent-storage request, polyfill
// and settings for every entry.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

const boot = vi.hoisted(() => ({
  polyfill: vi.fn(), settings: vi.fn(), persist: vi.fn(async () => {}), stamp: vi.fn(), chunks: vi.fn(),
  render: vi.fn(), createRoot: vi.fn(),
}));
vi.mock("../lib/uuid", () => ({ installUuidPolyfill: boot.polyfill }));
vi.mock("../settings/appearance", () => ({ applyPersistedSettings: boot.settings }));
vi.mock("../lib/storagePersist", () => ({ requestPersistentStorage: boot.persist }));
vi.mock("../lib/installStaleChunkReload", () => ({ installStaleChunkReload: boot.chunks }));
vi.mock("../lib/accountStorage", () => ({ stampLegacyNativeStore: boot.stamp }));
vi.mock("../lib/api", () => ({ getApiBase: () => "https://a.example" }));
vi.mock("../components/BuilderApp", () => ({ default: () => null }));
vi.mock("react-dom/client", () => ({ createRoot: boot.createRoot }));

beforeEach(() => {
  vi.resetModules();
  for (const fn of [boot.polyfill, boot.settings, boot.persist, boot.stamp, boot.chunks, boot.render, boot.createRoot]) fn.mockClear();
  boot.createRoot.mockReturnValue({ render: boot.render });
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(() => { vi.unstubAllEnvs(); });

function expectBootedOnce() {
  for (const fn of [boot.polyfill, boot.settings, boot.persist, boot.chunks]) expect(fn).toHaveBeenCalledOnce();
  expect(boot.stamp).toHaveBeenCalledWith("https://a.example");
}

describe("app entries", () => {
  it("the web page mounts AppRoot", () => {
    const page = readFileSync(join(__dirname, "..", "pages", "index.astro"), "utf8");
    expect(page).toMatch(/import AppRoot from "\.\.\/AppRoot";/);
    expect(page).toMatch(/<AppRoot client:only="react" \/>/);
  });

  it("loading AppRoot (the web mount) boots the page once", async () => {
    await import("../AppRoot");
    const { bootApp } = await import("../bootApp");
    bootApp();
    expectBootedOnce();
  });

  it.each(["false", "true"])("main.tsx (Vite, native=%s) mounts the same AppRoot and boots the same way", async (native) => {
    vi.stubEnv("VITE_NATIVE", native);
    await import("../main");
    const { default: AppRoot } = await import("../AppRoot");
    expect(boot.createRoot).toHaveBeenCalledWith(document.getElementById("root"));
    const element = boot.render.mock.calls[0][0] as ReactElement;
    expect(isValidElement(element) && element.type).toBe(AppRoot);
    expectBootedOnce();
  });
});
