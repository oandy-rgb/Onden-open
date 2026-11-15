// What a running focus shows. The end is the record's start plus the length
// chosen, never a count of ticks: a tab asleep for an hour, a reload or another
// device all land on the same remaining time because it is read off the clock.

/** The lengths on offer, in minutes; 0 is 「不計時」 (it counts up instead). */
export const FOCUS_LENGTHS = [15, 25, 50, 0] as const;
export const DEFAULT_FOCUS_MINUTES = 25;

/** The longest length a person may type (the server's bound on the pref). */
export const MAX_FOCUS_MINUTES = 240;

/** A stored or typed length read back: whole minutes from 0 (no timer) to the longest, else null. */
export function parseFocusMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_FOCUS_MINUTES ? value : null;
}

/** The lengths the start sheet shows: the ones on offer plus the person's own (`own`), in order, 「不計時」 last. */
export function focusLengthChoices(own: number): number[] {
  const timed = [...new Set([...FOCUS_LENGTHS, own])].filter((minutes) => minutes > 0).sort((a, b) => a - b);
  return [...timed, 0];
}

/** Milliseconds left of a focus of `minutes` begun at `startedAt` (negative once
 *  over), or null for 「不計時」. */
export function focusRemainingMs(startedAt: string, minutes: number, nowMs: number): number | null {
  return minutes > 0 ? Date.parse(startedAt) + minutes * 60_000 - nowMs : null;
}

export function focusElapsedMs(startedAt: string, nowMs: number): number {
  return Math.max(0, nowMs - Date.parse(startedAt));
}

/** "12:30", or "1:05:30" past an hour. Whole seconds, rounded up so the last
 *  second reads 0:01 and never 0:00 before it is over. */
export function formatFocusClock(ms: number, round: "up" | "down" = "down"): string {
  const seconds = Math.max(0, round === "up" ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
