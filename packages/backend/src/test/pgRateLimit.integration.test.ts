// The shared (cross-instance) rate limiter. The in-memory limiter counts per
// process, so N replicas give N× the limit; PgRateLimiter counts in a shared
// Postgres window so the limit holds ACROSS instances. Pinned here: the limit is
// enforced, it's per-token, the window slides, and two limiter instances
// (simulating two replicas) share one count.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { PgRateLimiter, RateLimitError } from "../services/agentTools/index.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("PgRateLimiter (shared, DB)", () => {
  // Every test counts under its own token, so no reset of the shared table.
  const token = (name: string) => `pg-${name}-${randomUUID()}`;

  it("allows up to the limit, then throws (with a positive retry-after)", async () => {
    const lim = new PgRateLimiter(60_000, 3);
    const tok = token("limit");
    for (let i = 0; i < 3; i++) await lim.check(tok);
    await expect(lim.check(tok)).rejects.toThrow(RateLimitError);
    try { await lim.check(tok); } catch (e) {
      expect((e as RateLimitError).retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("is per-token", async () => {
    const lim = new PgRateLimiter(60_000, 1);
    const [ta, tb] = [token("a"), token("b")];
    await lim.check(ta);
    await expect(lim.check(ta)).rejects.toThrow(RateLimitError);
    await expect(lim.check(tb)).resolves.toBeUndefined(); // a different token is fresh
  });

  it("two limiter instances (simulated replicas) SHARE one count", async () => {
    const a = new PgRateLimiter(60_000, 2);
    const b = new PgRateLimiter(60_000, 2);
    const tok = token("shared");
    await a.check(tok);                                   // 1 hit
    await b.check(tok);                                   // 2 hits — shared store
    await expect(a.check(tok)).rejects.toThrow(RateLimitError); // over the limit across BOTH
  });

  it("CONCURRENT checks for one token never exceed the limit (per-token atomicity)", async () => {
    // Two limiter instances = two replicas; fire limit+5 checks for the SAME token
    // all at once. The advisory-xact-lock must serialise them so EXACTLY `limit`
    // succeed and the rest throw — not `limit + concurrency` (the non-atomic bug).
    const a = new PgRateLimiter(60_000, 3);
    const b = new PgRateLimiter(60_000, 3);
    const tok = token("conc");
    const reps = [a, b, a, b, a, b, a, b]; // 8 concurrent attempts, limit 3
    const results = await Promise.allSettled(reps.map((lim) => lim.check(tok)));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    expect(ok).toBe(3);
    expect(rejected).toBe(5);
  });

  it("a window-expired hit ages out (count uses the window predicate)", async () => {
    // A minute's window, and the hit is moved past it in the table: a 50 ms
    // window and a 70 ms sleep let a slow second check land after the window
    // too, under load.
    const lim = new PgRateLimiter(60_000, 1);
    const tok = token("win");
    await lim.check(tok);
    await expect(lim.check(tok)).rejects.toThrow(RateLimitError);
    await q(`UPDATE rate_limit_hits SET hit_at = hit_at - interval '61 seconds' WHERE token_id = $1`, [tok]); // past the window
    await expect(lim.check(tok)).resolves.toBeUndefined();
  });
});
