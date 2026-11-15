// Property-based hardening of the FSRS scheduler (modules/review/fsrs).
//
// DB-free, fixed fc seed, capped runs. For ANY rating history with ANY
// elapsed-time pattern (including reviewing early, on time, and years late):
//
//   • stability is never NaN / negative (clamped to >= 0.1)
//   • difficulty stays inside [1, 10]
//   • the next interval is a whole number of days in [1, 36500]
//   • due always advances from the review time (due > now)
//   • grading Easy (4) never schedules SOONER than grading Again (1)
//     from the same prior state at the same moment
//   • reps/lapses counters are consistent with the history

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import type { ReviewRating, ReviewState } from "@onden/contract";
import { schedule, isDue, parseReviewState } from "../../modules/review/fsrs.js";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

const DAY_MS = 86_400_000;
const MAX_INTERVAL_DAYS = 36_500;
const BASE = Date.UTC(2026, 5, 11, 12, 0, 0); // 2026-06-11T12:00:00Z

const rating = fc.constantFrom<ReviewRating>(1, 2, 3, 4);
// Elapsed days between reviews: 0 (same instant), fractional (same day),
// on-time-ish, and absurdly late.
const gapDays = fc.oneof(
  fc.constant(0),
  fc.double({ min: 0, max: 3, noNaN: true }),
  fc.double({ min: 0, max: 400, noNaN: true }),
  fc.constant(36500),
);
const history = fc.array(fc.record({ rating, gap: gapDays }), { minLength: 1, maxLength: 12 });

function intervalDaysOf(state: ReviewState, now: Date): number {
  return (new Date(state.due).getTime() - now.getTime()) / DAY_MS;
}

describe("FSRS scheduler properties", () => {
  it("invariants hold along ANY rating/elapsed history", () => {
    fc.assert(
      fc.property(history, (steps) => {
        let state: ReviewState | null = null;
        let t = BASE;
        let lapses = 0;
        for (const [i, step] of steps.entries()) {
          t += step.gap * DAY_MS;
          const now = new Date(t);
          const next: ReviewState = schedule(state, step.rating, now);
          if (step.rating === 1) lapses++;

          // numeric sanity
          expect(Number.isFinite(next.stability)).toBe(true);
          expect(next.stability).toBeGreaterThan(0);
          expect(Number.isFinite(next.difficulty)).toBe(true);
          expect(next.difficulty).toBeGreaterThanOrEqual(1);
          expect(next.difficulty).toBeLessThanOrEqual(10);

          // interval bounds: whole days in [1, maxInterval]
          const ivl = intervalDaysOf(next, now);
          expect(Number.isInteger(ivl)).toBe(true);
          expect(ivl).toBeGreaterThanOrEqual(1);
          expect(ivl).toBeLessThanOrEqual(MAX_INTERVAL_DAYS);

          // due always advances from the review time
          expect(new Date(next.due).getTime()).toBeGreaterThan(now.getTime());
          expect(isDue(next, now)).toBe(false);
          expect(next.last_review).toBe(now.toISOString());

          // counters
          expect(next.reps).toBe(i + 1);
          expect(next.lapses).toBe(lapses);

          // serialization round-trip (the `_review_state` attr is a JSON blob)
          const parsed = parseReviewState(JSON.stringify(next));
          expect(parsed).toEqual(next);

          state = next;
        }
      }),
      fcOpts,
    );
  });

  it("Easy (4) never yields a shorter interval than Again (1) from the same state", () => {
    fc.assert(
      fc.property(history, gapDays, (steps, finalGap) => {
        // Build an arbitrary prior state, then branch on the final grade.
        let state: ReviewState | null = null;
        let t = BASE;
        for (const step of steps) {
          t += step.gap * DAY_MS;
          state = schedule(state, step.rating, new Date(t));
        }
        t += finalGap * DAY_MS;
        const now = new Date(t);
        const easy = schedule(state, 4, now);
        const again = schedule(state, 1, now);
        expect(intervalDaysOf(easy, now)).toBeGreaterThanOrEqual(intervalDaysOf(again, now));
        // Also holds for the very first grade of a new card.
        const easyNew = schedule(null, 4, now);
        const againNew = schedule(null, 1, now);
        expect(intervalDaysOf(easyNew, now)).toBeGreaterThanOrEqual(intervalDaysOf(againNew, now));
      }),
      fcOpts,
    );
  });

  it("a lapse (Again) never leaves the card more stable than it was", () => {
    fc.assert(
      fc.property(history, gapDays, (steps, finalGap) => {
        let state: ReviewState | null = null;
        let t = BASE;
        for (const step of steps) {
          t += step.gap * DAY_MS;
          state = schedule(state, step.rating, new Date(t));
        }
        t += finalGap * DAY_MS;
        const lapsed = schedule(state, 1, new Date(t));
        expect(lapsed.stability).toBeLessThanOrEqual(Math.max(state!.stability, 0.1));
      }),
      fcOpts,
    );
  });

  it("parseReviewState never throws on hostile blobs and degrades to null", () => {
    const hostile = fc.oneof(
      fc.string(),
      fc.json(),
      fc.constant(null),
      fc.constant(undefined),
      fc.constant('{"due":3,"stability":"x"}'),
    );
    fc.assert(
      fc.property(hostile, (raw) => {
        const out = parseReviewState(raw as string | null | undefined);
        // either a fully-shaped state or null — never a throw, never NaN fields
        if (out !== null) {
          expect(typeof out.due).toBe("string");
          expect(typeof out.stability).toBe("number");
        }
      }),
      fcOpts,
    );
  });
});
