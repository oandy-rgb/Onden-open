// The backup upload cap (services/backupFile.ts): a backup downloads at any size, so restoring takes one past the
// old 1 GB limit — streamed to a file on disk, never held in memory — and refuses, in plain codes, a file that does
// not fit the cap or the disk. No database: only the staging of the upload.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_BACKUP_REQUEST_BYTES } from "@onden/markdown";
import { discardUpload, maxBackupUploadBytes, maxUncompressedBytes, stageBackupUpload } from "../services/backupFile.js";
import { FREE_SPACE_MARGIN_BYTES } from "../services/mediaFiles.js";
import { rawZip } from "./helpers/rawZip.js";

const MB = 1024 * 1024;
const OLD_CAP_BYTES = 1024 * MB;
const manifest = JSON.stringify({ format: "onden-backup", version: 1, created_at: new Date().toISOString(), counts: {} });
const uploadFolder = join(process.cwd(), "content", "backup-uploads");
const leftovers = () => (existsSync(uploadFolder) ? readdirSync(uploadFolder).filter((n) => n.endsWith(".part")) : []);

/** A valid backup zip of `videos` stored attachments, each `padBytes` long, read out as a stream of zero chunks: the
 *  file is large, the test's own memory is not. (An attachment's bytes are never read while staging; only the
 *  central directory and the manifest are.) */
function paddedBackup(videos: number, padBytes: number, onChunk: () => void): { body: Readable; bytes: number } {
  const names = Array.from({ length: videos }, () => `attachments/${randomUUID().replaceAll("-", "")}.mp4`);
  const base = rawZip([{ name: ".onden/manifest.json", data: manifest }, ...names.map((name) => ({ name, data: Buffer.alloc(1) }))]);
  // Where each part of `base` sits: the manifest's local entry, then one local entry per video, then the central directory.
  const manifestLocal = 30 + ".onden/manifest.json".length + manifest.length;
  const localSizes = names.map((name) => 30 + Buffer.byteLength(name) + 1);
  const centralStart = manifestLocal + localSizes.reduce((a, b) => a + b, 0);
  const patched = Buffer.from(base);
  let at = manifestLocal;
  for (const size of localSizes) { patched.writeUInt32LE(1 + padBytes, at + 18); patched.writeUInt32LE(1 + padBytes, at + 22); at += size; }
  let central = centralStart + 46 + ".onden/manifest.json".length;
  names.forEach((name, i) => {
    patched.writeUInt32LE(1 + padBytes, central + 20); patched.writeUInt32LE(1 + padBytes, central + 24);
    patched.writeUInt32LE(manifestLocal + localSizes.slice(0, i).reduce((a, b) => a + b, 0) + padBytes * i, central + 42);
    central += 46 + Buffer.byteLength(name);
  });
  patched.writeUInt32LE(centralStart + padBytes * videos, patched.length - 22 + 16);
  const zeros = Buffer.alloc(8 * MB);
  async function* parts() {
    let from = 0;
    at = manifestLocal;
    for (const size of localSizes) {
      yield patched.subarray(from, at + size);
      for (let left = padBytes; left > 0; left -= zeros.length) { onChunk(); yield left >= zeros.length ? zeros : zeros.subarray(0, left); }
      from = at + size; at += size;
    }
    yield patched.subarray(from);
  }
  return { body: Readable.from(parts()), bytes: patched.length + padBytes * videos };
}

afterEach(() => { delete process.env.ONDEN_MAX_BACKUP_MB; });

describe("backup upload cap", () => {
  it("restores a backup past the old 1 GB cap by streaming it to disk, not into memory", async () => {
    let peak = 0;
    const before = process.memoryUsage().rss;
    const { body, bytes } = paddedBackup(3, 400 * MB, () => { peak = Math.max(peak, process.memoryUsage().rss); });
    expect(bytes).toBeGreaterThan(OLD_CAP_BYTES);
    const staged = await stageBackupUpload("a-person", body, bytes);
    try {
      expect(staged.bytes).toBe(bytes);
      expect(staged.manifest.format).toBe("onden-backup");
      expect(peak - before).toBeLessThan(400 * MB); // a buffered body would have grown by more than a gigabyte
    } finally { await discardUpload(staged.uploadId); }
    expect(leftovers()).toEqual([]);
  }, 120_000);

  it("states the cap: 16 GB, or ONDEN_MAX_BACKUP_MB; nginx and the page follow the same default", () => {
    expect(DEFAULT_MAX_BACKUP_REQUEST_BYTES).toBe(16 * 1024 * MB);
    expect(maxBackupUploadBytes()).toBe(DEFAULT_MAX_BACKUP_REQUEST_BYTES);
    process.env.ONDEN_MAX_BACKUP_MB = "32768";
    expect(maxBackupUploadBytes()).toBe(32 * 1024 * MB);
    expect(maxUncompressedBytes()).toBe(64 * 1024 * MB);
    process.env.ONDEN_MAX_BACKUP_MB = "not a number";
    expect(maxBackupUploadBytes()).toBe(DEFAULT_MAX_BACKUP_REQUEST_BYTES);
  });

  it("refuses an upload over the configured cap, by its stated length and by what arrives", async () => {
    process.env.ONDEN_MAX_BACKUP_MB = "5";
    await expect(stageBackupUpload("a-person", Readable.from([Buffer.alloc(1)]), 6 * MB)).rejects.toMatchObject({ code: "backup_too_large", status: 413 });
    await expect(stageBackupUpload("a-person", Readable.from([Buffer.alloc(6 * MB)]), null)).rejects.toMatchObject({ code: "backup_too_large", status: 413 });
    expect(leftovers()).toEqual([]);
  });

  it("refuses, before writing, a file the disk has no room for", async () => {
    const declared = 2 * 1024 * MB;
    const free = async () => declared + FREE_SPACE_MARGIN_BYTES - 1;
    await expect(stageBackupUpload("a-person", Readable.from([Buffer.alloc(1)]), declared, { freeBytes: free }))
      .rejects.toMatchObject({ code: "backup_no_room", status: 507 });
    expect(leftovers()).toEqual([]);
    // One byte more room and it is accepted past this check (and then judged as a file: this one is not a zip).
    await expect(stageBackupUpload("a-person", Readable.from([Buffer.alloc(1)]), declared, { freeBytes: async () => declared + FREE_SPACE_MARGIN_BYTES }))
      .rejects.toMatchObject({ code: "not_zip" });
  });
});
