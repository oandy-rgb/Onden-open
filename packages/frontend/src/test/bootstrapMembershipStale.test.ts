// A bootstrap that lands after the mirror's membership epoch moved makes the
// next sync check the readable set again (late bootstrap, 03aa0a38) — but not
// when the payload lists the readable set of the epoch the mirror now holds.
// Re-checking then raised the fail-closed gate ~0.5 s after load on a fresh
// device, which took focus from the editor and ended an IME composition
// (imeEditor e2e, 2026-11-01).
import { describe, expect, it } from "vitest";
import { bootstrapMembershipStale } from "../lib/data/syncEngine";

describe("a bootstrap that lands late", () => {
  it("is stale when membership changed after its snapshot", () => {
    // requested at epoch 4, listed at 4, the mirror reconciled to 5 meanwhile
    expect(bootstrapMembershipStale(4, 5, 4)).toBe(true);
  });

  it("is current when it already lists the epoch the mirror caught up to", () => {
    // a fresh device: nothing reconciled at request (0), the first reconcile
    // reached 1, and the payload was read at 1
    expect(bootstrapMembershipStale(0, 1, 1)).toBe(false);
  });

  it("an older server (no epoch in the payload) is checked again whenever the epoch moved", () => {
    expect(bootstrapMembershipStale(0, 1, undefined)).toBe(true);
  });

  it("nothing moved: no check", () => {
    expect(bootstrapMembershipStale(3, 3, 3)).toBe(false);
    expect(bootstrapMembershipStale(undefined, 3, 2)).toBe(false);
  });
});
