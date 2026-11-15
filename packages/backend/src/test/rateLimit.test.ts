import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  checkRateLimit,
  RateLimitError,
  _resetRateLimits,
  InMemoryRateLimiter,
  setRateLimiter,
  getRateLimiter,
  type RateLimiter,
} from "../services/agentTools/rateLimit.js";

beforeEach(() => _resetRateLimits());

describe("checkRateLimit", () => {
  it("allows up to the limit, then throws RateLimitError", async () => {
    for (let i = 0; i < 60; i++) await checkRateLimit("tok-1", 60);
    await expect(checkRateLimit("tok-1", 60)).rejects.toThrow(RateLimitError);
  });

  it("returns retryAfterSeconds approximating remaining window", async () => {
    for (let i = 0; i < 5; i++) await checkRateLimit("tok-2", 5);
    try {
      await checkRateLimit("tok-2", 5);
    } catch (e) {
      const err = e as RateLimitError;
      expect(err.retryAfterSeconds).toBeGreaterThan(0);
      expect(err.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("buckets are per-token (different tokens don't share)", async () => {
    for (let i = 0; i < 3; i++) await checkRateLimit("tok-a", 3);
    await expect(checkRateLimit("tok-a", 3)).rejects.toThrow(RateLimitError);
    // tok-b is fresh
    await expect(checkRateLimit("tok-b", 3)).resolves.toBeUndefined();
  });

  it("window slides — old hits age out", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-05T00:00:00Z"));
      for (let i = 0; i < 5; i++) await checkRateLimit("tok-3", 5);
      await expect(checkRateLimit("tok-3", 5)).rejects.toThrow(RateLimitError);
      // Advance past the window
      vi.setSystemTime(new Date("2026-06-05T00:01:01Z"));
      await expect(checkRateLimit("tok-3", 5)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pluggable limiter", () => {
  afterEach(() => {
    // Restore the default in-memory limiter so other tests are unaffected.
    setRateLimiter(new InMemoryRateLimiter());
  });

  it("checkRateLimit delegates to the installed limiter", async () => {
    const calls: Array<{ tokenId: string; limit?: number }> = [];
    const fake: RateLimiter = {
      check: async (tokenId, limit) => { calls.push({ tokenId, limit }); },
      reset: async () => {},
    };
    setRateLimiter(fake);
    expect(getRateLimiter()).toBe(fake);

    await checkRateLimit("tok-x", 7);
    expect(calls).toEqual([{ tokenId: "tok-x", limit: 7 }]);
  });

  it("a swapped limiter can enforce its own policy (shared-store seam)", async () => {
    // Simulate a shared store that always rejects — proves the seam is the
    // single point a multi-replica deployment overrides.
    const always: RateLimiter = {
      check: async () => {
        throw new RateLimitError(1, "shared store says no");
      },
      reset: async () => {},
    };
    setRateLimiter(always);
    await expect(checkRateLimit("tok-y")).rejects.toThrow(RateLimitError);
  });

  it("_resetRateLimits resets the installed limiter, not a global", async () => {
    let resets = 0;
    setRateLimiter({ check: async () => {}, reset: async () => { resets++; } });
    await _resetRateLimits();
    expect(resets).toBe(1);
  });

  it("InMemoryRateLimiter instances are independent (no shared module state)", async () => {
    const a = new InMemoryRateLimiter(60_000, 2);
    const b = new InMemoryRateLimiter(60_000, 2);
    await a.check("t");
    await a.check("t");
    await expect(a.check("t")).rejects.toThrow(RateLimitError);
    // b has its own buckets — the same token is fresh.
    await expect(b.check("t")).resolves.toBeUndefined();
  });
});

afterEach(() => _resetRateLimits());
