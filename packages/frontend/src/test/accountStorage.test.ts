import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/localDb", () => ({ getRejectedWrites: async () => [], rejectPendingWrite: vi.fn(), dismissRejectedWrite: vi.fn() }));
beforeEach(() => { vi.resetModules(); vi.stubEnv("VITE_NATIVE", "false"); localStorage.clear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function enter(user: string, server = "") {
  vi.resetModules(); const account = await import("../lib/accountStorage");
  expect(account.bindAccountStorage(user, server)).toBe(true); return account;
}

describe("browser account storage boundary", () => {
  it("refuses private storage before authentication and cannot change owner without reload", async () => {
    const account = await import("../lib/accountStorage");
    expect(() => account.accountStorageKey("onden.lostWrites")).toThrow("Sign in");
    expect(account.bindAccountStorage("a", "https://one.example/")).toBe(true);
    const key = account.accountStorageKey("onden.lostWrites");
    expect(account.bindAccountStorage("a", "https://one.example")).toBe(true);
    expect(account.bindAccountStorage("b", "https://one.example")).toBe(false);
    expect(account.bindAccountStorage("a", "https://two.example")).toBe(false);
    expect(account.accountStorageKey("onden.lostWrites")).toBe(key);
  });

  it("A→B→A recovery and directory preferences survive reloads without adopting unowned legacy text", async () => {
    const legacy = JSON.stringify([{ id: "legacy", text: "unowned private input" }]);
    localStorage.setItem("onden.lostWrites", legacy); localStorage.setItem("onden-storage-pref", "fs-access");
    await enter("a");
    let recovery = await import("../lib/data/writeRecovery"); let folder = await import("../lib/fileSystemStorage");
    expect(recovery.getRecoveryWrites()).toEqual([]); expect(folder.getStoragePref()).toBeNull();
    recovery.rememberUnconfirmedWrite({ method: "PATCH", path: "/api/nodes/n", body: '{"markdown":"A private input"}', idemKey: "A-key" });
    folder.setStoragePref("opfs");
    await enter("b"); recovery = await import("../lib/data/writeRecovery"); folder = await import("../lib/fileSystemStorage");
    expect(recovery.getRecoveryWrites()).toEqual([]); expect(folder.getStoragePref()).toBeNull();
    folder.setStoragePref("fs-access");
    await enter("a"); recovery = await import("../lib/data/writeRecovery"); folder = await import("../lib/fileSystemStorage");
    expect(recovery.getRecoveryWrites()).toEqual([expect.objectContaining({ text: "A private input", idemKey: "A-key" })]);
    expect(folder.getStoragePref()).toBe("opfs");
    expect(localStorage.getItem("onden.lostWrites")).toBe(legacy);
    expect(localStorage.getItem("onden-storage-pref")).toBe("fs-access");
    await enter("a", "https://another.example"); recovery = await import("../lib/data/writeRecovery");
    expect(recovery.getRecoveryWrites()).toEqual([]);
  });

  it("an open page cannot redirect its queued requests after the server setting changes", async () => {
    await enter("a"); const { apiFetch, setApiBase } = await import("../lib/api");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const onden = vi.fn(async () => new Response(JSON.stringify({ providers: [] }), { headers: { "content-type": "application/json" } }));
    const reload = vi.fn();
    await expect(setApiBase("https://another.example", { fetchImpl: onden, reload })).resolves.toEqual({ ok: true, changed: true });
    expect(reload).toHaveBeenCalled();
    await expect(apiFetch("/api/nodes/n", { method: "PATCH" })).rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not give B the directory handle saved by A", async () => {
    const handles = new Map<string, unknown>();
    const db = { close: vi.fn(), transaction: () => {
      const tx = { oncomplete: null as (() => void) | null, objectStore: () => ({
        put: (handle: unknown, key: string) => { queueMicrotask(() => { handles.set(key, handle); tx.oncomplete?.(); }); },
        get: (key: string) => {
          const request = { result: handles.get(key), onsuccess: null as (() => void) | null };
          queueMicrotask(() => request.onsuccess?.()); return request;
        },
      }) }; return tx;
    } };
    vi.stubGlobal("indexedDB", { open: () => {
      const request = { result: db, onsuccess: null as (() => void) | null };
      queueMicrotask(() => request.onsuccess?.()); return request;
    } });
    const handle = { name: "A's folder" } as FileSystemDirectoryHandle;
    await enter("a"); let folder = await import("../lib/fileSystemStorage"); await folder.storeDirHandle(handle);
    await enter("b"); folder = await import("../lib/fileSystemStorage"); expect(await folder.getStoredDirHandle()).toBeNull();
    await enter("a"); folder = await import("../lib/fileSystemStorage"); expect(await folder.getStoredDirHandle()).toBe(handle);
  });
});
