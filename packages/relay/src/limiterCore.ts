import { MAX_ACTIVE_SESSIONS, MAX_NEW_SESSIONS_PER_HOUR_PER_IP, MAX_REQUESTS_PER_MINUTE_PER_IP } from "./limits.ts";
import type { Outcome, RateLimiterApi, RegistryApi } from "./types.ts";

/** Small key-value store both limiter kinds need (a Durable Object's storage, or a Map in tests). */
export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(): Promise<Map<string, T>>;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const limited: Outcome<never> = { ok: false, status: 429, error: "rate_limited" };
const done: Outcome<null> = { ok: true, status: 200, value: null };

interface Window {
  start: number;
  count: number;
}

/** Fixed-window counters for one source address: requests per minute and new sessions per hour. */
export class RateLimiterCore implements RateLimiterApi {
  readonly #storage: KeyValueStorage;
  readonly #now: () => number;

  constructor(storage: KeyValueStorage, now: () => number = Date.now) {
    this.#storage = storage;
    this.#now = now;
  }

  async #bump(key: string, length: number, max: number, increment: boolean): Promise<boolean> {
    const now = this.#now();
    let window = await this.#storage.get<Window>(key);
    if (!window || now - window.start >= length) window = { start: now, count: 0 };
    if (window.count >= max) return false;
    if (increment) {
      window.count += 1;
      await this.#storage.put(key, window);
    }
    return true;
  }

  async hit(newSession: boolean): Promise<Outcome<null>> {
    // Check the session allowance first so a refused creation does not use up a request.
    if (newSession && !(await this.#bump("sessions", HOUR, MAX_NEW_SESSIONS_PER_HOUR_PER_IP, false))) return limited;
    if (!(await this.#bump("requests", MINUTE, MAX_REQUESTS_PER_MINUTE_PER_IP, true))) return limited;
    if (newSession) await this.#bump("sessions", HOUR, MAX_NEW_SESSIONS_PER_HOUR_PER_IP, true);
    return done;
  }
}

/** Counts live sessions across all sources. Each entry remembers when the session must be over, so a lost `release` heals itself. */
export class RegistryCore implements RegistryApi {
  readonly #storage: KeyValueStorage;
  readonly #now: () => number;
  readonly #max: number;

  constructor(storage: KeyValueStorage, now: () => number = Date.now, max: number = MAX_ACTIVE_SESSIONS) {
    this.#storage = storage;
    this.#now = now;
    this.#max = max;
  }

  async acquire(sessionId: string, hardExpiresAt: number): Promise<Outcome<null>> {
    const now = this.#now();
    const entries = await this.#storage.list<number>();
    let live = 0;
    for (const [id, expiresAt] of entries) {
      if (expiresAt <= now) await this.#storage.delete(id);
      else if (id === sessionId) return done;
      else live += 1;
    }
    if (live >= this.#max) return { ok: false, status: 503, error: "capacity" };
    await this.#storage.put(sessionId, hardExpiresAt);
    return done;
  }

  async release(sessionId: string): Promise<void> {
    await this.#storage.delete(sessionId);
  }
}
