// A cycle's words (focusCycle.ts has its rules). Kept apart from focusText so the boot bundle does not carry
// them: only the lazy screens (modules/tasks/focus) import this. Breaks are never in the focus record, and the words say so.

import { t, tn } from "../i18n";
import type { FocusCycleSetting } from "./focusCycle";
import { LONG_BREAK_MINUTES, breakAfter, type BreakKind } from "./focusCycleRules";
import { focusLengthLabel } from "./focusText";

/** The 週期 row's value: 「休息 5 分鐘・每 4 輪長休息 15 分鐘」. */
export function focusCycleLabel(cycle: FocusCycleSetting): string {
  const rest = t("Break {n} min", { n: cycle.rest });
  return cycle.longEvery > 0 ? `${rest} · ${t("long break {long} min every {n} rounds", { long: LONG_BREAK_MINUTES, n: cycle.longEvery })}` : rest;
}

/** A round's sub line: its length, then the break that follows it. */
export function focusRoundSub(minutes: number, round: number, cycle: FocusCycleSetting): string {
  const next = breakAfter(round, cycle);
  return next.kind === "long"
    ? t("{length}, then a long break of {n} min", { length: focusLengthLabel(minutes), n: next.minutes })
    : t("{length}, then a break of {n} min", { length: focusLengthLabel(minutes), n: next.minutes });
}

export const breakTitle = (kind: BreakKind): string => kind === "long" ? t("Long break") : t("Take a break");

/** The toast when a round's time is up and the break starts by itself. */
export const breakStartedMessage = (kind: BreakKind, minutes: number): string =>
  kind === "long" ? t("Time is up. Long break for {n} min.", { n: minutes }) : t("Time is up. Break for {n} min.", { n: minutes });

/** 「3 輪，共專注 75 分鐘」: the rounds of a run and the minutes focused in them (breaks are not in it). */
export const runSummaryText = (summary: { rounds: number; minutes: number }): string =>
  tn("{n} round, {m} min focused in all", "{n} rounds, {m} min focused in all", summary.rounds, { m: summary.minutes });
