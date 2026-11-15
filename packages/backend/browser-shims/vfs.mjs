// A small in-memory file system standing in for node:fs / node:fs/promises in the browser app's worker.
// What it is for: the backup a person restores is uploaded to a file first (services/backupFile.ts stages it under
// <store>/backup-uploads), then opened and read entry by entry. Nothing here is kept: the files live as long as the
// worker, and an upload is dropped after its restore or after 30 minutes by the service itself.
// What it is not for: uploaded media, which are kept by browser/mediaStorage.ts (OPFS / IndexedDB) behind services/mediaFiles.ts.
import { Buffer } from "buffer";
import stream from "./stream.cjs";

const files = new Map(); // "/a/b" → { data: Uint8Array, mtimeMs }
const dirs = new Set(["/"]);

const normalize = (path) => {
  const out = [];
  for (const part of String(path).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return `/${out.join("/")}`;
};
const parentOf = (path) => normalize(`${path}/..`);
const failure = (code, path, what) => Object.assign(new Error(`${code}: ${what}, '${path}'`), { code, errno: -1, path });

function mkdirp(path) {
  const parts = normalize(path).split("/").filter(Boolean);
  let at = "";
  for (const part of parts) { at += `/${part}`; dirs.add(at); }
}

const stats = (path) => {
  const key = normalize(path);
  const file = files.get(key);
  if (file) return { size: file.data.byteLength, mtimeMs: file.mtimeMs, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  if (dirs.has(key)) return { size: 0, mtimeMs: 0, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
  throw failure("ENOENT", path, "no such file or directory");
};

const bytesOf = (data) => (typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data));

function put(path, data, flag) {
  const key = normalize(path);
  if (flag && flag.includes("x") && (files.has(key) || dirs.has(key))) throw failure("EEXIST", path, "file already exists");
  mkdirp(parentOf(key));
  files.set(key, { data: bytesOf(data), mtimeMs: Date.now() });
}

function list(path) {
  const key = normalize(path);
  if (!dirs.has(key)) throw failure("ENOENT", path, "no such file or directory");
  const prefix = key === "/" ? "/" : `${key}/`;
  const names = new Set();
  for (const entry of [...files.keys(), ...dirs]) {
    if (entry !== key && entry.startsWith(prefix)) names.add(entry.slice(prefix.length).split("/")[0]);
  }
  return [...names];
}

function remove(path, { force = false, recursive = false } = {}) {
  const key = normalize(path);
  if (files.delete(key)) return;
  if (dirs.has(key) && key !== "/") {
    if (!recursive && list(key).length) throw failure("ENOTEMPTY", path, "directory not empty");
    for (const f of [...files.keys()]) if (f.startsWith(`${key}/`)) files.delete(f);
    for (const d of [...dirs]) if (d === key || d.startsWith(`${key}/`)) dirs.delete(d);
    return;
  }
  if (!force) throw failure("ENOENT", path, "no such file or directory");
}

function rename(from, to) {
  const a = normalize(from);
  const file = files.get(a);
  if (!file) throw failure("ENOENT", from, "no such file or directory");
  files.delete(a);
  mkdirp(parentOf(to));
  files.set(normalize(to), file);
}

const read = (path, options) => {
  const file = files.get(normalize(path));
  if (!file) throw failure("ENOENT", path, "no such file or directory");
  const encoding = typeof options === "string" ? options : options?.encoding;
  return encoding ? Buffer.from(file.data).toString(encoding) : Buffer.from(file.data);
};

function createWriteStream(path, options) {
  const chunks = [];
  const writer = new stream.PassThrough();
  writer._ended = true; // nothing reads from it
  writer.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; };
  writer.end = () => {
    try { put(path, Buffer.concat(chunks), options?.flags); writer.emit("finish"); } catch (error) { writer.emit("error", error); }
  };
  writer.destroy = () => writer;
  return writer;
}

function createReadStream(path) {
  const reader = new stream.Readable();
  try { reader.push(read(path)); reader.push(null); } catch (error) { reader.destroy(error); }
  return reader;
}

const notKept = (what) => () => { throw new Error(`${what} is not available in the browser app (uploaded files are not kept)`); };

export const existsSync = (path) => { try { stats(path); return true; } catch { return false; } };
export const statSync = (path) => stats(path);
export const mkdirSync = (path) => { mkdirp(path); };
export const writeFileSync = (path, data, options) => put(path, data, typeof options === "object" ? options?.flag : undefined);
export const readFileSync = read;
export const readdirSync = list;
export const unlinkSync = (path) => remove(path);
export const chmodSync = () => {};
export const renameSync = rename;
export const rmSync = remove;
export const rmdirSync = (path) => remove(path);
export const appendFileSync = (path, data) => { const had = files.get(normalize(path)); put(path, had ? Buffer.concat([Buffer.from(had.data), Buffer.from(bytesOf(data))]) : data); };
export const lstatSync = (path) => stats(path);
export const accessSync = (path) => { stats(path); };
export const copyFileSync = notKept("copying a file");
export const openSync = notKept("opening a file");
export { createReadStream, createWriteStream };

export const promises = {
  mkdir: async (path) => { mkdirp(path); },
  readdir: async (path) => list(path),
  readFile: async (path, options) => read(path, options),
  writeFile: async (path, data, options) => put(path, data, typeof options === "object" ? options?.flag : undefined),
  rename: async (from, to) => rename(from, to),
  rm: async (path, options) => remove(path, options),
  unlink: async (path) => remove(path),
  stat: async (path) => stats(path),
  lstat: async (path) => stats(path),
  access: async (path) => { stats(path); },
  // Room is never the limit here: the worker's memory is, and a restore with attachments is refused before it gets to them.
  statfs: async () => ({ bavail: 1 << 30, bsize: 4096 }),
  chmod: async () => {},
  appendFile: async (path, data) => { const had = files.get(normalize(path)); put(path, had ? Buffer.concat([Buffer.from(had.data), Buffer.from(bytesOf(data))]) : data); },
  rmdir: async (path) => remove(path),
  mkdtemp: async (prefix) => { const dir = `${prefix}${Math.random().toString(36).slice(2, 8)}`; mkdirp(dir); return dir; },
  realpath: async (path) => normalize(path),
  open: notKept("opening a file"),
  copyFile: notKept("copying a file"),
};
