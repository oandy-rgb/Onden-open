// The browser app's media storage (services/mediaFiles.ts MediaFiles): uploaded files kept in the browser, next to
// the saved copy of the database (snapshotStore.ts) and with the same two homes:
//   • OPFS — a directory `onden-browser-app/media/`, one file per media id, written with a sync access handle that is
//     flushed before the write resolves (so "stored" means the browser has handed the bytes to the file system);
//   • IndexedDB — one record per file, written in a `strict`-durability transaction; used where OPFS is not usable.
// A file is written under its final name. A crash half-way leaves a partial file under an id nothing references (the
// upload's answer, which names the id, was never sent); a failed write removes its own file.
//
// Room: browsers give an origin a quota (navigator.storage.estimate). It is checked before a write, and a write the
// browser still refuses (QuotaExceededError) is the same MediaStorageFull — the caller keeps the person's note and says so.
import { MediaStorageFull, type MediaFiles, type MediaUsage } from "../services/mediaFiles.js";
import { idbCommitted, idbRequest } from "./idb.js";
import type { SnapshotStoreKind } from "./snapshotStore.js";

const DIR = "onden-browser-app";
const MEDIA_DIR = "media";
/** Room kept free beyond a file, for the database's next saved copy. */
const RESERVE_BYTES = 32 * 1024 * 1024;

type SyncAccessHandle = { truncate(size: number): void; write(data: Uint8Array, options: { at: number }): number; flush(): void; close(): void };
type DirectoryWithKeys = FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };

const isQuota = (error: unknown) => error instanceof DOMException && error.name === "QuotaExceededError";
const isMissing = (error: unknown) => error instanceof DOMException && (error.name === "NotFoundError" || error.name === "TypeMismatchError");

async function* chunksOf(source: Buffer | Uint8Array | AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) yield source;
  else yield* source;
}

/** Lazily read a Blob (or a slice of one) as a stream: the file is opened when the first byte is asked for. */
function streamOf(load: () => Promise<Blob>): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= (await load()).stream().getReader();
      const { value, done } = await reader.read();
      if (done) controller.close(); else controller.enqueue(value);
    },
    cancel: () => reader?.cancel(),
  });
}

const sliceOf = (blob: Blob, range?: { start: number; end: number }) => (range ? blob.slice(range.start, range.end + 1) : blob);

async function assertQuota(bytes: number): Promise<void> {
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  if (estimate?.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < bytes + RESERVE_BYTES) throw new MediaStorageFull();
}

export async function createOpfsMediaFiles(): Promise<MediaFiles> {
  const root = await navigator.storage.getDirectory();
  const directory = await (await root.getDirectoryHandle(DIR, { create: true })).getDirectoryHandle(MEDIA_DIR, { create: true });
  const file = async (name: string) => (await directory.getFileHandle(name)).getFile();
  const names = async () => { const found: string[] = []; for await (const name of (directory as DirectoryWithKeys).keys()) found.push(name); return found; };
  return {
    async write(name, source) {
      const handle = await (await directory.getFileHandle(name, { create: true }) as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> }).createSyncAccessHandle();
      try {
        try {
          handle.truncate(0);
          let at = 0;
          for await (const chunk of chunksOf(source)) {
            for (let done = 0; done < chunk.byteLength; ) done += handle.write(chunk.subarray(done), { at: at + done });
            at += chunk.byteLength;
          }
          handle.flush();
        } finally { handle.close(); }
      } catch (error) {
        await directory.removeEntry(name).catch(() => {});
        throw isQuota(error) ? new MediaStorageFull() : error;
      }
    },
    async read(name) {
      try { return Buffer.from(await (await file(name)).arrayBuffer()); } catch (error) { if (isMissing(error)) return null; throw error; }
    },
    async info(name) {
      try { const stored = await file(name); return { size: stored.size, modifiedMs: stored.lastModified }; } catch (error) { if (isMissing(error)) return null; throw error; }
    },
    open: (name, range) => streamOf(async () => sliceOf(await file(name), range)),
    async remove(name) { await directory.removeEntry(name).catch((error) => { if (!isMissing(error)) throw error; }); },
    names,
    async usage(): Promise<MediaUsage> {
      let bytes = 0;
      const all = await names();
      for (const name of all) bytes += (await file(name).catch(() => null))?.size ?? 0;
      return { files: all.length, bytes };
    },
    assertRoom: assertQuota,
    async sweepIncomplete() { /* a partial file has an id nothing references; see the header */ },
    async clear() { for (const name of await names()) await directory.removeEntry(name).catch(() => {}); },
  };
}

type Stored = { name: string; bytes: ArrayBuffer; size: number; modifiedMs: number };

export async function createIndexedDbMediaFiles(): Promise<MediaFiles> {
  const open = indexedDB.open("onden-browser-app-media", 1);
  open.onupgradeneeded = () => { open.result.createObjectStore("files", { keyPath: "name" }); };
  const db = await idbRequest(open);
  const store = (mode: IDBTransactionMode) => db.transaction("files", mode, mode === "readwrite" ? { durability: "strict" } : undefined).objectStore("files");
  const get = (name: string) => idbRequest<Stored | undefined>(store("readonly").get(name));
  const all = () => idbRequest<Stored[]>(store("readonly").getAll());
  return {
    async write(name, source) {
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of chunksOf(source)) { parts.push(chunk); size += chunk.byteLength; }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
      try {
        const transaction = db.transaction("files", "readwrite", { durability: "strict" });
        transaction.objectStore("files").put({ name, bytes: bytes.buffer, size, modifiedMs: Date.now() } satisfies Stored);
        await idbCommitted(transaction);
      } catch (error) {
        throw isQuota(error) || (error instanceof Error && /quota/i.test(error.name)) ? new MediaStorageFull() : error;
      }
    },
    async read(name) { const stored = await get(name); return stored ? Buffer.from(stored.bytes) : null; },
    async info(name) { const stored = await get(name); return stored ? { size: stored.size, modifiedMs: stored.modifiedMs } : null; },
    open: (name, range) => streamOf(async () => new Blob([(await get(name))?.bytes ?? new ArrayBuffer(0)]).slice(range?.start, range ? range.end + 1 : undefined)),
    async remove(name) { const transaction = db.transaction("files", "readwrite", { durability: "strict" }); transaction.objectStore("files").delete(name); await idbCommitted(transaction); },
    async names() { return (await all()).map((stored) => stored.name); },
    async usage() { const stored = await all(); return { files: stored.length, bytes: stored.reduce((sum, one) => sum + one.size, 0) }; },
    assertRoom: assertQuota,
    async sweepIncomplete() { /* one record per file: written whole or not at all */ },
    async clear() { const transaction = db.transaction("files", "readwrite"); transaction.objectStore("files").clear(); await idbCommitted(transaction); },
  };
}

/** Files kept in memory only, up to `limitBytes` in all: a temporary session (`?temp=1`). Gone when the page is; never
 *  written anywhere. A file that would pass the limit is refused whole, as a full disk is (MediaStorageFull, which the
 *  upload answers with a sentence and leaves the person's note alone). */
export function memoryMediaFiles(limitBytes: number): MediaFiles {
  const stored = new Map<string, { bytes: Uint8Array<ArrayBuffer>; modifiedMs: number }>();
  const used = () => { let bytes = 0; for (const file of stored.values()) bytes += file.bytes.byteLength; return bytes; };
  const full = () => new MediaStorageFull("a temporary session holds only so many files", "temporary_session_full");
  return {
    async write(name, source) {
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of chunksOf(source)) {
        parts.push(chunk);
        size += chunk.byteLength;
        if (used() - (stored.get(name)?.bytes.byteLength ?? 0) + size > limitBytes) throw full();
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
      stored.set(name, { bytes, modifiedMs: Date.now() });
    },
    read: async (name) => { const file = stored.get(name); return file ? Buffer.from(file.bytes) : null; },
    info: async (name) => { const file = stored.get(name); return file ? { size: file.bytes.byteLength, modifiedMs: file.modifiedMs } : null; },
    open: (name, range) => streamOf(async () => sliceOf(new Blob([stored.get(name)?.bytes ?? new Uint8Array(0)]), range)),
    remove: async (name) => { stored.delete(name); },
    names: async () => [...stored.keys()],
    usage: async () => ({ files: stored.size, bytes: used() }),
    assertRoom: async (bytes) => { if (used() + bytes > limitBytes) throw full(); },
    sweepIncomplete: async () => {},
    clear: async () => { stored.clear(); },
  };
}

/** A browser with nowhere to keep anything (the snapshot store is "none" too): reading finds nothing, writing says so. */
export function noMediaFiles(): MediaFiles {
  const nowhere = () => new MediaStorageFull("this browser has nowhere to keep files");
  return {
    write: () => Promise.reject(nowhere()),
    read: async () => null,
    info: async () => null,
    open: () => new ReadableStream({ start: (controller) => controller.close() }),
    remove: async () => {},
    names: async () => [],
    usage: async () => ({ files: 0, bytes: 0 }),
    assertRoom: () => Promise.reject(nowhere()),
    sweepIncomplete: async () => {},
    clear: async () => {},
  };
}

/** The home that matches the saved copy's: files and database live in the same kind of place. */
export async function openMediaFiles(kind: SnapshotStoreKind): Promise<{ files: MediaFiles; kind: SnapshotStoreKind }> {
  try {
    if (kind === "opfs") return { files: await createOpfsMediaFiles(), kind };
    if (kind === "indexeddb") return { files: await createIndexedDbMediaFiles(), kind };
  } catch {
    // fall through to IndexedDB, then to nothing
  }
  try {
    if (typeof indexedDB !== "undefined") return { files: await createIndexedDbMediaFiles(), kind: "indexeddb" };
  } catch { /* nothing */ }
  return { files: noMediaFiles(), kind: "none" };
}
