// Where uploaded media bytes are kept: the one interface every media read and write goes through
// (services/media.ts, routes/media.ts, backups, exports, the importers). The Node server keeps them as files on
// disk (diskMediaFiles below, the default); the browser app installs its own (browser/mediaStorage.ts: OPFS, or
// IndexedDB) with `useMediaFiles` before the app is first used — the same way db.ts takes a snapshot source. Nothing
// else tells the two apart: no caller asks "is this the browser app?".
//
// What the contract promises, for both:
//  - `write` is all-or-nothing and durable: when it resolves, the bytes are on the storage medium (fsync / a flushed
//    OPFS handle / a committed IndexedDB transaction); when it rejects, no file of that name was left half-written.
//    "Saved" answers to the person come only after it.
//  - A missing file is `null` / a no-op, never an exception; a storage that is full throws MediaStorageFull.
// Naming: a file's name is its media id (`<32 hex>.<ext>`, @onden/markdown mediaRefs.ts); the callers have already
// checked that with isMediaId, so no implementation needs to defend against paths.

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { isMediaId } from "@onden/markdown";
import { CodedStatusError } from "../statusError.js";
import { MEDIA_DIR } from "./mediaStore.js";

/** There is no room left for this file (or the storage cannot be written at all). Answered 507
 *  `insufficient_storage` by the shared boundary (httpError.ts); a restore answers the same code through its own
 *  refusal (backupRestore.ts). Nothing was stored. */
export class MediaStorageFull extends CodedStatusError {
  /** `code`: "temporary_session_full" is the browser app's temporary session reaching its fixed limit for files, which the
   *  page explains in its own words (serverErrors); everything that handles a full storage treats both alike. */
  constructor(message = "not enough room to keep this file", code: "insufficient_storage" | "temporary_session_full" = "insufficient_storage") {
    super(507, code, message);
  }
}

export type MediaFileInfo = { size: number; modifiedMs: number };
export type MediaUsage = { files: number; bytes: number };

export interface MediaFiles {
  /** Keep `source` under `name`, replacing a file of that name. All-or-nothing and durable (see above).
   *  A source that throws while being read leaves nothing behind and rethrows. */
  write(name: string, source: Buffer | Uint8Array | AsyncIterable<Uint8Array>): Promise<void>;
  /** The whole file, or null when there is none. */
  read(name: string): Promise<Buffer | null>;
  info(name: string): Promise<MediaFileInfo | null>;
  /** The bytes `start`…`end` (inclusive; the whole file when omitted) as a stream; the caller checked `info` first. */
  open(name: string, range?: { start: number; end: number }): ReadableStream<Uint8Array>;
  /** Forget a file. A missing one is not an error. */
  remove(name: string): Promise<void>;
  /** Every stored media file's name. */
  names(): Promise<string[]>;
  /** How many files and bytes are kept (diagnostics). */
  usage(): Promise<MediaUsage>;
  /** Throw MediaStorageFull unless `bytes` more fit (with the room this storage keeps for itself). */
  assertRoom(bytes: number): Promise<void>;
  /** Remove half-written leftovers of a write the process did not finish (boot). */
  sweepIncomplete(): Promise<void>;
  /** Forget every file ("start over" in the browser app). */
  clear(): Promise<void>;
}

/** Room the disk keeps free after an upload or a restore's attachments are written. */
export const FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024;

/** Files on disk under MEDIA_DIR: a write goes to a dot-named sibling (outside the media id grammar, so no reference
 *  can name it), is synced, then renamed into place. `free` reads the free bytes of `dir`'s file system (tests). */
export function diskMediaFiles(
  dir: string = MEDIA_DIR,
  free: (dir: string) => Promise<number> = async (path) => { const s = await statfs(path); return s.bavail * s.bsize; },
): MediaFiles {
  const TEMPORARY = /^\.store-.*\.tmp$/;
  return {
    async write(name, source) {
      await mkdir(dir, { recursive: true });
      const temporary = join(dir, `.store-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, "wx");
        try {
          if (source instanceof Uint8Array) await handle.writeFile(source);
          else for await (const chunk of source) await handle.write(chunk);
          await handle.sync();
        } finally { await handle.close(); }
        await rename(temporary, join(dir, name));
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      }
    },
    async read(name) {
      try { return await readFile(join(dir, name)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async info(name) {
      try {
        const st = await stat(join(dir, name));
        return st.isFile() ? { size: st.size, modifiedMs: st.mtimeMs } : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    open(name, range) {
      return Readable.toWeb(createReadStream(join(dir, name), range)) as ReadableStream<Uint8Array>;
    },
    async remove(name) {
      await unlink(join(dir, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    },
    async names() { return (await readdir(dir).catch(() => [] as string[])).filter(isMediaId); },
    async usage() {
      let bytes = 0;
      const names = await this.names();
      for (const name of names) bytes += (await this.info(name))?.size ?? 0;
      return { files: names.length, bytes };
    },
    async assertRoom(bytes) {
      if (bytes <= 0) return;
      await mkdir(dir, { recursive: true });
      if (await free(dir) < bytes + FREE_SPACE_MARGIN_BYTES) throw new MediaStorageFull();
    },
    async sweepIncomplete() {
      for (const name of (await readdir(dir).catch(() => [] as string[])).filter((n) => TEMPORARY.test(n))) await rm(join(dir, name), { force: true });
    },
    async clear() { await rm(dir, { recursive: true, force: true }); },
  };
}

let installed: MediaFiles | undefined;

/** Install the storage a host other than the Node server keeps media in. Call before the first media read or write. */
export function useMediaFiles(files: MediaFiles): void {
  installed = files;
}

/** The storage in use: the one `useMediaFiles` installed, else files on disk. */
export function mediaFiles(): MediaFiles {
  return (installed ??= diskMediaFiles());
}
