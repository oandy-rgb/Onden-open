// The part of `archiver` the exports and the full backup use (services/archiveStream.ts, exportZip.ts, backupArchive.ts),
// written on fflate: archiver("zip"), append(text, { name }), on("entry" | "warning" | "error" | "close"), finalize(),
// destroy(). The whole zip is built in memory (the database already is), and the stream handed to the response is
// the web stream `Readable.toWeb` returns (stream.cjs). A stream is read whole (the database already is in memory too). `file()` reads a path on disk, which does not exist here.
import { Zip, ZipDeflate, strToU8 } from "fflate";

class Archive {
  #listeners = new Map();
  #controller = null;
  #zip;
  #finalizing = null;
  destroyed = false;
  stream;

  constructor(options) {
    const level = options?.zlib?.level ?? 6;
    this.#level = level;
    this.stream = new ReadableStream({ start: (controller) => { this.#controller = controller; } });
    this.#zip = new Zip((error, chunk, final) => {
      if (this.destroyed) return;
      if (error) return this.#fail(error);
      this.#controller.enqueue(chunk);
      if (final) { this.#controller.close(); this.emit("close"); }
    });
  }
  #level;

  on(event, listener) {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event, ...args) { for (const l of this.#listeners.get(event) ?? []) l(...args); }

  #fail(error) {
    this.destroyed = true;
    try { this.#controller.error(error); } catch { /* already closed */ }
    this.emit("error", error);
    this.emit("close");
  }

  // Text and bytes go in now; a stream (a stored media file) is read to its end first, and entries are added in the order
  // append() was called: `#ordered` is the end of the previous one.
  #ordered = Promise.resolve();

  append(content, { name }) {
    if (this.destroyed) return this;
    const add = (bytes) => {
      if (this.destroyed) return;
      const entry = new ZipDeflate(name, { level: this.#level });
      this.#zip.add(entry);
      entry.push(bytes, true);
      this.emit("entry", { name });
    };
    if (typeof content === "string") this.#ordered = this.#ordered.then(() => add(strToU8(content)));
    else if (content instanceof Uint8Array) this.#ordered = this.#ordered.then(() => add(content));
    else if (content && typeof content[Symbol.asyncIterator] === "function") {
      this.#ordered = this.#ordered.then(async () => {
        const parts = [];
        let size = 0;
        for await (const part of content) { parts.push(part); size += part.byteLength; }
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
        add(bytes);
      }).catch((error) => this.#fail(error));
    } else this.#ordered = this.#ordered.then(() => add(new Uint8Array(content)));
    return this;
  }

  file(path) {
    queueMicrotask(() => this.emit("warning", new Error(`${path}: files on disk are not available in the browser app`)));
    return this;
  }

  finalize() {
    this.#finalizing ??= new Promise((resolve) => {
      this.on("close", resolve);
      if (this.destroyed) return resolve();
      this.#ordered.then(() => { if (!this.destroyed) this.#zip.end(); });
    });
    return this.#finalizing;
  }

  destroy(error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    try { this.#controller.error(error ?? new Error("archive destroyed")); } catch { /* already closed */ }
    this.emit("close");
    return this;
  }
}

export default function archiver(format, options) {
  if (format !== "zip") throw new Error(`archiver(${format}) is not available in the browser app`);
  return new Archive(options);
}
