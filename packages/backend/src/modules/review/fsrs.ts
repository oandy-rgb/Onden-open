// Minimal FSRS-4.5 scheduler — vendored, not the `ts-fsrs` npm package.
//
// Why vendored: the module needs only the scheduling math (~100 lines); this
// worktree shares node_modules with the main repo, so adding a dependency
// here mutates shared state; and FSRS in "long-term scheduler" mode (the only
// mode that makes sense for a notes app — day granularity, no minute-level
// learning steps) is a handful of closed-form formulas.
//
// Sources (both MIT):
//   • open-spaced-repetition/ts-fsrs — formula reference (FSRS-4.5)
//   • open-spaced-repetition/go-fsrs v3 — the default parameters SiYuan ships
//     (siyuan/kernel/conf/flashcard.go calls fsrs.DefaultParam()): the 17
//     FSRS-4.5 weights below, requestRetention 0.9, maximumInterval 36500.
//
// Model in one paragraph: each card carries a stability S (days until recall
// probability decays to 90%) and a difficulty D (1..10). Retrievability after
// t days is R(t,S) = (1 + FACTOR·t/S)^DECAY. A grade updates D (with mean
// reversion toward the default) and S (growth on success — bigger when the
// review was hard-won, i.e. low R; shrink on a lapse), then the next due date
// is the interval at which R would fall back to the requested retention.

import type { ReviewIntervals, ReviewRating, ReviewState } from "@onden/contract";

// FSRS-4.5 default weights (go-fsrs v3 DefaultParam / ts-fsrs defaults).
const W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474,
  0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
] as const;

const DECAY = -0.5;
const FACTOR = 19 / 81; // = 0.9^(1/DECAY) - 1, so R(S, S) = 0.9

/** Tunables a #review pack's behaviour can set (⑥: pack-borne ECA). The
 *  FSRS-4.5 WEIGHTS stay fixed — they're the model, not preferences. */
export type SchedulerParams = {
  /** Target recall probability at the scheduled review (0.7–0.97). */
  requestRetention: number;
  /** Hard ceiling on any interval, days. */
  maximumIntervalDays: number;
};
export const DEFAULT_PARAMS: SchedulerParams = {
  requestRetention: 0.9,
  maximumIntervalDays: 36500,
};
const DAY_MS = 86_400_000;

const clampDifficulty = (d: number) => Math.min(Math.max(d, 1), 10);
const clampStability = (s: number) => Math.max(s, 0.1);

/** R(t, S): probability of recall t days after the last review. */
export function retrievability(elapsedDays: number, stability: number): number {
  return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY);
}

/** The interval (whole days ≥ 1) at which R decays to the requested
 *  retention. With retention 0.9 this is ≈ the stability itself. */
export function nextIntervalDays(stability: number, params: SchedulerParams = DEFAULT_PARAMS): number {
  const ivl = (stability / FACTOR) * (Math.pow(params.requestRetention, 1 / DECAY) - 1);
  return Math.min(Math.max(Math.round(ivl), 1), params.maximumIntervalDays);
}

function initStability(rating: ReviewRating): number {
  return clampStability(W[rating - 1]);
}

function initDifficulty(rating: ReviewRating): number {
  return clampDifficulty(W[4] - (rating - 3) * W[5]);
}

function nextDifficulty(d: number, rating: ReviewRating): number {
  const next = d - W[6] * (rating - 3);
  // Mean reversion toward the default difficulty (W[4]) keeps D from pinning
  // at the extremes over many reviews.
  return clampDifficulty(W[7] * W[4] + (1 - W[7]) * next);
}

function nextRecallStability(d: number, s: number, r: number, rating: ReviewRating): number {
  const hardPenalty = rating === 2 ? W[15] : 1;
  const easyBonus = rating === 4 ? W[16] : 1;
  return clampStability(
    s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hardPenalty * easyBonus),
  );
}

function nextForgetStability(d: number, s: number, r: number): number {
  const forget = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
  // A lapse never leaves the card MORE stable than before it was forgotten.
  return clampStability(Math.min(forget, s));
}

/** Pure scheduling step: previous state (null = new card) + a grade at `now`
 *  → the next state. Deterministic for a given (prev, rating, now), which is
 *  what makes the interval-progression tests exact. */
export function schedule(prev: ReviewState | null, rating: ReviewRating, now: Date, params: SchedulerParams = DEFAULT_PARAMS): ReviewState {
  let stability: number;
  let difficulty: number;
  let reps: number;
  let lapses: number;

  if (!prev) {
    stability = initStability(rating);
    difficulty = initDifficulty(rating);
    reps = 1;
    lapses = rating === 1 ? 1 : 0;
  } else {
    const elapsedDays = Math.max(0, (now.getTime() - new Date(prev.last_review).getTime()) / DAY_MS);
    const r = retrievability(elapsedDays, prev.stability);
    difficulty = nextDifficulty(prev.difficulty, rating);
    stability = rating === 1
      ? nextForgetStability(prev.difficulty, prev.stability, r)
      : nextRecallStability(prev.difficulty, prev.stability, r, rating);
    reps = prev.reps + 1;
    lapses = prev.lapses + (rating === 1 ? 1 : 0);
  }

  const intervalDays = nextIntervalDays(stability, params);
  return {
    due: new Date(now.getTime() + intervalDays * DAY_MS).toISOString(),
    stability,
    difficulty,
    reps,
    lapses,
    state: "review",
    last_review: now.toISOString(),
  };
}

/** What each grade would schedule next, in whole days from `now`: the very
 *  `schedule` the grade route runs, so the buttons cannot disagree with it. */
export function previewIntervals(prev: ReviewState | null, now: Date, params: SchedulerParams = DEFAULT_PARAMS): ReviewIntervals {
  const days = (rating: ReviewRating) => Math.round((new Date(schedule(prev, rating, now, params).due).getTime() - now.getTime()) / DAY_MS);
  return { 1: days(1), 2: days(2), 3: days(3), 4: days(4) };
}

/** Parse a stored `_review_state` attribute value. Returns null for absent /
 *  corrupt blobs — a corrupt card degrades to "new", never crashes a queue. */
export function parseReviewState(raw: string | null | undefined): ReviewState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ReviewState>;
    if (typeof v?.due !== "string" || typeof v?.stability !== "number" || typeof v?.last_review !== "string") return null;
    return {
      due: v.due,
      stability: v.stability,
      difficulty: typeof v.difficulty === "number" ? v.difficulty : W[4],
      reps: typeof v.reps === "number" ? v.reps : 0,
      lapses: typeof v.lapses === "number" ? v.lapses : 0,
      state: "review",
      last_review: v.last_review,
      ...(typeof v.introduced_at === "string" ? { introduced_at: v.introduced_at } : {}),
    };
  } catch {
    return null;
  }
}

/** Due = new (no state) or the stored due timestamp has passed. */
export function isDue(state: ReviewState | null, now: Date): boolean {
  return !state || new Date(state.due).getTime() <= now.getTime();
}
