// stream: the small part of Node's streams the browser app's backend uses.
//   • A zip built by archiver.mjs carries its web stream; Readable.toWeb hands it over (exports, the full backup).
//   • Reading a backup upload (routes/backup.ts → services/backupFile.ts): Readable.fromWeb(request body) → pipeline →
//     a Transform that counts the size → a write stream into vfs.mjs; and reading the zip's entries back through
//     PassThrough (yauzl.mjs). Async iteration, pipe(), on("error"|"finish"|"end"|"data") and destroy() are what is used.
// Not a general implementation: no back-pressure (everything is in memory anyway), objectMode, cork or highWaterMark.
const { EventEmitter } = require("events");

class Readable extends EventEmitter {
  constructor() { super(); this._chunks = []; this._ended = false; this._error = null; this._waiters = []; }
  static from(iterable) {
    const r = new Readable();
    (async () => { try { for await (const c of iterable) r.push(c); r.push(null); } catch (e) { r.destroy(e); } })();
    return r;
  }
  /** An async-iterable over a web ReadableStream, with Node's stream methods. */
  static fromWeb(web) {
    const r = new Readable();
    (async () => {
      const reader = web.getReader();
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; r.push(value); } r.push(null); } catch (e) { r.destroy(e); }
    })();
    return r;
  }
  static toWeb(x) { return x && x.stream instanceof ReadableStream ? x.stream : x; }
  push(chunk) {
    if (chunk === null) this._ended = true; else this._chunks.push(chunk);
    for (const wake of this._waiters.splice(0)) wake();
    if (chunk !== null) this.emit("data", chunk); else this.emit("end");
    return true;
  }
  destroy(error) {
    this._error = error ?? null; this._ended = true;
    for (const wake of this._waiters.splice(0)) wake();
    if (error && this.listenerCount("error") > 0) this.emit("error", error);
    return this;
  }
  pipe(dest) {
    (async () => { try { for await (const c of this) dest.write(c); dest.end(); } catch (e) { dest.destroy ? dest.destroy(e) : dest.emit("error", e); } })();
    return dest;
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this._chunks.length) { yield this._chunks.shift(); continue; }
      if (this._error) throw this._error;
      if (this._ended) return;
      await new Promise((resolve) => this._waiters.push(resolve));
    }
  }
}

/** Writable side + readable side in one: what is written can be iterated (and piped on). */
class PassThrough extends Readable {
  write(chunk) { this.push(chunk); return true; }
  end() { if (!this._ended) this.push(null); this.emit("finish"); }
}

class Transform extends PassThrough {
  constructor(options) { super(); this._transform = options && options.transform; }
  write(chunk, encoding) {
    this._transform.call(this, chunk, encoding || "buffer", (error, out) => {
      if (error) this.destroy(error); else if (out !== undefined && out !== null) this.push(out);
    });
    return true;
  }
}

/** pipeline(source, ...transforms, destination): iterate the source, push through each Transform, write into the destination. */
async function pipeline(source, ...rest) {
  const destination = rest[rest.length - 1];
  const middle = rest.slice(0, -1);
  const finished = new Promise((resolve, reject) => { destination.on("finish", resolve); destination.on("error", reject); });
  finished.catch(() => {});
  let stages = source;
  for (const t of middle) {
    const next = t;
    const feeding = (async () => { try { for await (const c of stages) next.write(c); next.end(); } catch (e) { next.destroy(e); } })();
    feeding.catch(() => {});
    stages = next;
  }
  try {
    for await (const c of stages) destination.write(c);
  } catch (error) {
    if (destination.destroy) destination.destroy();
    throw error;
  }
  destination.end();
  await finished;
}

module.exports = { Readable, Transform, PassThrough, pipeline };
