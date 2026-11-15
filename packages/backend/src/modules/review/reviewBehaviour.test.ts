// Pure tests for reviewBehaviourFromSchema — the map from a #review tag's
// `behaviour` JSON to clamped FSRS scheduler params. No DB. Pins that the
// shipped review.tagpack.json starter actually configures the scheduler
// (pack-borne ECA, contract #10) and that hostile/absent values stay harmless.
import { describe, it, expect } from "vitest";
import { reviewBehaviourFromSchema, DEFAULT_BEHAVIOUR, combineReviewBehaviour, reviewedToday, reviewsLeftToday, withinDailyCap } from "./service.js";

// The literal behaviour.review the starter pack ships
// (packages/frontend/src/data/packs/review.tagpack.json). Kept in lockstep
// by reviewPack.test.ts on the frontend, which asserts the pack's raw values.
const STARTER_REVIEW = { request_retention: 0.9, maximum_interval_days: 365, new_per_day: 15 };

describe("reviewBehaviourFromSchema", () => {
  it("maps the shipped #review starter pack to its scheduler config", () => {
    expect(reviewBehaviourFromSchema({ review: STARTER_REVIEW })).toEqual({
      requestRetention: 0.9,
      maximumIntervalDays: 365,
    });
  });

  it("falls back to defaults when behaviour is absent or has no review key", () => {
    expect(reviewBehaviourFromSchema(null)).toEqual(DEFAULT_BEHAVIOUR);
    expect(reviewBehaviourFromSchema(undefined)).toEqual(DEFAULT_BEHAVIOUR);
    expect(reviewBehaviourFromSchema({})).toEqual(DEFAULT_BEHAVIOUR);
    expect(reviewBehaviourFromSchema({ review: {} })).toEqual(DEFAULT_BEHAVIOUR);
  });

  it("clamps hostile / out-of-range values into the safe envelope", () => {
    const hostile = reviewBehaviourFromSchema({
      review: { request_retention: 5, maximum_interval_days: -10 },
    });
    expect(hostile.requestRetention).toBe(0.97); // capped at the upper bound
    expect(hostile.maximumIntervalDays).toBe(1);  // floored at the lower bound
  });

  it("ignores non-numeric junk and uses defaults for those keys", () => {
    const junk = reviewBehaviourFromSchema({ review: { maximum_interval_days: "lots", request_retention: null } });
    expect(junk.maximumIntervalDays).toBe(DEFAULT_BEHAVIOUR.maximumIntervalDays);
    expect(junk.requestRetention).toBe(DEFAULT_BEHAVIOUR.requestRetention);
  });

  it("treats malformed review settings as absent instead of crashing queue and stats", () => {
    expect(reviewBehaviourFromSchema({ review: null })).toEqual(DEFAULT_BEHAVIOUR);
    expect(reviewBehaviourFromSchema({ review: [] })).toEqual(DEFAULT_BEHAVIOUR);
    expect(reviewBehaviourFromSchema({ review: "bad" })).toEqual(DEFAULT_BEHAVIOUR);
  });

  it("keeps interval ceilings in whole units", () => {
    expect(reviewBehaviourFromSchema({ review: { maximum_interval_days: 2.9 } }).maximumIntervalDays).toBe(2);
  });

  it("does not read a stored new-card number any more: the person's one daily cap is the only limit", () => {
    // Old tags and personal settings may still hold it (part two removes it); it changes nothing.
    expect(reviewBehaviourFromSchema({ review: { new_per_day: 3 } })).toEqual(DEFAULT_BEHAVIOUR);
    expect(Object.keys(DEFAULT_BEHAVIOUR).sort()).toEqual(["maximumIntervalDays", "requestRetention"]);
  });
});


describe("overlapping review settings", () => {
  it("combines scheduling constraints without tag-order priority", () => {
    const a = { requestRetention: 0.95, maximumIntervalDays: 365 };
    const b = { requestRetention: 0.8, maximumIntervalDays: 2 };
    expect(combineReviewBehaviour([a, b])).toEqual({ requestRetention: 0.95, maximumIntervalDays: 2 });
    expect(combineReviewBehaviour([b, a])).toEqual(combineReviewBehaviour([a, b]));
  });
});

describe("the daily cap", () => {
  const now = new Date("2026-11-13T02:00:00.000Z");
  const state = (last_review: string) => ({ state: "review" as const, due: last_review, stability: 1, difficulty: 5, reps: 2, lapses: 0, last_review });
  // Cards that carry no source tag at all (module_tag_ids empty): the cap does not read tags.
  const card = (id: string, last_review: string | null) => ({ node_id: id, title: id, markdown: "", ink_data: null, parent_id: null, block: null, created_at: "",
    module_tag_ids: [] as string[], state: last_review ? state(last_review) : null });

  it("counts every card graded today once, tags or not, and leaves no limit unlimited", () => {
    const cards = [card("a", now.toISOString()), card("b", now.toISOString()), card("old", "2026-11-12T02:00:00.000Z"), card("new", null)];
    expect(reviewedToday(cards, now)).toBe(2);
    expect(reviewsLeftToday(cards, 5, now)).toBe(3);
    expect(reviewsLeftToday(cards, 2, now)).toBe(0);
    expect(reviewsLeftToday(cards, 1, now)).toBe(0);
    expect(reviewsLeftToday(cards, null, now)).toBe(Infinity);
  });

  it("a card graded again on the day it was first graded still counts once", () => {
    const again = { ...card("again", now.toISOString()), state: { ...state(now.toISOString()), reps: 4, introduced_at: now.toISOString() } };
    expect(reviewedToday([again], now)).toBe(1);
    expect(reviewsLeftToday([again], 3, now)).toBe(2);
  });

  it("keeps the first cards in order and rolls the rest over", () => {
    const due = ["x", "y", "z"].map(id => card(id, "2026-11-01T00:00:00.000Z"));
    expect(withinDailyCap(due, 2)).toEqual({ kept: due.slice(0, 2), rolledOver: due.slice(2) });
    expect(withinDailyCap(due, 0).kept).toEqual([]);
    expect(withinDailyCap(due, Infinity).rolledOver).toEqual([]);
  });
});

