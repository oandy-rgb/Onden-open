import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Suspense } from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import AppErrorBoundary from "../components/AppErrorBoundary";
import {
  BUILD_ID, RELOAD_WINDOW_MS, canAutoReload, chunkReloadPage, installChunkReloadHandler,
  isChunkLoadError, lazyWithReload, resetChunkReloadForTests, setBeforeChunkReload,
} from "../lib/lazyWithReload";

const KEY = "onden.chunkReload";
const chunkError = () => new TypeError("Failed to fetch dynamically imported module: https://x/_astro/Foo.abc123.js");

function mount(Lazy: React.ComponentType) {
  return render(
    <AppErrorBoundary>
      <Suspense fallback={<div>loading…</div>}>
        <Lazy />
      </Suspense>
    </AppErrorBoundary>,
  );
}

let reload: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  sessionStorage.clear();
  resetChunkReloadForTests();
  reload = vi.fn<() => void>();
  vi.spyOn(chunkReloadPage, "reload").mockImplementation(reload);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // A deploy: the server answers, and the old hashed file is no longer there.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("lazyWithReload", () => {
  it("passes a successful import through", async () => {
    const Lazy = lazyWithReload(async () => ({ default: () => <div>feature ready</div> }));
    mount(Lazy);
    expect(await screen.findByText("feature ready")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads once on the first chunk failure and keeps the fallback up", async () => {
    const Lazy = lazyWithReload(() => Promise.reject(chunkError()));
    mount(Lazy);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.getByText("loading…")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    const mark = JSON.parse(sessionStorage.getItem(KEY)!);
    expect(mark.build).toBe(BUILD_ID);
  });

  it("offline, a failed import is not a deploy: no reload, the error screen shows", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(canAutoReload()).toBe(false);
    const Lazy = lazyWithReload(() => Promise.reject(chunkError()));
    mount(Lazy);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it("failed while offline, handler runs once online again: the network, not a deploy, so no reload", async () => {
    // The request died with the connection; a few ms later the browser is online and the file is on the server.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("export {}", { status: 200, headers: { "content-type": "text/javascript" } })));
    const uninstall = installChunkReloadHandler();
    try {
      const event = new Event("vite:preloadError", { cancelable: true });
      Object.assign(event, { payload: chunkError() });
      window.dispatchEvent(event);
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(reload).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(KEY)).toBeNull(); // nothing was spent of the once-per-build allowance
    } finally { uninstall(); }
  });

  it("asks the real server with a HEAD that skips every cache (the service worker never answers a HEAD)", async () => {
    const fetchSpy = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    mount(lazyWithReload(() => Promise.reject(chunkError())));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith("https://x/_astro/Foo.abc123.js", expect.objectContaining({ method: "HEAD", cache: "no-store" }));
  });

  it("a request that gets no answer is the network: no reload, the error screen shows, a later deploy still reloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    mount(lazyWithReload(() => Promise.reject(chunkError())));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    resetChunkReloadForTests();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })));
    mount(lazyWithReload(() => Promise.reject(chunkError())));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("concurrent failures share one reload", async () => {
    const A = lazyWithReload(() => Promise.reject(chunkError()));
    const B = lazyWithReload(() => Promise.reject(chunkError()));
    render(<Suspense fallback={null}><A /><B /></Suspense>);
    await waitFor(() => expect(reload).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a failure right after an automatic reload shows the error instead of looping", async () => {
    // The page reloaded a moment ago (same tab, this build).
    sessionStorage.setItem(KEY, JSON.stringify({ build: BUILD_ID, at: Date.now() - 1000 }));
    const Lazy = lazyWithReload(() => Promise.reject(chunkError()));
    mount(Lazy);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Onden was updated")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it("the guard is per build: an old build's mark past the window allows one more reload, the same build's never", () => {
    const old = Date.now() - RELOAD_WINDOW_MS - 1;
    sessionStorage.setItem(KEY, JSON.stringify({ build: "some-older-build", at: old }));
    expect(canAutoReload()).toBe(true);
    sessionStorage.setItem(KEY, JSON.stringify({ build: "some-older-build", at: Date.now() }));
    expect(canAutoReload()).toBe(false);
    sessionStorage.setItem(KEY, JSON.stringify({ build: BUILD_ID, at: old }));
    expect(canAutoReload()).toBe(false);
  });

  it("other errors are not reloaded away", async () => {
    const Lazy = lazyWithReload(() => Promise.reject(new Error("kaboom in module init")));
    mount(Lazy);
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it("saves the draft first, then reloads", async () => {
    const order: string[] = [];
    setBeforeChunkReload(async () => { order.push("flush"); return { kind: "safe", recovered: [] }; });
    reload.mockImplementation(() => order.push("reload"));
    mount(lazyWithReload(() => Promise.reject(chunkError())));
    await waitFor(() => expect(order).toEqual(["flush", "reload"]));
  });

  it("text only in memory blocks the automatic reload", async () => {
    setBeforeChunkReload(async () => ({ kind: "memory-only", notes: [{ title: "A", text: "x" }] }));
    mount(lazyWithReload(() => Promise.reject(chunkError())));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("a draft flush that hangs still reloads after the timeout", async () => {
    vi.useFakeTimers();
    try {
      setBeforeChunkReload(() => new Promise<never>(() => {}));
      mount(lazyWithReload(() => Promise.reject(chunkError())));
      await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recognises the browsers' chunk-failure messages", () => {
    expect(isChunkLoadError(chunkError())).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: https://x/a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /_astro/a.css"))).toBe(true);
    expect(isChunkLoadError(new Error("kaboom"))).toBe(false);
    expect(isChunkLoadError("nope")).toBe(false);
  });
});

describe("vite:preloadError", () => {
  it("takes the failure over and reloads once", async () => {
    const uninstall = installChunkReloadHandler(window);
    try {
      const event = new Event("vite:preloadError", { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    } finally { uninstall(); }
  });

  it("leaves the error alone when the guard says no", async () => {
    sessionStorage.setItem(KEY, JSON.stringify({ build: BUILD_ID, at: Date.now() }));
    const uninstall = installChunkReloadHandler(window);
    try {
      const event = new Event("vite:preloadError", { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      await act(async () => { await Promise.resolve(); });
      expect(reload).not.toHaveBeenCalled();
    } finally { uninstall(); }
  });

  it("an import Vite resolved empty (after preventDefault) waits for the reload", async () => {
    const uninstall = installChunkReloadHandler(window);
    try {
      const Lazy = lazyWithReload(async () => {
        window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
        return undefined as unknown as { default: React.ComponentType };
      });
      mount(Lazy);
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("alert")).toBeNull();
    } finally { uninstall(); }
  });
});
