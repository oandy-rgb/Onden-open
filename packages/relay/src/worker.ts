// Cloudflare Workers entry. All rules live in sessionCore / limiterCore / handler; this file only maps them onto
// Durable Objects (SQLite-backed). It is not importable from Node (it imports "cloudflare:workers").
import { DurableObject } from "cloudflare:workers";
import { createRelayHandler } from "./handler.ts";
import { RateLimiterCore, RegistryCore, type KeyValueStorage } from "./limiterCore.ts";
import { STORAGE_PART_BYTES } from "./limits.ts";
import { SessionCore, type SessionMeta, type SessionStorage } from "./sessionCore.ts";
import type { ObjectEntry, Outcome, RateLimiterApi, RegistryApi, SessionApi } from "./types.ts";

interface Env {
  SESSIONS: DurableObjectNamespace<SessionObject>;
  LIMITERS: DurableObjectNamespace<LimiterObject>;
  REGISTRY: DurableObjectNamespace<RegistryObject>;
  /** Optional: the one page origin allowed by CORS. Unset means any origin. */
  ALLOWED_ORIGIN?: string;
}

const REGISTRY_NAME = "registry";

class DurableSessionStorage implements SessionStorage {
  readonly #state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.#state = state;
  }
  getMeta() {
    return this.#state.storage.get<SessionMeta>("meta");
  }
  async putMeta(meta: SessionMeta) {
    await this.#state.storage.put("meta", meta);
  }
  async getBlob(name: string) {
    const count = await this.#state.storage.get<number>(`b:${name}`);
    if (count === undefined) return undefined;
    const parts = await this.#state.storage.get<Uint8Array>(Array.from({ length: count }, (_, i) => `b:${name}:${i}`));
    const pieces = Array.from({ length: count }, (_, i) => parts.get(`b:${name}:${i}`)!);
    const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of pieces) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }
  async putBlob(name: string, bytes: Uint8Array) {
    const count = Math.max(1, Math.ceil(bytes.length / STORAGE_PART_BYTES));
    const entries: Record<string, unknown> = { [`b:${name}`]: count };
    for (let i = 0; i < count; i++) entries[`b:${name}:${i}`] = bytes.slice(i * STORAGE_PART_BYTES, (i + 1) * STORAGE_PART_BYTES);
    await this.#state.storage.put(entries);
  }
  async deleteAll() {
    await this.#state.storage.deleteAll();
  }
  setAlarm(at: number) {
    return this.#state.storage.setAlarm(at);
  }
  deleteAlarm() {
    return this.#state.storage.deleteAlarm();
  }
}

class DurableKeyValue implements KeyValueStorage {
  readonly #state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.#state = state;
  }
  get<T>(key: string) {
    return this.#state.storage.get<T>(key);
  }
  async put<T>(key: string, value: T) {
    await this.#state.storage.put(key, value);
  }
  async delete(key: string) {
    await this.#state.storage.delete(key);
  }
  async list<T>() {
    return this.#state.storage.list<T>();
  }
}

/** One per session id. The alarm deletes the session 2 hours after its last write. */
export class SessionObject extends DurableObject<Env> implements SessionApi {
  readonly #core: SessionCore;
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    // On deletion tell the registry its slot is free (it would expire by itself anyway).
    const sessionId = state.id.name;
    this.#core = new SessionCore(new DurableSessionStorage(state), Date.now, async () => {
      if (sessionId) await env.REGISTRY.get(env.REGISTRY.idFromName(REGISTRY_NAME)).release(sessionId);
    });
  }
  putHello(hello: Uint8Array) {
    return this.#core.putHello(hello);
  }
  getHello() {
    return this.#core.getHello();
  }
  putObject(name: string, bytes: Uint8Array, writeToken: string, readTokenHash: string | undefined) {
    return this.#core.putObject(name, bytes, writeToken, readTokenHash);
  }
  listObjects(readToken: string): Promise<Outcome<ObjectEntry[]>> {
    return this.#core.listObjects(readToken);
  }
  getObject(name: string, readToken: string) {
    return this.#core.getObject(name, readToken);
  }
  destroy(readToken: string) {
    return this.#core.destroy(readToken);
  }
  async alarm() {
    await this.#core.onAlarm();
  }
}

/** One per source address. */
export class LimiterObject extends DurableObject<Env> implements RateLimiterApi {
  readonly #core: RateLimiterCore;
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#core = new RateLimiterCore(new DurableKeyValue(state));
  }
  hit(newSession: boolean) {
    return this.#core.hit(newSession);
  }
}

/** A single instance counting live sessions. */
export class RegistryObject extends DurableObject<Env> implements RegistryApi {
  readonly #core: RegistryCore;
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#core = new RegistryCore(new DurableKeyValue(state));
  }
  acquire(sessionId: string, hardExpiresAt: number) {
    return this.#core.acquire(sessionId, hardExpiresAt);
  }
  release(sessionId: string) {
    return this.#core.release(sessionId);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return createRelayHandler({
      allowedOrigin: env.ALLOWED_ORIGIN ?? "*",
      registry: env.REGISTRY.get(env.REGISTRY.idFromName(REGISTRY_NAME)),
      rateLimiter: (sourceKey) => env.LIMITERS.get(env.LIMITERS.idFromName(sourceKey)),
      session: (sessionId) => env.SESSIONS.get(env.SESSIONS.idFromName(sessionId)),
    })(request);
  },
};
