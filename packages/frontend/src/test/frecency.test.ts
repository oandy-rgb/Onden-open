import { describe, it, expect, beforeEach } from "vitest";
import { scoreEntry, rankByFrecency, recordOpen, getFrecency, type FrecencyStore } from "../lib/frecency";
import { bindAccountStorage } from "../lib/accountStorage";

// The open history names the account's notes, so it is kept per account.
bindAccountStorage("user-1", "");

const HOUR = 3_600_000;
const NOW = 1_000_000_000_000;

describe("frecency scoring", () => {
  it("scores 0 for missing / empty history", () => {
    expect(scoreEntry(undefined, NOW)).toBe(0);
    expect(scoreEntry({ n: 0, t: NOW }, NOW)).toBe(0);
  });

  it("weights recent opens far above old ones", () => {
    const recent = scoreEntry({ n: 1, t: NOW - 0.5 * HOUR }, NOW); // <1h → ×100
    const old = scoreEntry({ n: 1, t: NOW - 40 * 24 * HOUR }, NOW); // >1mo → ×2
    expect(recent).toBe(100);
    expect(old).toBe(2);
    expect(recent).toBeGreaterThan(old);
  });

  it("frequency multiplies within the same recency bucket", () => {
    expect(scoreEntry({ n: 3, t: NOW - 2 * HOUR }, NOW)).toBe(3 * 40); // <1d bucket
  });

  it("a single open today can outrank many opens last month", () => {
    const today = scoreEntry({ n: 1, t: NOW - 0.5 * HOUR }, NOW);   // 100
    const lastMonth = scoreEntry({ n: 5, t: NOW - 40 * 24 * HOUR }, NOW); // 10
    expect(today).toBeGreaterThan(lastMonth);
  });
});

describe("rankByFrecency", () => {
  it("floats high-frecency ids up; unknown ids keep input order (stable)", () => {
    const store: FrecencyStore = {
      a: { n: 1, t: NOW - 40 * 24 * HOUR }, // old, low
      c: { n: 2, t: NOW - 0.2 * HOUR },     // recent, high
    };
    // input order: a, b, c — b has no history
    expect(rankByFrecency(["a", "b", "c"], store, NOW)).toEqual(["c", "a", "b"]);
  });

  it("with no history at all, returns the input order unchanged (zero-regression)", () => {
    expect(rankByFrecency(["x", "y", "z"], {}, NOW)).toEqual(["x", "y", "z"]);
  });
});

describe("recordOpen (per-account storage)", () => {
  beforeEach(() => localStorage.clear());
  it("bumps count + stamps the open time", () => {
    recordOpen("n1", NOW);
    recordOpen("n1", NOW + HOUR);
    const store = getFrecency();
    expect(store.n1).toEqual({ n: 2, t: NOW + HOUR });
  });
  it("ignores an empty id", () => {
    recordOpen("", NOW);
    expect(Object.keys(getFrecency())).toHaveLength(0);
  });
});
