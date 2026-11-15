// The part of `yauzl` that services/backupFile.ts uses, over a zip held in vfs.mjs (the staged upload): open(path, options, callback)
// gives a ZipFile with entryCount, readEntry() → "entry" / "end" events, openReadStream(entry, callback) and close(). Entries are
// read with fflate. Same refusals as yauzl for the things backupFile maps to "unsafe" (absolute path, "..", backslash, bad sizes).
// Zip64 (a backup over 4 GiB) is refused: it would not fit in the worker's memory anyway.
import { EventEmitter } from "events";
import { inflateSync } from "fflate";
import { readFileSync } from "./vfs.mjs";
import stream from "./stream.cjs";

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

function parse(bytes) {
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) {
    if (u32(bytes, at) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error("end of central directory record signature not found");
  const count = u16(bytes, eocd + 10);
  const directoryAt = u32(bytes, eocd + 16);
  if (count === 0xffff || directoryAt === 0xffffffff) throw new Error("zip64 is not supported");
  const entries = [];
  let at = directoryAt;
  const decoder = new TextDecoder("utf-8");
  for (let i = 0; i < count; i++) {
    if (u32(bytes, at) !== 0x02014b50) throw new Error("invalid central directory file header signature");
    const flags = u16(bytes, at + 8);
    const nameLength = u16(bytes, at + 28);
    const fileName = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (fileName.includes("\\")) throw new Error(`invalid characters in fileName: ${fileName}`);
    if (/^[A-Za-z]:/.test(fileName) || fileName.startsWith("/")) throw new Error(`absolute path: ${fileName}`);
    if (fileName.split("/").includes("..")) throw new Error(`invalid relative path: ${fileName}`);
    entries.push({
      fileName,
      compressionMethod: u16(bytes, at + 10),
      compressedSize: u32(bytes, at + 20),
      uncompressedSize: u32(bytes, at + 24),
      externalFileAttributes: u32(bytes, at + 38),
      relativeOffsetOfLocalHeader: u32(bytes, at + 42),
      isEncrypted: () => (flags & 1) === 1,
    });
    at += 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
  }
  return entries;
}

class ZipFile extends EventEmitter {
  constructor(bytes, entries) { super(); this.bytes = bytes; this.entries = entries; this.entryCount = entries.length; this.next = 0; }
  readEntry() {
    setTimeout(() => (this.next < this.entries.length ? this.emit("entry", this.entries[this.next++]) : this.emit("end")), 0);
  }
  openReadStream(entry, callback) {
    try {
      const b = this.bytes;
      const at = entry.relativeOffsetOfLocalHeader;
      if (u32(b, at) !== 0x04034b50) throw new Error("invalid local file header signature");
      const start = at + 30 + u16(b, at + 26) + u16(b, at + 28);
      const raw = b.subarray(start, start + entry.compressedSize);
      let data;
      if (entry.compressionMethod === 0) data = raw;
      else if (entry.compressionMethod === 8) data = inflateSync(raw);
      else throw new Error(`unsupported compression method: ${entry.compressionMethod}`);
      const out = new stream.Readable();
      if (data.length !== entry.uncompressedSize) {
        setTimeout(() => out.destroy(new Error("size mismatch")), 0);
      } else {
        setTimeout(() => { out.push(data); out.push(null); }, 0);
      }
      callback(null, out);
    } catch (error) {
      callback(error);
    }
  }
  close() {}
}

export function open(path, _options, callback) {
  setTimeout(() => {
    try {
      const bytes = new Uint8Array(readFileSync(path));
      callback(null, new ZipFile(bytes, parse(bytes)));
    } catch (error) {
      callback(error);
    }
  }, 0);
}
export default { open };
