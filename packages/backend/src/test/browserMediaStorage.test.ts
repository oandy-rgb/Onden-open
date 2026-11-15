// What the browser app does when the browser has no room (browser/mediaStorage.ts), with a small fake of the OPFS
// directory: the upload is refused as "no room" (MediaStorageFull), the half-written file is removed, and a quota
// estimate that leaves too little is refused before anything is written.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaStorageFull } from "../services/mediaFiles.js";
import { createOpfsMediaFiles, noMediaFiles, openMediaFiles } from "../browser/mediaStorage.js";

const NAME = "0123456789abcdef0123456789abcdef.png";

/** A directory of in-memory files whose sync access handle can be told to run out of quota after `quotaBytes`. */
function fakeStorage(quotaBytes: number, estimate: { usage: number; quota: number } = { usage: 0, quota: 10 ** 12 }) {
  const files = new Map<string, Uint8Array>();
  const media = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("missing", "NotFoundError");
        files.set(name, new Uint8Array());
      }
      return {
        async getFile() { const bytes = files.get(name)!; return new File([bytes as BlobPart], name); },
        async createSyncAccessHandle() {
          return {
            truncate: (size: number) => files.set(name, files.get(name)!.slice(0, size)),
            write(data: Uint8Array, { at }: { at: number }) {
              if (at + data.byteLength > quotaBytes) throw new DOMException("full", "QuotaExceededError");
              const next = new Uint8Array(Math.max(files.get(name)!.byteLength, at + data.byteLength));
              next.set(files.get(name)!); next.set(data, at); files.set(name, next);
              return data.byteLength;
            },
            flush() {}, close() {},
          };
        },
      };
    },
    async removeEntry(name: string) { if (!files.delete(name)) throw new DOMException("missing", "NotFoundError"); },
    async *keys() { yield* files.keys(); },
  };
  const app = { getDirectoryHandle: async () => media };
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => app }), estimate: async () => estimate } });
  return files;
}

afterEach(() => vi.unstubAllGlobals());

describe("the browser app's file space when it is full", () => {
  it("refuses a write the browser's quota stops, and leaves no half file", async () => {
    const files = fakeStorage(4);
    const storage = await createOpfsMediaFiles();
    await expect(storage.write(NAME, Buffer.from([1, 2, 3, 4, 5, 6]))).rejects.toBeInstanceOf(MediaStorageFull);
    expect(files.size).toBe(0);
    expect(await storage.info(NAME)).toBeNull();
  });

  it("keeps a file that fits, and the failed one does not disturb it", async () => {
    const files = fakeStorage(4);
    const storage = await createOpfsMediaFiles();
    await storage.write(NAME, Buffer.from([1, 2, 3]));
    await expect(storage.write("a".repeat(32) + ".png", Buffer.from([1, 2, 3, 4, 5]))).rejects.toBeInstanceOf(MediaStorageFull);
    expect([...files.keys()]).toEqual([NAME]);
    expect(await storage.read(NAME)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("checks the quota estimate before writing: too little room is refused up front", async () => {
    fakeStorage(10 ** 9, { usage: 990, quota: 1000 });
    const storage = await createOpfsMediaFiles();
    await expect(storage.assertRoom(1)).rejects.toBeInstanceOf(MediaStorageFull);
    fakeStorage(10 ** 9, { usage: 0, quota: 10 ** 12 });
    await expect((await createOpfsMediaFiles()).assertRoom(10 ** 6)).resolves.toBeUndefined();
  });

  it("a browser with nowhere to keep files says so on a write and shows nothing", async () => {
    const none = noMediaFiles();
    await expect(none.write(NAME, Buffer.from([1]))).rejects.toBeInstanceOf(MediaStorageFull);
    expect(await none.read(NAME)).toBeNull();
    expect(await none.usage()).toEqual({ files: 0, bytes: 0 });
  });

  it("falls back to IndexedDB when the file space cannot be opened, and to nothing without it", async () => {
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => { throw new Error("denied"); } } });
    expect((await openMediaFiles("opfs")).kind).toBe("none"); // no indexedDB global yet in this test file
  });
});
