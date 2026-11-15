// Where the worker keeps its saved copy of the database (the output of PGlite dumpDataDir, gzip tar).
//
// PGlite itself runs in memory (a persistent PGlite filesystem is 6–10× slower in the browser and `opfs-ahp`
// does not exist on Safari: docs/research/browser-trial/README.md §3.3), so persistence is a whole copy,
// written after changes. Two stores, same contract:
//   • OPFS (a file in the origin's private file system) — preferred; written with a sync access handle,
//     the one way every engine with OPFS supports in a worker.
//   • IndexedDB — when OPFS cannot be used (older Safari, some private windows, a refused permission).
// A write never replaces the only good copy: OPFS alternates two slot files and moves a small pointer file
// last; IndexedDB's single put is atomic. A crash mid-write leaves the previous copy current.

import { idbCommitted, idbRequest } from "./idb.js";

export type SnapshotStoreKind = "opfs" | "indexeddb" | "none";

/** What a copy remembers about itself (so a newer app can tell what it still has to do with it):
 *  `journalSeq` = the last logged write the copy already contains (journal.ts replays the ones after it);
 *  `schema` = the newest migration it was made with ("" for copies made before the app recorded it). */
export type CopyMeta = { journalSeq: number; schema: string };
export const NO_META: CopyMeta = { journalSeq: 0, schema: "" };

export type SavedCopy = { blob: Blob; meta: CopyMeta };

export type SnapshotStore = {
  readonly kind: SnapshotStoreKind;
  /** How a copy is best made for this store: OPFS writes a file quickly, so an uncompressed copy (≈0.2 s, ~60 MiB)
   *  keeps the unsaved window short; IndexedDB is slow with big values, so its copy is compressed (≈1 s, ~6 MiB). */
  readonly copyFormat: "none" | "gzip";
  /** The current copy, or undefined when nothing was saved yet. */
  read(): Promise<SavedCopy | undefined>;
  /** Make `copy` the current copy. Resolves when it is durable (flushed), rejects if it could not be. */
  write(copy: Blob, meta: CopyMeta): Promise<void>;
  /** Forget every copy ("start over"). */
  clear(): Promise<void>;
};

const DIR = "onden-browser-app";
const POINTER = "current";
// Named without ".tar.gz": PGlite decides whether a copy is compressed from its type or file name, and a copy
// here may be either; read() gives the Blob the right type.
const SLOTS = ["slot-a", "slot-b"] as const;
const TAR = "application/x-tar";
const GZIP = "application/x-gzip";
const typeOf = (copy: Blob): string => (copy.type.includes("gzip") ? GZIP : TAR);

type Pointer = { slot: (typeof SLOTS)[number]; bytes: number; savedAt: number; type: string; meta?: CopyMeta };
const metaOf = (saved: { meta?: Partial<CopyMeta> } | undefined): CopyMeta => ({ ...NO_META, ...saved?.meta });

// Not in the Node typings the backend is checked with; the worker runtime has them.
type SyncAccessHandle = {
  truncate(size: number): void;
  write(data: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
};

async function openDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

async function writeWhole(directory: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const file = await directory.getFileHandle(name, { create: true });
  // createSyncAccessHandle exists in workers on every engine with OPFS, createWritable does not (Safari).
  const handle = await (file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> }).createSyncAccessHandle();
  try {
    handle.truncate(0);
    let at = 0;
    while (at < bytes.byteLength) at += handle.write(bytes.subarray(at), { at });
    handle.flush();
  } finally {
    handle.close();
  }
}

async function readPointer(directory: FileSystemDirectoryHandle): Promise<Pointer | undefined> {
  try {
    const file = await (await directory.getFileHandle(POINTER)).getFile();
    const parsed = JSON.parse(await file.text()) as Pointer;
    return SLOTS.includes(parsed.slot) && Number.isFinite(parsed.bytes) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function createOpfsStore(): Promise<SnapshotStore> {
  const directory = await openDirectory();
  // Prove file writing works here (some engines expose the directory but refuse sync handles): a throwaway file.
  await writeWhole(directory, "probe", new Uint8Array([1]));
  await directory.removeEntry("probe").catch(() => {});
  return {
    kind: "opfs",
    copyFormat: "none",
    async read() {
      const pointer = await readPointer(directory);
      if (!pointer) return undefined;
      const file = await (await directory.getFileHandle(pointer.slot)).getFile();
      // The pointer is written after the slot, so a size mismatch means the slot was changed behind our back.
      if (file.size !== pointer.bytes) throw new Error("saved copy is incomplete");
      return { blob: new Blob([file], { type: pointer.type }), meta: metaOf(pointer) };
    },
    async write(copy, meta) {
      const previous = await readPointer(directory);
      const slot = previous?.slot === SLOTS[0] ? SLOTS[1] : SLOTS[0];
      const bytes = new Uint8Array(await copy.arrayBuffer());
      await writeWhole(directory, slot, bytes);
      const pointer: Pointer = { slot, bytes: bytes.byteLength, savedAt: Date.now(), type: typeOf(copy), meta };
      await writeWhole(directory, POINTER, new TextEncoder().encode(JSON.stringify(pointer)));
    },
    async clear() {
      for (const name of [POINTER, ...SLOTS]) await directory.removeEntry(name).catch(() => {});
    },
  };
}

const IDB_NAME = "onden-browser-app";
const IDB_STORE = "copies";
const IDB_KEY = "database";

async function createIndexedDbStore(): Promise<SnapshotStore> {
  const open = indexedDB.open(IDB_NAME, 1);
  open.onupgradeneeded = () => { open.result.createObjectStore(IDB_STORE); };
  const db = await idbRequest(open);
  const store = (mode: IDBTransactionMode) => db.transaction(IDB_STORE, mode).objectStore(IDB_STORE);
  return {
    kind: "indexeddb",
    copyFormat: "gzip",
    async read() {
      const saved = await idbRequest<{ bytes: ArrayBuffer; type: string; meta?: CopyMeta } | undefined>(store("readonly").get(IDB_KEY));
      return saved ? { blob: new Blob([saved.bytes], { type: saved.type }), meta: metaOf(saved) } : undefined;
    },
    async write(copy, meta) {
      // An ArrayBuffer, not the Blob: older WebKit cannot store Blobs in IndexedDB.
      const bytes = await copy.arrayBuffer();
      const transaction = db.transaction(IDB_STORE, "readwrite");
      transaction.objectStore(IDB_STORE).put({ bytes, type: typeOf(copy), meta }, IDB_KEY);
      await idbCommitted(transaction);
    },
    async clear() {
      const transaction = db.transaction(IDB_STORE, "readwrite");
      transaction.objectStore(IDB_STORE).delete(IDB_KEY);
      await idbCommitted(transaction);
    },
  };
}

/** A store that keeps nothing: reading finds nothing, writing says so. */
function noSnapshotStore(): SnapshotStore {
  return {
    kind: "none",
    copyFormat: "gzip",
    read: async () => undefined,
    write: async () => { throw new Error("no place to keep a saved copy"); },
    clear: async () => {},
  };
}

/** The best store this browser offers; "none" when neither works (the page then says nothing will be kept).
 *  `only: "indexeddb"` skips OPFS, to exercise the path Safari without usable file access takes (e2e: `?store=indexeddb`).
 *  `only: "none"` does not look at the browser's storage at all: a temporary session (`?temp=1`) must neither read, write
 *  nor erase what an ordinary session of the same browser keeps. */
export async function openSnapshotStore(only?: "indexeddb" | "none"): Promise<SnapshotStore> {
  if (only === "none") return noSnapshotStore();
  try {
    if (only !== "indexeddb" && typeof navigator.storage?.getDirectory === "function") return await createOpfsStore();
  } catch {
    // fall through to IndexedDB
  }
  try {
    if (typeof indexedDB !== "undefined") {
      const store = await createIndexedDbStore();
      await store.read(); // surfaces a blocked database now, not at the first save
      return store;
    }
  } catch {
    // fall through to none
  }
  return noSnapshotStore();
}
