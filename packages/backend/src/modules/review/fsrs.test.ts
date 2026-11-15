// Pure-math tests for the vendored FSRS-4.5 scheduler. No DB — these run in
// the plain (non-integration) suite. The DB-backed loop (enroll → queue →
// grade via HTTP → undo) lives in src/test/reviewModule.integration.test.ts.

import { describe, it, expect } from "vitest";
import type { ReviewRating, ReviewState } from "@onden/contract";
import { DEFAULT_PARAMS, isDue, nextIntervalDays, parseReviewState, retrievability, schedule } from "./fsrs.js";

const T0 = new Date("2026-01-01T00:00:00Z");
const DAY_MS = 86_400_000;
const daysUntilDue = (s: ReviewState, from: Date) =>
  (new Date(s.due).getTime() - from.getTime()) / DAY_MS;

describe("fsrs scheduler", () => {
  it("first grades seed stability from the initial weights (harder grade → sooner)", () => {
    const again = schedule(null, 1, T0);
    const hard = schedule(null, 2, T0);
    const good = schedule(null, 3, T0);
    const easy = schedule(null, 4, T0);
    // Again (S=0.49d) and Hard (S=1.4d) both round to the 1-day floor — the
    // ordering is on stability, the interval floor merely ties them.
    expect(again.stability).toBeLessThan(hard.stability);
    expect(daysUntilDue(again, T0)).toBeLessThanOrEqual(daysUntilDue(hard, T0));
    expect(daysUntilDue(hard, T0)).toBeLessThan(daysUntilDue(good, T0));
    expect(daysUntilDue(good, T0)).toBeLessThan(daysUntilDue(easy, T0));
    // FSRS-4.5 defaults: initial Good stability w[2]=3.7145 → 4-day interval.
    expect(daysUntilDue(good, T0)).toBe(4);
    expect(good.reps).toBe(1);
    expect(good.lapses).toBe(0);
    expect(again.lapses).toBe(1);
  });

  it("repeated Good reviews grow the interval monotonically", () => {
    let state: ReviewState | null = null;
    let now = T0;
    let prevInterval = 0;
    for (let i = 0; i < 5; i++) {
      state = schedule(state, 3, now);
      const interval = daysUntilDue(state, now);
      expect(interval).toBeGreaterThan(prevInterval);
      prevInterval = interval;
      now = new Date(state.due); // review exactly when due
    }
    expect(state!.reps).toBe(5);
    expect(state!.lapses).toBe(0);
  });

  it("Again lapses: interval collapses, stability shrinks, lapses increment", () => {
    let state = schedule(null, 3, T0);
    state = schedule(state, 3, new Date(state.due));
    const matured = state;
    const reviewAt = new Date(matured.due);
    const lapsed = schedule(matured, 1, reviewAt);
    expect(lapsed.stability).toBeLessThan(matured.stability);
    expect(daysUntilDue(lapsed, reviewAt)).toBeLessThan(daysUntilDue(matured, new Date(matured.last_review)));
    expect(lapsed.lapses).toBe(matured.lapses + 1);
    expect(lapsed.reps).toBe(matured.reps + 1);
  });

  it("Easy outschedules Good from the same state; Hard undershoots it", () => {
    const base = schedule(null, 3, T0);
    const at = new Date(base.due);
    const hard = schedule(base, 2, at);
    const good = schedule(base, 3, at);
    const easy = schedule(base, 4, at);
    expect(daysUntilDue(hard, at)).toBeLessThan(daysUntilDue(good, at));
    expect(daysUntilDue(good, at)).toBeLessThan(daysUntilDue(easy, at));
  });

  it("difficulty stays clamped to [1,10] under extreme grade runs", () => {
    let hardRun: ReviewState | null = null;
    let easyRun: ReviewState | null = null;
    let now = T0;
    for (let i = 0; i < 30; i++) {
      hardRun = schedule(hardRun, 1, now);
      easyRun = schedule(easyRun, 4, now);
      now = new Date(now.getTime() + DAY_MS);
    }
    expect(hardRun!.difficulty).toBeLessThanOrEqual(10);
    expect(hardRun!.difficulty).toBeGreaterThanOrEqual(1);
    expect(easyRun!.difficulty).toBeLessThanOrEqual(10);
    expect(easyRun!.difficulty).toBeGreaterThanOrEqual(1);
  });

  it("retrievability is 0.9 at exactly one stability of elapsed time", () => {
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 10);
    expect(retrievability(0, 10)).toBe(1);
  });

  it("nextIntervalDays floors at 1 day and is deterministic", () => {
    expect(nextIntervalDays(0.1)).toBe(1);
    expect(nextIntervalDays(3.7145)).toBe(4);
    expect(nextIntervalDays(1e9)).toBe(36500); // capped at maximumInterval
  });

  it("scheduling is a pure function of (prev, rating, now)", () => {
    const prev = schedule(null, 3, T0);
    const at = new Date("2026-01-10T12:00:00Z");
    for (const rating of [1, 2, 3, 4] as ReviewRating[]) {
      expect(schedule(prev, rating, at)).toEqual(schedule(prev, rating, at));
    }
  });

  it("parseReviewState round-trips and degrades corrupt blobs to null (new card)", () => {
    const state = schedule(null, 3, T0);
    expect(parseReviewState(JSON.stringify(state))).toEqual(state);
    expect(parseReviewState(null)).toBeNull();
    expect(parseReviewState("")).toBeNull();
    expect(parseReviewState("not json")).toBeNull();
    expect(parseReviewState("{\"due\":42}")).toBeNull();
  });

  // ⑥ pack-borne ECA: the params knob the #review tag's behaviour turns.
  it("lower requestRetention stretches intervals; higher compresses them", () => {
    const S = 30; // a mature stability, well past the 1-day floor
    const dflt = nextIntervalDays(S);
    const lax = nextIntervalDays(S, { ...DEFAULT_PARAMS, requestRetention: 0.8 });
    const strict = nextIntervalDays(S, { ...DEFAULT_PARAMS, requestRetention: 0.97 });
    expect(lax).toBeGreaterThan(dflt);
    expect(strict).toBeLessThan(dflt);
  });

  it("maximumIntervalDays caps the schedule; params flow through schedule()", () => {
    const capped = { ...DEFAULT_PARAMS, maximumIntervalDays: 3 };
    let st: ReviewState | null = null;
    let now = T0;
    for (let i = 0; i < 6; i++) {
      st = schedule(st, 4, now); // Easy every time — intervals balloon
      now = new Date(st.due);
    }
    expect(daysUntilDue(st!, new Date(st!.last_review))).toBeGreaterThan(3);
    const cappedNext = schedule(st, 4, now, capped);
    expect(daysUntilDue(cappedNext, now)).toBe(3);
    // default params arg ≡ omitting it
    expect(schedule(st, 4, now, DEFAULT_PARAMS)).toEqual(schedule(st, 4, now));
  });

  it("isDue: new cards are due immediately; scheduled cards honor their due time", () => {
    expect(isDue(null, T0)).toBe(true);
    const state = schedule(null, 3, T0);
    expect(isDue(state, T0)).toBe(false);
    expect(isDue(state, new Date(state.due))).toBe(true);
  });
});
