// What the focus screens say, in plain words: lengths as 「25 分鐘」, the clock as
// 「剩 12:30」, and where the sentence of 「做了什麼？」 landed. No ids, codes or milliseconds.

import { t } from "../i18n";
import type { FocusWritten } from "../data";
import { focusElapsedMs, focusRemainingMs, formatFocusClock } from "./focusClock";

export const focusLengthLabel = (minutes: number): string => minutes > 0 ? t("{n} min", { n: minutes }) : t("No timer");

/** The running clock: 「剩 12:30」, 「已過 12:30」 for no timer, 「時間到」 once over. */
export function focusClockText(startedAt: string, minutes: number, nowMs: number): string {
  const left = focusRemainingMs(startedAt, minutes, nowMs);
  if (left === null) return t("{time} so far", { time: formatFocusClock(focusElapsedMs(startedAt, nowMs)) });
  return left > 0 ? t("{time} left", { time: formatFocusClock(left, "up") }) : t("Time is up");
}

/** The big number alone (no words around it). */
export function focusBigClock(startedAt: string, minutes: number, nowMs: number): string {
  const left = focusRemainingMs(startedAt, minutes, nowMs);
  return formatFocusClock(left === null ? focusElapsedMs(startedAt, nowMs) : Math.max(0, left), left === null ? "down" : "up");
}

/** How long a focus lasted, in whole minutes (at least one). */
export const focusMinutesSpent = (startedAt: string, endedAt: string): number =>
  Math.max(1, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000));

/** Tell the person where their sentence went. `asked`: the two places they ticked. */
export function focusWrittenMessage(asked: { note: boolean; diary: boolean; task: boolean }, written: FocusWritten): string {
  if (!asked.note || (!asked.diary && !asked.task)) return t("Focus ended.");
  const places = [written.diary && t("today's journal"), written.task && t("under the task")].filter(Boolean) as string[];
  if (places.length === 0) return t("Focus ended, but your sentence could not be written to the places you picked.");
  const wanted = (asked.diary ? 1 : 0) + (asked.task ? 1 : 0);
  const base = t("Focus ended. Your sentence is in {places}.", { places: places.join(t(" and ")) });
  return places.length < wanted ? `${base} ${t("The other place could not be written.")}` : base;
}
