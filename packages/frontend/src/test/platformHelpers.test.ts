import { afterEach, describe, expect, it, vi } from "vitest";
import { isBrowserOnline, prefersSavedData } from "../lib/browserNetwork";
import { serviceWorkerContainer } from "../lib/storagePersist";
import { systemLanguageTag } from "../lib/i18n";
import { pageHref, pageOrigin, reloadPage } from "../lib/api";
import { canObserveIntersection, observeIntersection } from "../lib/noteTitleVisibility";
import { popOverlayEntry, pushOverlayEntry } from "../hooks/useUrlLocation";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("連線狀態", () => {
  it("只有瀏覽器明說離線才算離線", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(isBrowserOnline()).toBe(false);
    vi.stubGlobal("navigator", { onLine: true });
    expect(isBrowserOnline()).toBe(true);
    vi.stubGlobal("navigator", undefined);
    expect(isBrowserOnline()).toBe(true);
  });

  it("省流量模式只在瀏覽器回報時為真", () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    expect(prefersSavedData()).toBe(true);
    vi.stubGlobal("navigator", { connection: { saveData: false } });
    expect(prefersSavedData()).toBe(false);
    vi.stubGlobal("navigator", {});
    expect(prefersSavedData()).toBe(false);
  });
});

describe("裝置資訊", () => {
  it("沒有 service worker 時回傳 undefined", () => {
    vi.stubGlobal("navigator", {});
    expect(serviceWorkerContainer()).toBeUndefined();
    const sw = {};
    vi.stubGlobal("navigator", { serviceWorker: sw });
    expect(serviceWorkerContainer()).toBe(sw);
  });

  it("系統語言沒有時退回 en", () => {
    vi.stubGlobal("navigator", { language: "zh-TW" });
    expect(systemLanguageTag()).toBe("zh-TW");
    vi.stubGlobal("navigator", { language: "" });
    expect(systemLanguageTag()).toBe("en");
  });
});

describe("頁面網址與重新載入", () => {
  it("pageOrigin／pageHref 讀目前頁面", () => {
    expect(pageOrigin()).toBe(window.location.origin);
    expect(pageHref()).toBe(window.location.href);
  });

  it("reloadPage 重新載入目前頁面", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    reloadPage();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("觀察元素進入畫面", () => {
  it("瀏覽器沒有 IntersectionObserver 時回傳 null", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    expect(canObserveIntersection()).toBe(false);
    expect(observeIntersection(document.createElement("div"), () => {})).toBeNull();
  });

  it("有的話開始觀察，停止函式會 disconnect", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class { observe = observe; disconnect = disconnect; });
    const el = document.createElement("div");
    const stop = observeIntersection(el, () => {});
    expect(observe).toHaveBeenCalledWith(el);
    stop?.();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("全螢幕畫面的返回紀錄", () => {
  it("push 之後多一筆紀錄並帶標記，pop 回上一筆", () => {
    const push = vi.spyOn(window.history, "pushState");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    pushOverlayEntry("ondenSettings");
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ ondenSettings: 2 }), "", window.location.href);
    popOverlayEntry();
    expect(back).toHaveBeenCalledTimes(1);
  });
});
