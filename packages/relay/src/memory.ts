import { RateLimiterCore, RegistryCore, type KeyValueStorage } from "./limiterCore.ts";
import { createRelayHandler } from "./handler.ts";
import { SessionCore, type SessionMeta, type SessionStorage } from "./sessionCore.ts";

/** In-memory storage: what the tests run on, and a starting point for a self-hosted relay (see the relay doc). */
export class MemorySessionStorage implements SessionStorage {
  meta: SessionMeta | undefined;
  readonly blobs = new Map<string, Uint8Array>();
  alarmAt: number | null = null;

  async getMeta() {
    return this.meta ? structuredClone(this.meta) : undefined;
  }
  async putMeta(meta: SessionMeta) {
    this.meta = structuredClone(meta);
  }
  async getBlob(name: string) {
    return this.blobs.get(name)?.slice();
  }
  async putBlob(name: string, bytes: Uint8Array) {
    this.blobs.set(name, bytes.slice());
  }
  async deleteAll() {
    this.meta = undefined;
    this.blobs.clear();
  }
  async setAlarm(at: number) {
    this.alarmAt = at;
  }
  async deleteAlarm() {
    this.alarmAt = null;
  }
}

export class MemoryKeyValue implements KeyValueStorage {
  readonly map = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.map.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async list<T>() {
    return new Map(this.map) as Map<string, T>;
  }
}

export interface MemoryRelay {
  handler: (request: Request) => Promise<Response>;
  sessions: Map<string, { core: SessionCore; storage: MemorySessionStorage }>;
  registry: RegistryCore;
  limiters: Map<string, RateLimiterCore>;
  /** Run the alarms that are due, the way Durable Objects would. */
  runDueAlarms(): Promise<void>;
}

/** The complete relay in one process, for tests and local experiments. */
export function createMemoryRelay(options: { now?: () => number; allowedOrigin?: string; maxActiveSessions?: number } = {}): MemoryRelay {
  const now = options.now ?? Date.now;
  const registry = new RegistryCore(new MemoryKeyValue(), now, options.maxActiveSessions);
  const sessions = new Map<string, { core: SessionCore; storage: MemorySessionStorage }>();
  const limiters = new Map<string, RateLimiterCore>();
  const handler = createRelayHandler({
    now,
    allowedOrigin: options.allowedOrigin ?? "*",
    registry,
    rateLimiter(key) {
      if (!limiters.has(key)) limiters.set(key, new RateLimiterCore(new MemoryKeyValue(), now));
      return limiters.get(key)!;
    },
    session(sessionId) {
      let entry = sessions.get(sessionId);
      if (!entry) {
        const storage = new MemorySessionStorage();
        entry = { storage, core: new SessionCore(storage, now, () => registry.release(sessionId)) };
        sessions.set(sessionId, entry);
      }
      return entry.core;
    },
  });
  return {
    handler,
    sessions,
    registry,
    limiters,
    async runDueAlarms() {
      for (const { core, storage } of sessions.values()) if (storage.alarmAt !== null && storage.alarmAt <= now()) await core.onAlarm();
    },
  };
}
