import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { warmOfflineScreens, resetOfflineWarmupForTest, scheduleOfflineWarmup, OFFLINE_SCREENS } from "../lib/offlineWarmup";
import { BUILD_ID, lazyWithReload, takeUnwarmedScreens } from "../lib/lazyWithReload";

const online = { controlled: true, online: true, saveData: false };

beforeEach(() => { resetOfflineWarmupForTest(); localStorage.clear(); });

describe("offline warm-up of the main screens", () => {
  it("loads every screen once, one after another", async () => {
    const order: number[] = [];
    const screens = [0, 1, 2].map((i) => vi.fn(async () => { order.push(i); }));
    expect(await warmOfflineScreens(online, screens)).toBe(3);
    expect(order).toEqual([0, 1, 2]);
    expect(await warmOfflineScreens(online, screens)).toBe(0);
    expect(screens[0]).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no service worker (the Android app ships its files)", { ...online, controlled: false }],
    ["offline", { ...online, online: false }],
    ["the person asked to save data", { ...online, saveData: true }],
  ])("does nothing when %s", async (_why, env) => {
    const load = vi.fn(async () => {});
    expect(await warmOfflineScreens(env, [load])).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });

  it("a device that warmed this build skips it; a new build warms again", async () => {
    const load = vi.fn(async () => {});
    expect(await warmOfflineScreens({ ...online, warmedBuild: BUILD_ID }, [load])).toBe(0);
    expect(await warmOfflineScreens({ ...online, warmedBuild: "an-older-build" }, [load])).toBe(1);
    expect(localStorage.getItem("onden.offlineWarmBuild")).toBe(BUILD_ID);
  });

  it("an incomplete run is not remembered, so the next launch tries again", async () => {
    await warmOfflineScreens(online, [async () => { throw new Error("offline"); }]);
    expect(localStorage.getItem("onden.offlineWarmBuild")).toBeNull();
  });

  it("a screen that fails to load does not stop the others", async () => {
    const ok = vi.fn(async () => {});
    expect(await warmOfflineScreens(online, [async () => { throw new Error("Failed to fetch"); }, ok])).toBe(1);
    expect(ok).toHaveBeenCalled();
  });

  it("warms every screen lazyWithReload defined, and the ones those define once loaded", async () => {
    const order: string[] = [];
    const rounds = [
      [async () => { order.push("page"); }],
      [async () => { order.push("dialog inside the page"); }],
      [],
    ];
    expect(await warmOfflineScreens(online, [async () => { order.push("listed"); }], () => rounds.shift() ?? [])).toBe(3);
    expect(order).toEqual(["listed", "page", "dialog inside the page"]);
    expect(localStorage.getItem("onden.offlineWarmBuild")).toBe(BUILD_ID);
  });

  it("a lazy screen that fails to load leaves the run incomplete", async () => {
    const rounds = [[async () => { throw new Error("Failed to fetch"); }], []];
    expect(await warmOfflineScreens(online, [], () => rounds.shift() ?? [])).toBe(0);
    expect(localStorage.getItem("onden.offlineWarmBuild")).toBeNull();
  });

  it("lazyWithReload lists a screen for the warm-up unless it is marked large", () => {
    takeUnwarmedScreens();
    const page = async () => ({ default: () => null });
    const large = async () => ({ default: () => null });
    lazyWithReload(page);
    lazyWithReload(large, { warm: false });
    expect(takeUnwarmedScreens()).toEqual([page]);
    expect(takeUnwarmedScreens()).toEqual([]);
  });

  it("covers the bottom-bar screens and the note's reading view", () => {
    const text = OFFLINE_SCREENS.map((f) => f.toString()).join("\n");
    for (const screen of ["loadTasksMode", "SettingsModal", "OverviewPreview", "loadOfflineModuleScreens"]) expect(text).toContain(screen);
  });

  // The screens loaded at boot (components/workspace/bootHooks useWorkspaceChunks) load more code on use.
  // Offline, a part that was never fetched fails to load and takes the whole app to the error screen
  // (InfoParagraphs, then CanvasInkLayer: found by the full e2e run, 2026-11-07), so each is warmed.
  it("covers every part the boot-loaded screens load on use (offline, a missing one took the whole app down)", () => {
    const text = OFFLINE_SCREENS.map((f) => f.toString()).join("\n");
    const boot = readFileSync(resolve(__dirname, "../components/workspace/bootHooks.ts"), "utf8");
    const screens = [...boot.matchAll(/import\("\.\.\/([^"]+)"\)/g)].map((m) => m[1]!);
    expect(screens).toEqual(expect.arrayContaining(["KnowledgeWorkspace", "NodeInspector"]));
    let parts = 0;
    for (const screen of screens) {
      const source = readFileSync(resolve(__dirname, `../components/${screen}.tsx`), "utf8");
      for (const m of source.matchAll(/lazyWithReload\(\(\) => import\("\.\/([^"]+)"\)/g)) {
        parts++;
        expect(text, `components/${m[1]} (loaded by ${screen}) is warmed`).toContain(`components/${m[1]}`);
      }
    }
    expect(parts).toBeGreaterThanOrEqual(4);
  });

  it("on a first visit it waits for the service worker to take the page over", () => {
    const sw = new EventTarget() as EventTarget & { controller: object | null };
    sw.controller = null;
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: sw });
    const ric = vi.fn();
    vi.stubGlobal("requestIdleCallback", ric);
    try {
      scheduleOfflineWarmup();
      expect(ric).not.toHaveBeenCalled();
      sw.controller = {};
      sw.dispatchEvent(new Event("controllerchange"));
      expect(ric).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    }
  });
});
