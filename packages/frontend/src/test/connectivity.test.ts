// D26: the connection lifecycle as a state machine of its own — no React, a
// fake window, fake timers, and the engine steps it orders stubbed. The
// engine steps themselves (reconnect's gate rules, sync, boot) are covered
// against the real engine in useAppDataSync.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const engine = vi.hoisted(() => ({
  boot: vi.fn(),
  reconnect: vi.fn(),
  wentOffline: vi.fn(),
  sync: vi.fn(),
  refreshIfStale: vi.fn(),
  forgetWorkspace: vi.fn(),
}));
vi.mock("../lib/data/syncEngine", () => engine);
const unloadFlush = vi.hoisted(() => ({ dispose: vi.fn(), install: vi.fn() }));
vi.mock("../lib/localDb", () => ({ installUnloadFlush: unloadFlush.install }));
const revoked = vi.hoisted(() => ({ listener: null as null | (() => void) }));
vi.mock("../lib/accessRevoked", () => ({
  onAccessRevoked: (next: () => void) => {
    revoked.listener = next;
    return () => { if (revoked.listener === next) revoked.listener = null; };
  },
}));

import { attachConnectivity, RECONNECT_RETRY_MS, type ConnectivityHost } from "../lib/data/connectivity";
import { getAppState, resetAppState, setOnline, setAccessRevoked } from "../lib/appStore";

function fakeWindow(onLine = true) {
  const listeners = { online: new Set<() => void>(), offline: new Set<() => void>() };
  const host: ConnectivityHost & { navigator: { onLine: boolean } } = {
    navigator: { onLine },
    addEventListener: (type, l) => { listeners[type].add(l); },
    removeEventListener: (type, l) => { listeners[type].delete(l); },
  };
  const fire = (type: "online" | "offline") => { for (const l of [...listeners[type]]) l(); };
  return { host, listeners, fire };
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
let disposers: Array<() => void> = [];
function attach(host: ConnectivityHost) {
  const dispose = attachConnectivity(host);
  disposers.push(dispose);
  return dispose;
}

let bootResult: Deferred<{ endedOffline: boolean }>;
beforeEach(() => {
  vi.useFakeTimers();
  resetAppState();
  bootResult = deferred();
  engine.boot.mockReset().mockImplementation(() => bootResult.promise);
  engine.reconnect.mockReset().mockResolvedValue(true);
  engine.wentOffline.mockReset();
  engine.sync.mockReset().mockResolvedValue({ ok: true });
  engine.refreshIfStale.mockReset().mockResolvedValue(undefined);
  engine.forgetWorkspace.mockReset();
  unloadFlush.dispose.mockReset();
  unloadFlush.install.mockReset().mockReturnValue(unloadFlush.dispose);
  revoked.listener = null;
});
afterEach(async () => {
  for (const d of disposers) d();
  disposers = [];
  await flush();
  vi.useRealTimers();
});

describe("the first online flip belongs to boot", () => {
  it("boot's own flip only syncs; a later offline→online flip syncs then refreshes", async () => {
    attach(fakeWindow().host);
    expect(engine.boot).toHaveBeenCalledTimes(1);

    setOnline(true); // the slim/full paint landed
    expect(engine.sync).toHaveBeenCalledTimes(1);
    bootResult.resolve({ endedOffline: false });
    await flush();
    expect(engine.refreshIfStale).not.toHaveBeenCalled();

    setOnline(false);
    setOnline(true);
    expect(engine.sync).toHaveBeenCalledTimes(2);
    await flush();
    expect(engine.refreshIfStale).toHaveBeenCalledTimes(1);
  });

  it("refresh waits for the sync to finish", async () => {
    attach(fakeWindow().host);
    setOnline(true);
    setOnline(false);
    const pass = deferred<{ ok: boolean }>();
    engine.sync.mockReturnValueOnce(pass.promise);
    setOnline(true);
    await flush();
    expect(engine.refreshIfStale).not.toHaveBeenCalled();
    pass.resolve({ ok: true });
    await flush();
    expect(engine.refreshIfStale).toHaveBeenCalledTimes(1);
  });

  it("a boot that ended offline releases the flip: the first flip refreshes", async () => {
    attach(fakeWindow().host);
    bootResult.resolve({ endedOffline: true });
    await flush();
    setOnline(true);
    await flush();
    expect(engine.sync).toHaveBeenCalledTimes(1);
    expect(engine.refreshIfStale).toHaveBeenCalledTimes(1);
  });

  it("a store already online at attach counts as boot's flip", async () => {
    resetAppState({ online: true });
    attach(fakeWindow().host);
    expect(engine.sync).toHaveBeenCalledTimes(1);
    await flush();
    expect(engine.refreshIfStale).not.toHaveBeenCalled();
  });

  it("staying online is not a flip", async () => {
    attach(fakeWindow().host);
    setOnline(true);
    setOnline(true);
    resetAppState({ online: true, bootstrapped: true });
    expect(engine.sync).toHaveBeenCalledTimes(1);
  });
});

describe("online / offline events", () => {
  it("'online' reconnects; success schedules nothing", async () => {
    const win = fakeWindow();
    attach(win.host);
    win.fire("online");
    await flush();
    expect(engine.reconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failed reconnect while the browser is online retries after 5 s, until one succeeds", async () => {
    const win = fakeWindow(true);
    attach(win.host);
    engine.reconnect.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    win.fire("online");
    await flush();
    expect(engine.reconnect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS - 1);
    expect(engine.reconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.reconnect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS);
    expect(engine.reconnect).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS * 3);
    expect(engine.reconnect).toHaveBeenCalledTimes(3);
    expect(RECONNECT_RETRY_MS).toBe(5000);
  });

  it("a failed reconnect while the browser is offline leaves the retry to the 'online' event", async () => {
    const win = fakeWindow(false);
    attach(win.host);
    engine.reconnect.mockResolvedValue(false);
    win.fire("online");
    await flush();
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS * 2);
    expect(engine.reconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the browser state is read when reconnect answers, not when it started", async () => {
    const win = fakeWindow(true);
    attach(win.host);
    const answer = deferred<boolean>();
    engine.reconnect.mockReturnValueOnce(answer.promise);
    win.fire("online");
    win.host.navigator.onLine = false; // network dropped during the attempt
    answer.resolve(false);
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("'offline' goes offline and cancels a scheduled retry", async () => {
    const win = fakeWindow(true);
    attach(win.host);
    engine.reconnect.mockResolvedValue(false);
    win.fire("online");
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    win.fire("offline");
    expect(engine.wentOffline).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS * 2);
    expect(engine.reconnect).toHaveBeenCalledTimes(1);
  });

  it("a new 'online' supersedes the scheduled retry (one attempt, one timer)", async () => {
    const win = fakeWindow(true);
    attach(win.host);
    engine.reconnect.mockResolvedValue(false);
    win.fire("online");
    await flush();
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS - 1000);
    win.fire("online");
    await flush();
    expect(engine.reconnect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    // The old retry's moment passes without a third attempt.
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.reconnect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS - 1000);
    expect(engine.reconnect).toHaveBeenCalledTimes(3);
  });
});

describe("dispose", () => {
  it("removes listeners, the retry, the unload flush and the access-revoked handler", async () => {
    const win = fakeWindow(true);
    const dispose = attach(win.host);
    expect(unloadFlush.install).toHaveBeenCalledTimes(1);
    expect(revoked.listener).not.toBeNull();
    engine.reconnect.mockResolvedValue(false);
    win.fire("online");
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    dispose();
    await flush();
    expect(win.listeners.online.size).toBe(0);
    expect(win.listeners.offline.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(unloadFlush.dispose).toHaveBeenCalledTimes(1);
    expect(revoked.listener).toBeNull();

    setOnline(true);
    expect(engine.sync).not.toHaveBeenCalled();
  });

  it("ignores a reconnect or boot that answers after dispose", async () => {
    const win = fakeWindow(true);
    const dispose = attach(win.host);
    const answer = deferred<boolean>();
    engine.reconnect.mockReturnValueOnce(answer.promise);
    win.fire("online");
    dispose();
    await flush();
    answer.resolve(false);
    bootResult.resolve({ endedOffline: true });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("calling a disposer twice is harmless", async () => {
    const win = fakeWindow();
    const a = attach(win.host);
    const b = attach(win.host);
    a();
    a();
    await flush();
    expect(win.listeners.online.size).toBe(1); // b still holds it
    b();
    await flush();
    expect(win.listeners.online.size).toBe(0);
  });
});

describe("one lifecycle at a time", () => {
  it("StrictMode's mount → unmount → mount keeps one boot and one set of listeners", async () => {
    const win = fakeWindow();
    const first = attach(win.host);
    first();
    attach(win.host);
    await flush();
    expect(engine.boot).toHaveBeenCalledTimes(1);
    expect(unloadFlush.install).toHaveBeenCalledTimes(1);
    expect(unloadFlush.dispose).not.toHaveBeenCalled();
    expect(win.listeners.online.size).toBe(1);
    expect(win.listeners.offline.size).toBe(1);
  });

  it("two attachments share one lifecycle; it stops with the last", async () => {
    const win = fakeWindow();
    const a = attach(win.host);
    const b = attach(win.host);
    expect(engine.boot).toHaveBeenCalledTimes(1);
    expect(win.listeners.online.size).toBe(1);
    setOnline(true);
    expect(engine.sync).toHaveBeenCalledTimes(1);
    a();
    await flush();
    expect(win.listeners.online.size).toBe(1);
    b();
    await flush();
    expect(win.listeners.online.size).toBe(0);
    expect(unloadFlush.dispose).toHaveBeenCalledTimes(1);
  });

  it("a fresh attach after a full stop boots again", async () => {
    const win = fakeWindow();
    attach(win.host)();
    await flush();
    attach(win.host);
    expect(engine.boot).toHaveBeenCalledTimes(2);
  });

  it("refuses a second window while the first is attached", () => {
    attach(fakeWindow().host);
    expect(() => attachConnectivity(fakeWindow().host)).toThrow(/another window/);
  });
});

describe("access revoked", () => {
  it("forgets the workspace", () => {
    attach(fakeWindow().host);
    revoked.listener?.();
    expect(engine.forgetWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("the server was unreachable while the browser stayed online", () => {
  // The browser never went offline, so it fires no 'online' event: the lifecycle
  // itself schedules the existing reconnect retry.
  it("store goes offline → reconnect after 5 s → online again, with no 'online' event", async () => {
    const win = fakeWindow(true);
    attach(win.host);
    setOnline(true);
    bootResult.resolve({ endedOffline: false });
    await flush();
    engine.reconnect.mockImplementation(async () => { setOnline(true); return true; });

    setOnline(false); // refresh() found the server unreachable
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS - 1);
    expect(engine.reconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.reconnect).toHaveBeenCalledTimes(1);
    expect(getAppState().online).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps retrying every 5 s, one timer at a time, while the server stays down", async () => {
    const win = fakeWindow(true);
    attach(win.host);
    setOnline(true);
    engine.reconnect.mockImplementation(async () => {
      setOnline(true); // reconnect flips on, then reverts when sync fails
      setOnline(false);
      return false;
    });
    setOnline(false);
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS);
    expect(engine.reconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS);
    expect(engine.reconnect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS);
    expect(engine.reconnect).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("going offline twice does not double the timer", async () => {
    attach(fakeWindow(true).host);
    setOnline(true);
    setOnline(false);
    setOnline(true);
    setOnline(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("the browser going offline during the wait cancels the retry", async () => {
    const win = fakeWindow(true);
    attach(win.host);
    setOnline(true);
    setOnline(false);
    expect(vi.getTimerCount()).toBe(1);
    win.host.navigator.onLine = false;
    win.fire("offline");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS * 2);
    expect(engine.reconnect).not.toHaveBeenCalled();
  });

  it("a browser that is itself offline schedules nothing (the real 'online' event drives it)", async () => {
    attach(fakeWindow(false).host);
    setOnline(true);
    setOnline(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("nothing fires after the disposer ran", async () => {
    const win = fakeWindow(true);
    const dispose = attach(win.host);
    setOnline(true);
    setOnline(false);
    expect(vi.getTimerCount()).toBe(1);
    dispose();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS * 2);
    expect(engine.reconnect).not.toHaveBeenCalled();
  });

  it("access revoked starts no retry", async () => {
    attach(fakeWindow(true).host);
    setOnline(true);
    setAccessRevoked(true);
    setOnline(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS * 2);
    expect(engine.reconnect).not.toHaveBeenCalled();
  });

  it("a boot that ended offline (server down at page load) is brought online by the same loop", async () => {
    attach(fakeWindow(true).host);
    engine.reconnect
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => { setOnline(true); return true; });
    bootResult.resolve({ endedOffline: true });
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS);
    expect(engine.reconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS);
    expect(engine.reconnect).toHaveBeenCalledTimes(2);
    expect(getAppState().online).toBe(true);
    // The flip it caused is a refreshing one: boot released its claim.
    await flush();
    expect(engine.refreshIfStale).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a boot that ended offline while the browser is offline schedules nothing", async () => {
    attach(fakeWindow(false).host);
    bootResult.resolve({ endedOffline: true });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
});
