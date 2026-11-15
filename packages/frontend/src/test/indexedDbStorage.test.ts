import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LOCAL_PERSIST_FAILED_EVENT } from "../lib/indexedDbStorage";

// The module remembers the generation it last saved; each test starts without one.
let idbSave: typeof import("../lib/indexedDbStorage").idbSave;

// A minimal fake IndexedDB whose write transaction fails (mirrors a quota /
// abort error). open() succeeds so we reach the tx, then the tx errors.
function installFailingIdb(abort = false): void {
  const fakeStore = { put: () => {} };
  const fakeTx = {
    objectStore: () => fakeStore,
    error: abort ? null : new DOMException("QuotaExceededError", "QuotaExceededError"),
    onabort: null as null | (() => void),
    oncomplete: null as null | (() => void),
    onerror: null as null | (() => void),
  };
  const fakeDb = { transaction: () => fakeTx, close: () => {} };
  const fakeOpenReq = {
    result: fakeDb,
    error: null as unknown,
    onupgradeneeded: null as null | (() => void),
    onsuccess: null as null | (() => void),
    onerror: null as null | (() => void),
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      // Fire success on the next tick so the await in openIdb() resolves, then
      // make the write transaction error.
      queueMicrotask(() => {
        fakeOpenReq.onsuccess?.();
        queueMicrotask(() => abort ? fakeTx.onabort?.() : fakeTx.onerror?.());
      });
      return fakeOpenReq;
    },
  });
}

function installSucceedingIdb(): void {
  const fakeStore = { put: () => {} };
  const fakeTx = {
    objectStore: () => fakeStore,
    error: null as unknown,
    oncomplete: null as null | (() => void),
    onerror: null as null | (() => void),
  };
  const fakeDb = { transaction: () => fakeTx, close: () => {} };
  const fakeOpenReq = {
    result: fakeDb,
    onsuccess: null as null | (() => void),
    onerror: null as null | (() => void),
    onupgradeneeded: null as null | (() => void),
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      queueMicrotask(() => {
        fakeOpenReq.onsuccess?.();
        queueMicrotask(() => fakeTx.oncomplete?.());
      });
      return fakeOpenReq;
    },
  });
}

describe("idbSave failure observability", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    ({ idbSave } = await import("../lib/indexedDbStorage"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects when the write fails so the worker can retry and recover", async () => {
    installFailingIdb();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(idbSave(new ArrayBuffer(4))).rejects.toMatchObject({ name: "QuotaExceededError" });
  });

  it("logs a console.error AND dispatches the failure event on write failure", async () => {
    installFailingIdb();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onFail = vi.fn();
    self.addEventListener(LOCAL_PERSIST_FAILED_EVENT, onFail);

    await expect(idbSave(new ArrayBuffer(4))).rejects.toMatchObject({ name: "QuotaExceededError" });

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain("IndexedDB");
    expect(onFail).toHaveBeenCalledTimes(1);
    self.removeEventListener(LOCAL_PERSIST_FAILED_EVENT, onFail);
  });

  it("rejects an aborted transaction even when no error event fires", async () => {
    installFailingIdb(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(idbSave(new ArrayBuffer(4))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stays silent on a successful save (no error log, no failure event)", async () => {
    installSucceedingIdb();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onFail = vi.fn();
    self.addEventListener(LOCAL_PERSIST_FAILED_EVENT, onFail);

    await idbSave(new ArrayBuffer(4));

    expect(errSpy).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
    self.removeEventListener(LOCAL_PERSIST_FAILED_EVENT, onFail);
  });
});
