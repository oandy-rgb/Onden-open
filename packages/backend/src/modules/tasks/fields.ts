// The request fields of a task, shared by every route that writes them
// (POST /api/tasks, POST /api/nodes/:id/tasks, PATCH /api/tasks/:id). `null`
// clears a field on a PATCH; a create takes the same names. `due_date` is the
// older name of `when_date`, which older clients and queued offline writes
// still send; a time of day in it becomes the reminder (recurrence.ts
// taskDayFromLegacyDue).

import { z } from "zod";
import { TASK_TITLE_MAX, isCalendarDay, isClockTime } from "@onden/markdown";
import { isDueDate, isRecurMode, isRemindAt, isValidRecur } from "./recurrence.js";

export const whenDateField = z.string().refine(isCalendarDay, "when_date must be a real day: YYYY-MM-DD");
export const dueDateField = z.string().refine(isDueDate, "due_date must be a real date: YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS]");
export const deadlineField = z.string().refine(isCalendarDay, "deadline must be a real day: YYYY-MM-DD");
// n ≥ 1: a zero interval ('0d') would make the scheduler cancel + remint the
// same overdue task forever (see scheduler.ts).
export const recurField = z.string().refine(isValidRecur, "recur must be <n><d|w|m> with n >= 1");
export const recurModeField = z.string().refine(isRecurMode, "recur_mode must be fixed or after");
export const remindAtField = z.string().refine(isRemindAt, "remind_at must be an ISO time (2026-10-24T09:30:00Z) or YYYY-MM-DDTHH:MM");
export const timeField = z.string().refine(isClockTime, "time must be HH:MM (24-hour)");
export const titleField = z.string().trim().min(1).max(TASK_TITLE_MAX);

/** `until`, when `time` is sent with it, must be later than `time` (HH:MM orders like the time it spells). */
export const untilAfterTime = ({ time, until }: { time?: string | null; until?: string | null }): boolean =>
  typeof time !== "string" || typeof until !== "string" || until > time;
export const UNTIL_MESSAGE = "until must be later than time";

/** when_date and due_date, when both are sent, must name the same day. */
export const sameDay = ({ when_date, due_date }: { when_date?: string | null; due_date?: string | null }): boolean =>
  when_date === undefined || due_date === undefined || when_date === (due_date === null ? null : due_date.slice(0, 10));
export const SAME_DAY_MESSAGE = "when_date and due_date name different days; send when_date";

/** The validators of the `_task_*` attributes a task list file can carry, by
 *  attribute key: the same rules the routes apply to the request fields. */
const attributeValidators: Record<string, z.ZodType> = {
  _task_when: whenDateField,
  _task_due: dueDateField,
  _task_deadline: deadlineField,
  _task_recur: recurField,
  _task_recur_mode: recurModeField,
  _task_remind_at: remindAtField,
  _task_time: timeField,
  _task_until: timeField,
  _task_done_at: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "done_at must be a time"),
  _task_evening: z.enum(["true", "false"]),
  _task_someday: z.enum(["true", "false"]),
};

/** `fields` (task attributes by full key, as an imported file spells them)
 *  split into those that pass the create rules and the keys that do not.
 *  Keys without a rule here pass through. */
export function splitValidTaskFields(fields: Record<string, string>): { valid: Record<string, string>; invalid: string[] } {
  const valid: Record<string, string> = {};
  const invalid: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (attributeValidators[key]?.safeParse(value).success === false) invalid.push(key);
    else valid[key] = value;
  }
  return { valid, invalid };
}
