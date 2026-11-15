// Account isolation has its own suite (accountStorage.test.ts); these bind one account.
import { afterEach, describe, expect, it, vi } from "vitest";
import { pickDirectory, readDbFromDir, storeDirHandle, writeDbToDir } from "../lib/fileSystemStorage";
import { bindAccountStorage } from "../lib/accountStorage";

afterEach(() => vi.unstubAllGlobals());
bindAccountStorage("u", "");

describe("directory storage acknowledgement", () => {
  it("rejects an abort after a successful IDB put, before committing the handle", async () => {
    const request = { onsuccess: null as null | (() => void) };
    const transaction = {
      error: null,
      oncomplete: null as null | (() => void), onabort: null as null | (() => void), onerror: null as null | (() => void),
      objectStore: () => ({ put: () => {
        queueMicrotask(() => { request.onsuccess?.(); transaction.onabort?.(); });
        return request;
      } }),
    };
    const open = { result: { transaction: () => transaction, close: vi.fn() }, onsuccess: null as null | (() => void) };
    vi.stubGlobal("indexedDB", { open: () => { queueMicrotask(() => open.onsuccess?.()); return open; } });
    await expect(storeDirHandle({} as FileSystemDirectoryHandle)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("distinguishes an absent file from refused permission", async () => {
    const getFileHandle = vi.fn().mockRejectedValueOnce(new DOMException("Missing", "NotFoundError"))
      .mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    const handle = { getFileHandle } as unknown as FileSystemDirectoryHandle;
    await expect(readDbFromDir(handle)).resolves.toBeNull();
    await expect(readDbFromDir(handle)).rejects.toMatchObject({ name: "NotAllowedError" });
  });
  it("aborts an incomplete file write and keeps the original failure", async () => {
    const failure = new DOMException("Full", "QuotaExceededError");
    const stream = { write: vi.fn().mockRejectedValue(failure), close: vi.fn(), abort: vi.fn().mockResolvedValue(undefined) };
    const handle = { getFileHandle: async () => ({ createWritable: async () => stream }) } as unknown as FileSystemDirectoryHandle;
    await expect(writeDbToDir(handle, new File(["backup"], "backup.sqlite3"))).rejects.toBe(failure);
    expect(stream.close).not.toHaveBeenCalled();
    expect(stream.abort).toHaveBeenCalledOnce();
  });
  it("treats picker cancellation as normal but propagates denied access", async () => {
    const picker = vi.fn().mockRejectedValueOnce(new DOMException("Cancel", "AbortError"))
      .mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    vi.stubGlobal("showDirectoryPicker", picker);
    await expect(pickDirectory()).resolves.toBeNull();
    await expect(pickDirectory()).rejects.toMatchObject({ name: "NotAllowedError" });
  });
});
