// The pure rules of task dates and repetition (no database): what a day, a
// reminder and a repeat rule look like, and what the next occurrence of a
// repeating task is.
//
// Two ways to repeat (`_task_recur_mode`):
//   fixed  照時間表 — every <n> days/weeks/months on the schedule that was
//          set, whenever it is done. Finishing early or late does not move it;
//          a missed occurrence is cancelled by the scheduler and the next one
//          made (break-or-make, scheduler.ts).
//   after  完成後起算 — the next one is <n> days/weeks/months after the day it
//          was DONE. Nothing happens until it is done, so the scheduler never
//          touches it.

import { advanceDate, isCalendarDate, isParsableRecur, isValidRecur, nextDueAfter, nextOccurrenceDate } from "@onden/markdown";
import { addDays, daysBetween } from "../../localDay.js";
import type { RecurMode } from "../../services/tasksStore.js";

// The repeat grammar and the next-day rule are @onden/markdown's (recur.ts), shared
// with the app; this file keeps what is the server's: field validation, and what an
// occurrence carries over.
export { advanceDate, isParsableRecur, isValidRecur, nextDueAfter };

export type RecurToken = string; // `<n><d|w|m>`, validated at the API boundary

export function isRecurMode(v: string): v is RecurMode {
  return v === "fixed" || v === "after";
}

// A day value is EITHER a pure date (`YYYY-MM-DD`) OR, for what older clients
// still send as `due_date`, a local datetime (`YYYY-MM-DDTHH:MM`, optionally
// `:SS`). Both forms sort as text identically to the instant they spell. The
// time is wall-clock without a zone offset, the same calendar the agenda
// buckets on. `_task_when` and `_task_deadline` store days only; a time in an
// old client's `due_date` becomes the reminder (taskDayFromLegacyDue).
export const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;

/** Is `due` a day (or legacy day + time) naming a real calendar moment
 *  (@onden/markdown isCalendarDate)? The shape alone let 2026-02-30 in, which
 *  advanceDue then rolled into 03-02 (D107). */
export function isDueDate(due: string): boolean {
  return DUE_DATE_RE.test(due) && isCalendarDate(due);
}

const WALL_CLOCK_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** A reminder time: an ISO instant with a zone (`2026-10-24T09:30:00Z`,
 *  `…+08:00`), or a wall-clock `YYYY-MM-DDTHH:MM[:SS]` read in the workspace's
 *  zone (what a timed `due_date` was before migration 135). */
export function isRemindAt(value: string): boolean {
  if (WALL_CLOCK_RE.test(value)) return isCalendarDate(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)
    && isCalendarDate(value) && !Number.isNaN(Date.parse(value));
}

/** Does this value carry a time-of-day (vs. being a pure date)? */
export function dueHasTime(due: string): boolean {
  return due.includes("T");
}

/** An older client's `due_date` as today's fields: its day, and — when it had
 *  a time of day — that moment as the reminder. */
export function taskDayFromLegacyDue(due: string): { when: string; remindAt: string | null } {
  return { when: due.slice(0, 10), remindAt: dueHasTime(due) ? due : null };
}

/** Advance an ISO day (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS]`) by one recur
 *  interval, PRESERVING any time-of-day. */
export function advanceDue(due: string, recur: RecurToken): string {
  return advanceDate(due.slice(0, 10), recur) + (dueHasTime(due) ? due.slice(10) : "");
}

/** A reminder moved `days` later: a wall-clock time keeps its time of day, an
 *  instant moves by whole days. */
export function shiftRemindAt(remindAt: string, days: number): string {
  if (days === 0) return remindAt;
  if (WALL_CLOCK_RE.test(remindAt)) return addDays(remindAt.slice(0, 10), days) + remindAt.slice(10);
  return new Date(Date.parse(remindAt) + days * 86_400_000).toISOString();
}

/** What the next occurrence of a repeating task carries over. */
export type OccurrenceSource = {
  when: string | null;
  evening: boolean;
  deadline: string | null;
  remindAt: string | null;
  recur: RecurToken;
  recurMode: RecurMode;
};
export type NextOccurrence = {
  when: string; evening: boolean; deadline: string | null; remindAt: string | null;
};

/** The next occurrence after finishing (or missing) one, or null when there is
 *  none to make: a `fixed` task with no day has no schedule to follow, and a
 *  recur token that cannot reach a FUTURE day (a legacy zero interval, the
 *  advance guard exhausted) must not mint — it would re-enter the overdue scan
 *  as the same task. `today` is the day it is finished (or the scheduler's day).
 *
 *  fixed: the first slot of the schedule after max(when, today).
 *  after: `today` plus one interval.
 *  The deadline and the reminder keep their distance from the day. */
export function nextOccurrence(task: OccurrenceSource, today: string): NextOccurrence | null {
  const when = nextOccurrenceDate({ recur: task.recur, recurMode: task.recurMode, when: task.when }, today);
  if (!when) return null;
  // Distance carried from the day the finished one was scheduled (its own day
  // for fixed, the completion day for after: it had no schedule to keep).
  const from = task.when ?? today;
  const moved = daysBetween(from, when);
  return {
    when,
    evening: task.evening,
    deadline: task.deadline ? addDays(when, daysBetween(from, task.deadline)) : null,
    remindAt: task.remindAt ? shiftRemindAt(task.remindAt, moved) : null,
  };
}
