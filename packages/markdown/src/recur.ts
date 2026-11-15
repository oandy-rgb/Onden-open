// The repeat rule of a task — the one grammar and the one "next day" rule.
// A rule is `<n><d|w|m>` (every n days / weeks / months), n up to 3 digits.
// The server mints occurrences with it, the app shows the same date as a hint,
// the importer/exporter and the label functions read units through parseRecur;
// nobody else matches the token by hand (test/guards/tasks-time.guard.test.ts).

import { addDays, addMonths } from "./calendar.js";

export type RecurUnit = "d" | "w" | "m";
export type RecurRule = { n: number; unit: RecurUnit };
export type RecurMode = "fixed" | "after";

/** The rule a token spells, zero interval included; null when it is not a rule. */
export function parseRecur(token: string): RecurRule | null {
  const m = /^(\d{1,3})([dwm])$/.exec(token);
  return m ? { n: Number(m[1]), unit: m[2] as RecurUnit } : null;
}

/** Whether advanceDate() can step by this token (a zero interval can; it just never moves). */
export function isParsableRecur(token: string): boolean {
  return parseRecur(token) !== null;
}

/** A rule that moves: n ≥ 1. A zero interval never leaves its day, so a scheduler
 *  following it would remint the same overdue task forever; rejected at the API boundary. */
export function isValidRecur(token: string): boolean {
  const rule = parseRecur(token);
  return rule !== null && rule.n > 0;
}

/** `date` (YYYY-MM-DD) moved `times` intervals on. Months clamp to the month's last day. */
function stepFrom(date: string, rule: RecurRule, times: number): string {
  if (rule.unit === "m") return addMonths(date, rule.n * times);
  return addDays(date, rule.n * times * (rule.unit === "w" ? 7 : 1));
}

/** `date` (YYYY-MM-DD) moved one interval on. Months clamp to the month's last day. */
export function advanceDate(date: string, token: string): string {
  const rule = parseRecur(token);
  if (!rule) throw new Error(`invalid recur token: ${token}`);
  return stepFrom(date, rule, 1);
}

/** The first slot of the schedule STRICTLY AFTER `today`: stepping from `due`,
 *  a chain left unattended for weeks lands on the next future slot, not a pile of stale ones. */
export function nextDueAfter(due: string, token: string, today: string): string {
  const rule = parseRecur(token);
  if (!rule) throw new Error(`invalid recur token: ${token}`);
  // Every slot is counted from `due`, not from the previous slot: stepping a month rule
  // 1/31 → 2/28 → 3/28 would stay on the 28th for good after one short month.
  let k = 1;
  let next = stepFrom(due, rule, k);
  while (next <= today && k < 1000) next = stepFrom(due, rule, ++k);
  return next;
}

/** The day the next occurrence of a repeating task lands on, or null when none
 *  is minted: no rule, a `fixed` task with no day (no schedule to follow), or a
 *  rule that cannot reach a FUTURE day (zero interval, stale-chain guard).
 *
 *  fixed 照時間表: the first slot of the schedule after max(when, today).
 *  after 完成後起算: `today` plus one interval. `today` is the day it is finished. */
export function nextOccurrenceDate(task: { recur: string | null; recurMode: RecurMode; when: string | null }, today: string): string | null {
  if (!task.recur || !isParsableRecur(task.recur)) return null;
  let next: string;
  if (task.recurMode === "after") next = advanceDate(today, task.recur);
  else {
    if (!task.when) return null;
    next = nextDueAfter(task.when, task.recur, today < task.when ? task.when : today);
  }
  return next > today ? next : null;
}
