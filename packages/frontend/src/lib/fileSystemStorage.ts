import { accountStorageKey } from "./accountStorage";
import { PREFS, getPref, setPref } from "./prefs";
const IDB_NAME = "onden-fs-handles";
const IDB_VERSION = 1;
const STORE_NAME = "handles";
const HANDLE_KEY = "userDataDir";
const DB_FILENAME = "onden.sqlite3";

export type StoragePref = "opfs" | "fs-access" | null;

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export function getStoragePref(): StoragePref {
  return getPref(PREFS.storagePref) as StoragePref;
}

export function setStoragePref(pref: "opfs" | "fs-access"): void {
  setPref(PREFS.storagePref, pref);
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** `slot` names which folder (the local copy's, or the trial version's backup folder); each has its own handle. */
export async function getStoredDirHandle(slot: string = HANDLE_KEY): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(accountStorageKey(slot));
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function storeDirHandle(handle: FileSystemDirectoryHandle, slot: string = HANDLE_KEY): Promise<void> {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new DOMException("Directory setting was not saved", "AbortError")); };
    tx.objectStore(STORE_NAME).put(handle, accountStorageKey(slot));
  });
}

export async function requestDirPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = await (handle as any).queryPermission({ mode: "readwrite" });
    if (existing === "granted") return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perm = await (handle as any).requestPermission({ mode: "readwrite" });
    return perm === "granted";
  } catch {
    return false;
  }
}

export async function readDbFromDir(dirHandle: FileSystemDirectoryHandle): Promise<ArrayBuffer | null> {
  try {
    const fileHandle = await dirHandle.getFileHandle(DB_FILENAME, { create: false });
    const file = await fileHandle.getFile();
    return await file.arrayBuffer();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

export async function writeDbToDir(dirHandle: FileSystemDirectoryHandle, data: File): Promise<void> {
  const fileHandle = await dirHandle.getFileHandle(DB_FILENAME, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

/** Cancellation is a normal result; permission and storage failures reject. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (window as unknown as {
      showDirectoryPicker: (options: { mode: string }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker({ mode: "readwrite" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}
