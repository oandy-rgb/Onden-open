// A zip archive written with backpressure: the producer waits while the
// reader is behind, so a large export or backup holds a few entries in
// memory at a time instead of the whole workspace (the VPS has little RAM).
//
// archiver queues every append() and keeps its content until the entry is
// compressed; appending a whole workspace up front buffered every note body
// at once. Here each add resolves only once at most MAX_PENDING entries are
// waiting. archiver emits `entry` when one has gone into the zip, and stops
// doing so while its output is not read (the zip engine's stream is full), so
// waiting on `entry` is waiting on the reader.

import archiver from "archiver";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { mediaFiles } from "./mediaFiles.js";

/** Entries queued in archiver at most (each a note file, a JSON sidecar or a
 *  media file, which archiver reads from disk as a stream). */
const MAX_PENDING = 8;

/** What an archive writer needs to add entries. A writer that only needs this works the same whether the entries go
 *  into the zip as they are made (PacedArchive) or are collected first (backupArchive.ts reads inside a database
 *  snapshot and writes after it). */
export type ArchiveSink = Pick<PacedArchive, "addText" | "addMedia">;
// addFile is not in the sink: only a writer that owns the file for as long as the archive reads it can use it.

export type PacedArchive = {
  /** The readable zip. Hand it to the response as it is. */
  archive: archiver.Archiver;
  /** Queue a text file. Resolves when there is room for the next one;
   *  rejects with ArchiveClosed once the reader went away or the archive
   *  failed, so the producer stops reading the database. */
  addText(name: string, text: string): Promise<void>;
  /** Queue the file at `path` under `name`, streamed from disk as the archive takes it (a text too large to hold whole). The
   *  file must stay until the archive has been read to its end ('close'). */
  addFile(name: string, path: string): Promise<void>;
  /** Queue a stored media file (mediaFiles.ts) under the archive entry `name`; it is read as the archive takes it. */
  addMedia(mediaName: string, name: string): Promise<void>;
  /** No more entries: write the central directory and end the stream (as
   *  the reader takes it; this does not wait for that). */
  finish(): void;
  /** Stop with an error (a failed database read): the response ends broken
   *  instead of looking like a complete archive. */
  fail(error: Error): void;
};

/** The reader closed the download, or the archive failed. */
export class ArchiveClosed extends Error {
  constructor() { super("archive closed"); this.name = "ArchiveClosed"; }
}

export function pacedArchive(): PacedArchive {
  const archive = archiver("zip", { zlib: { level: 6 } });
  let queued = 0;
  let processed = 0;
  let closed = false;
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  archive.on("entry", () => { processed++; notify(); });
  // An entry archiver skips with a warning never emits `entry`: count it as
  // done, or enough of them would stall every entry after them.
  archive.on("warning", () => { processed++; notify(); });
  archive.on("error", () => { closed = true; notify(); });
  archive.on("close", () => { closed = true; notify(); });

  async function room(): Promise<void> {
    while (!closed && queued - processed > MAX_PENDING) {
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    if (closed || archive.destroyed) throw new ArchiveClosed();
  }

  return {
    archive,
    async addText(name, text) {
      await room();
      queued++;
      archive.append(text, { name });
    },
    async addFile(name, path) {
      await room();
      queued++;
      archive.append(createReadStream(path), { name });
    },
    async addMedia(mediaName, name) {
      await room();
      queued++;
      // A file gone since the caller looked is skipped with a warning (which the counting above takes as done).
      if (!await mediaFiles().info(mediaName)) { archive.emit("warning", new Error(`${mediaName}: no such media file`)); return; }
      archive.append(Readable.fromWeb(mediaFiles().open(mediaName) as never), { name });
    },
    finish() {
      if (closed || archive.destroyed) throw new ArchiveClosed();
      // Settles when the reader has taken the whole zip; a reader that goes
      // away fires `close` above instead.
      archive.finalize().catch(() => {});
    },
    fail(error) {
      closed = true;
      archive.destroy(error);
    },
  };
}
