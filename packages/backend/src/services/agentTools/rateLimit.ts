// Sliding-window rate limiter, one bucket per key (the tool registry keys it
// on the actor).
//
// Two backends behind one pluggable contract:
//   • InMemoryRateLimiter (default) — per-process. Under N replicas a key can
//     do N× the limit (each instance counts independently). Fine for a single
//     instance.
//   • PgRateLimiter — a SHARED, cross-instance limiter backed by a Postgres
//     hits table, so a horizontally-scaled deployment enforces the real limit.
//     Installed at startup when RATE_LIMIT_BACKEND=pg (see index.ts).
//
// `check()` is async (a shared store is inherently async). Call sites use the
// module-level `checkRateLimit()` which delegates to the installed limiter.

import { pool } from "../../db.js";

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT_PER_MINUTE = 60;

export class RateLimitError extends Error {
  constructor(public retryAfterSeconds: number, message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Pluggable rate-limiter contract. Implementations decide where bucket state
 * lives (memory for single-process; a shared store for multi-replica).
 */
export interface RateLimiter {
  /** Record a hit if allowed; throw RateLimitError if over the limit. */
  check(key: string, limit?: number): Promise<void>;
  /** Drop all state. Used by tests and on reconfigure. */
  reset(): Promise<void>;
}

/**
 * Default in-memory limiter. Buckets are pruned lazily on each check; a token
 * that goes silent is cleaned up naturally as its window expires (no sweeper).
 *
 * Per-process only — see the deployment note at the top of this file.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly windowMs = WINDOW_MS,
    private readonly defaultLimit = DEFAULT_LIMIT_PER_MINUTE,
  ) {}

  async check(key: string, limit = this.defaultLimit): Promise<void> {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const bucket = (this.buckets.get(key) ?? []).filter((t) => t > cutoff);
    if (bucket.length >= limit) {
      // Retry-after = how long until the oldest hit ages out.
      const retryMs = this.windowMs - (now - bucket[0]);
      throw new RateLimitError(
        Math.ceil(retryMs / 1000),
        `Rate limit exceeded for ${key} (${limit} req/min)`,
      );
    }
    bucket.push(now);
    this.buckets.set(key, bucket);
  }

  async reset(): Promise<void> {
    this.buckets.clear();
  }
}

/**
 * Shared, cross-instance limiter — a sliding window over a Postgres hits table.
 *
 * The count→gated-insert MUST be atomic per token, else two replicas that both
 * read `limit - 1` would both insert and exceed the limit by the concurrency
 * count (a single-statement snapshot does NOT see another transaction's
 * uncommitted insert). We take a transaction-scoped advisory lock keyed on the
 * token (pg_advisory_xact_lock(hashtext(token))) so checks for the SAME token
 * serialize across ALL instances — each sees the prior's committed hit before
 * counting. The lock auto-releases at commit; different tokens never contend
 * (a hash collision only serialises two unrelated tokens, harmless). Inside the
 * lock: prune aged-out rows, count the window (predicate-based, correct
 * regardless of GC), and insert iff under the limit.
 */
export class PgRateLimiter implements RateLimiter {
  constructor(
    private readonly windowMs = WINDOW_MS,
    private readonly defaultLimit = DEFAULT_LIMIT_PER_MINUTE,
  ) {}

  async check(key: string, limit = this.defaultLimit): Promise<void> {
    const windowSecs = this.windowMs / 1000;
    const client = await pool.connect();
    let inserted = false;
    let oldestEpoch: number | null = null;
    try {
      await client.query("BEGIN");
      // Serialise this token's check across instances for the life of the tx.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      await client.query(
        `DELETE FROM rate_limit_hits WHERE token_id = $1 AND hit_at < now() - make_interval(secs => $2)`,
        [key, windowSecs],
      );
      const cnt = await client.query<{ n: number; oldest_epoch: number | null }>(
        `SELECT count(*)::int AS n, EXTRACT(EPOCH FROM min(hit_at))::float8 AS oldest_epoch
           FROM rate_limit_hits
          WHERE token_id = $1 AND hit_at >= now() - make_interval(secs => $2)`,
        [key, windowSecs],
      );
      oldestEpoch = cnt.rows[0]!.oldest_epoch;
      if (cnt.rows[0]!.n < limit) {
        await client.query("INSERT INTO rate_limit_hits (token_id) VALUES ($1)", [key]);
        inserted = true;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (!inserted) {
      const retryMs = oldestEpoch != null
        ? this.windowMs - (Date.now() - oldestEpoch * 1000)
        : this.windowMs;
      throw new RateLimitError(
        Math.max(1, Math.ceil(retryMs / 1000)),
        `Rate limit exceeded for ${key} (${limit} req/min)`,
      );
    }
  }

  async reset(): Promise<void> {
    await pool.query("DELETE FROM rate_limit_hits");
  }
}

// Active limiter — swappable at startup for multi-replica deployments.
let activeLimiter: RateLimiter = new InMemoryRateLimiter();

/**
 * Install a different limiter backend (e.g. the shared pg-backed one for
 * horizontally-scaled deployments). Call once at startup before serving.
 */
export function setRateLimiter(limiter: RateLimiter): void {
  activeLimiter = limiter;
}

/** The currently installed limiter. */
export function getRateLimiter(): RateLimiter {
  return activeLimiter;
}

/** Check the bucket. Records a hit if allowed; throws RateLimitError if not. */
export function checkRateLimit(key: string, limit = DEFAULT_LIMIT_PER_MINUTE): Promise<void> {
  return activeLimiter.check(key, limit);
}

/** Test helper. Production code should not need this. */
export function _resetRateLimits(): Promise<void> {
  return activeLimiter.reset();
}
