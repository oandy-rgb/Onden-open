// The temporary session's page half (lib/temporaryStorage.ts, the flag in lib/temporarySession.ts): with `?temp=1` the page's storage is replaced by memory and
// absence before the app loads; without it nothing is touched. The worker's half is backend/src/test/browserTemporarySession.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); window.history.replaceState(null, "", "/"); });

async function load() {
  vi.resetModules();
  const { beginTemporarySessionIfAsked } = await import("../lib/temporaryStorage");
  const { isTemporarySession } = await import("../lib/temporarySession");
  return { beginTemporarySessionIfAsked, isTemporarySession };
}

describe("temporary session (page)", () => {
  it("does nothing without ?temp=1: the page's storage is the browser's own", async () => {
    window.history.replaceState(null, "", "/?other=1");
    const before = window.localStorage;
    const { beginTemporarySessionIfAsked, isTemporarySession } = await load();
    expect(beginTemporarySessionIfAsked()).toBe(false);
    expect(isTemporarySession()).toBe(false);
    expect(window.localStorage).toBe(before);
  });

  it("with ?temp=1 replaces localStorage and sessionStorage by memory, and removes IndexedDB, caches and the origin's file system", async () => {
    window.history.replaceState(null, "", "/?temp=1");
    const storage = { getDirectory: async () => ({}) };
    vi.stubGlobal("navigator", { ...window.navigator, storage });
    // The browser's own storage, as a recorder: whatever the page writes to it is listed.
    const written: string[] = [];
    const kept = new Map<string, string>();
    const realLocal = {
      get length() { return kept.size; }, key: (i: number) => [...kept.keys()][i] ?? null, getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => { written.push(k); kept.set(k, v); }, removeItem: (k: string) => { written.push(`-${k}`); kept.delete(k); }, clear: () => { written.push("clear"); kept.clear(); },
    } as Storage;
    Object.defineProperty(window, "localStorage", { configurable: true, value: realLocal });
    realLocal.setItem("ordinary", "kept");

    const { beginTemporarySessionIfAsked, isTemporarySession } = await load();
    expect(beginTemporarySessionIfAsked()).toBe(true);
    expect(isTemporarySession()).toBe(true);

    // What the app now reads and writes is a Map: it works as a Storage, and nothing reaches the browser's own.
    expect(window.localStorage).not.toBe(realLocal);
    window.localStorage.setItem("a", "1");
    // The app's per-tab memory goes through lib/sessionPrefs: it too stays in memory, and the browser's own store is not written.
    const sessions = await import("../lib/sessionPrefs");
    expect(sessions.writeSession("b", "2")).toBe(true);
    expect(sessions.readSession("b")).toBe("2");
    expect(window.sessionStorage.getItem("b")).toBeNull();
    expect(window.localStorage.getItem("a")).toBe("1");
    expect(window.localStorage.getItem("ordinary")).toBeNull(); // the ordinary session's preferences are not even visible
    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.key(0)).toBe("a");
    window.localStorage.removeItem("a");
    expect(window.localStorage.getItem("a")).toBeNull();
    window.localStorage.setItem("c", "3");
    window.localStorage.clear();
    expect(window.localStorage.length).toBe(0);
    expect(written).toEqual(["ordinary"]); // nothing but the ordinary session's own write ever reached the browser's storage
    expect([...kept.keys()]).toEqual(["ordinary"]);

    expect(window.indexedDB).toBeUndefined();
    expect((window as unknown as { caches?: unknown }).caches).toBeUndefined();
    expect(storage.getDirectory).toBeUndefined();
  });

  it("is idempotent: a second call keeps the same memory", async () => {
    window.history.replaceState(null, "", "/?temp=1");
    const { beginTemporarySessionIfAsked } = await load();
    beginTemporarySessionIfAsked();
    window.localStorage.setItem("k", "v");
    beginTemporarySessionIfAsked();
    expect(window.localStorage.getItem("k")).toBe("v");
  });
});
