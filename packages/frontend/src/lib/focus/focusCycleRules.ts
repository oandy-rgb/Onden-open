// The cycle's rules, pure (the shapes are in focusCycle.ts): which break follows round N, how much of a
// break is left, what a whole run adds up to. Only the lazy screens use them.

import type { FocusCycleSetting, FocusRun } from "./focusCycle";

/** The long break, in minutes: fixed, not a setting. */
export const LONG_BREAK_MINUTES = 15;

export type BreakKind = "short" | "long";

/** The break after round `round` (1-based). */
export function breakAfter(round: number, cycle: FocusCycleSetting): { kind: BreakKind; minutes: number } {
  const long = cycle.longEvery > 0 && round % cycle.longEvery === 0;
  return long ? { kind: "long", minutes: LONG_BREAK_MINUTES } : { kind: "short", minutes: cycle.rest };
}

/** Milliseconds left of a break of `minutes` begun at `startedAt` (negative once over). */
export function breakRemainingMs(startedAt: string, minutes: number, nowMs: number): number {
  return Date.parse(startedAt) + minutes * 60_000 - nowMs;
}

/** What a run adds up to: the rounds ended so far plus the one being ended now
 *  (`currentMinutes`, null if none). Breaks are not in it. */
export function runSummary(finishedMinutes: readonly number[], currentMinutes: number | null): { rounds: number; minutes: number } {
  const all = currentMinutes === null ? finishedMinutes : [...finishedMinutes, currentMinutes];
  return { rounds: all.length, minutes: all.reduce((sum, minutes) => sum + minutes, 0) };
}


/** Time is up on round `run.round` of the record begun at `startedAt`: the break starts at that instant. */
export function enterBreak(run: FocusRun, startedAt: string): FocusRun {
  const endedAt = new Date(Date.parse(startedAt) + run.minutes * 60_000).toISOString();
  return { ...run, phase: "break", endedAt, restStartedAt: endedAt };
}
