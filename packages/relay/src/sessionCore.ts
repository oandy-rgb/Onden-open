import { constantTimeEqual, hashToken, sameBytes } from "./crypto.ts";
import { MAX_HELLO_BYTES, MAX_OBJECT_BYTES, MAX_OBJECTS_PER_SESSION, SESSION_IDLE_TTL_MS, SESSION_MAX_BYTES, SESSION_MAX_LIFETIME_MS } from "./limits.ts";
import type { ObjectEntry, Outcome, SessionApi } from "./types.ts";

export interface SessionMeta {
  createdAt: number;
  lastWriteAt: number;
  hello: Uint8Array;
  /** Hash of the page's write token and of the phone's read token, registered by the first write. */
  writeHash?: string;
  readHash?: string;
  objects: Record<string, number>;
  totalBytes: number;
}

/** Where one session keeps its state. The Durable Object and the in-memory test store both implement it. */
export interface SessionStorage {
  getMeta(): Promise<SessionMeta | undefined>;
  putMeta(meta: SessionMeta): Promise<void>;
  getBlob(name: string): Promise<Uint8Array | undefined>;
  putBlob(name: string, bytes: Uint8Array): Promise<void>;
  /** Remove everything this session stored, blobs and meta. */
  deleteAll(): Promise<void>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

const ok = <T>(status: number, value: T): Outcome<T> => ({ ok: true, status, value });
const fail = (status: number, error: Extract<Outcome<never>, { ok: false }>["error"]): Outcome<never> => ({ ok: false, status, error });
const NOT_FOUND = fail(404, "not_found");

const expiresAt = (meta: SessionMeta): number => Math.min(meta.lastWriteAt + SESSION_IDLE_TTL_MS, meta.createdAt + SESSION_MAX_LIFETIME_MS);

/**
 * One session's rules. Content-blind: it stores bytes it cannot read and checks only tokens and sizes.
 * A missing session, a wrong token and a missing object all answer the same 404.
 */
export class SessionCore implements SessionApi {
  readonly #storage: SessionStorage;
  readonly #now: () => number;
  readonly #onGone: () => Promise<void>;

  constructor(storage: SessionStorage, now: () => number = Date.now, onGone: () => Promise<void> = async () => {}) {
    this.#storage = storage;
    this.#now = now;
    this.#onGone = onGone;
  }

  /** The live session, or undefined. An expired session is deleted on the spot, so expiry never depends on the alarm arriving on time. */
  async #load(): Promise<SessionMeta | undefined> {
    const meta = await this.#storage.getMeta();
    if (!meta) return undefined;
    if (this.#now() >= expiresAt(meta)) {
      await this.#wipe();
      return undefined;
    }
    return meta;
  }

  async #wipe(): Promise<void> {
    await this.#storage.deleteAlarm();
    await this.#storage.deleteAll();
    await this.#onGone();
  }

  async #touch(meta: SessionMeta): Promise<void> {
    meta.lastWriteAt = this.#now();
    await this.#storage.putMeta(meta);
    await this.#storage.setAlarm(expiresAt(meta));
  }

  async #authorizeRead(meta: SessionMeta | undefined, token: string): Promise<boolean> {
    // Hash even when there is nothing to compare with, so the work done does not depend on whether the session exists.
    const presented = await hashToken(token);
    return meta?.readHash !== undefined && constantTimeEqual(presented, meta.readHash);
  }


  // Operations read the session, await (token hashing, storage), then write it back. Run one at a time,
  // or two concurrent writes would each start from the same state and one update would be lost.
  #tail: Promise<unknown> = Promise.resolve();
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(run, run);
    this.#tail = result.catch(() => {});
    return result;
  }

  putHello(hello: Uint8Array) {
    return this.#serial(() => this.#putHello(hello));
  }
  getHello() {
    return this.#serial(() => this.#getHello());
  }
  putObject(name: string, bytes: Uint8Array, writeToken: string, readTokenHash: string | undefined) {
    return this.#serial(() => this.#putObject(name, bytes, writeToken, readTokenHash));
  }
  listObjects(readToken: string) {
    return this.#serial(() => this.#listObjects(readToken));
  }
  getObject(name: string, readToken: string) {
    return this.#serial(() => this.#getObject(name, readToken));
  }
  destroy(readToken: string) {
    return this.#serial(() => this.#destroy(readToken));
  }

  async #putHello(hello: Uint8Array): Promise<Outcome<null>> {
    if (hello.length === 0 || hello.length > MAX_HELLO_BYTES) return fail(413, "too_large");
    const meta = await this.#load();
    if (!meta) {
      const now = this.#now();
      const created: SessionMeta = { createdAt: now, lastWriteAt: now, hello: hello.slice(), objects: {}, totalBytes: 0 };
      await this.#storage.putMeta(created);
      await this.#storage.setAlarm(expiresAt(created));
      return ok(201, null);
    }
    // First writer wins; repeating the same answer (a retry) is fine.
    return sameBytes(meta.hello, hello) ? ok(200, null) : fail(409, "conflict");
  }

  async #getHello(): Promise<Outcome<Uint8Array>> {
    const meta = await this.#load();
    return meta ? ok(200, meta.hello) : NOT_FOUND;
  }

  async #putObject(name: string, bytes: Uint8Array, writeToken: string, readTokenHash: string | undefined): Promise<Outcome<null>> {
    const meta = await this.#load();
    const presented = await hashToken(writeToken);
    if (!meta) return NOT_FOUND;
    if (meta.writeHash === undefined) {
      if (readTokenHash === undefined) return NOT_FOUND; // cannot register without it; the HTTP layer rejects this before it gets here
      meta.writeHash = presented;
      meta.readHash = readTokenHash;
    } else if (!constantTimeEqual(presented, meta.writeHash)) {
      return NOT_FOUND;
    }
    if (bytes.length > MAX_OBJECT_BYTES) return fail(413, "too_large");

    const previousSize = meta.objects[name];
    const mutable = name.startsWith("m.");
    if (previousSize !== undefined && !mutable) {
      // Chunks and the final list never change once written; writing the same bytes again is a retry.
      const stored = await this.#storage.getBlob(name);
      return stored && sameBytes(stored, bytes) ? ok(200, null) : fail(409, "conflict");
    }
    const newTotal = meta.totalBytes - (previousSize ?? 0) + bytes.length;
    if (newTotal > SESSION_MAX_BYTES) return fail(413, "session_full");
    if (previousSize === undefined && Object.keys(meta.objects).length >= MAX_OBJECTS_PER_SESSION) return fail(413, "session_full");

    await this.#storage.putBlob(name, bytes);
    meta.objects[name] = bytes.length;
    meta.totalBytes = newTotal;
    await this.#touch(meta);
    return ok(previousSize === undefined ? 201 : 200, null);
  }

  async #listObjects(readToken: string): Promise<Outcome<ObjectEntry[]>> {
    const meta = await this.#load();
    if (!(await this.#authorizeRead(meta, readToken)) || !meta) return NOT_FOUND;
    return ok(200, Object.entries(meta.objects).map(([name, size]) => ({ name, size })).sort((a, b) => (a.name < b.name ? -1 : 1)));
  }

  async #getObject(name: string, readToken: string): Promise<Outcome<Uint8Array>> {
    const meta = await this.#load();
    if (!(await this.#authorizeRead(meta, readToken)) || !meta || meta.objects[name] === undefined) return NOT_FOUND;
    const bytes = await this.#storage.getBlob(name);
    return bytes ? ok(200, bytes) : NOT_FOUND;
  }

  async #destroy(readToken: string): Promise<Outcome<null>> {
    const meta = await this.#load();
    if (!(await this.#authorizeRead(meta, readToken)) || !meta) return NOT_FOUND;
    await this.#wipe();
    return ok(204, null);
  }

  /** Durable Object alarm: delete the session if it is due, otherwise look again at the real expiry. */
  onAlarm(): Promise<void> {
    return this.#serial(() => this.#onAlarm());
  }

  async #onAlarm(): Promise<void> {
    const meta = await this.#storage.getMeta();
    if (!meta) return;
    if (this.#now() >= expiresAt(meta)) await this.#wipe();
    else await this.#storage.setAlarm(expiresAt(meta));
  }
}
