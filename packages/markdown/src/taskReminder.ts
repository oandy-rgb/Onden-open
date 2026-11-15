// When a task is to be reminded — the one rule the app (hooks/useDueSoonNotifications,
// while it is open) and the server (Web Push, backend modules/tasks/pushReminders.ts, while it is
// not) both use, so the same moment is judged the same way on both sides.
//
// A task's moment is its reminder (`_task_remind_at`), else the time it starts
// (`_task_when` + `_task_time`). A moment is written either as an instant (ISO with
// Z or an offset) or as the workspace's wall clock (YYYY-MM-DDTHH:MM): the first is
// compared as a time, the second against the workspace's own "now" spelled the same
// way. The wall clock is the workspace's zone, so no device zone matters.
//
// A moment is due once it has come and is at most REMIND_CATCH_UP_MS old: what
// passed while nobody was there is caught up for twelve hours, and only the late
// list says anything about older ones. Whether it was already sent is the caller's
// (a set on the device, a table on the server), keyed by `reminderKey`.

import { addDays, daysBetween } from "./calendar.js";

/** A moment older than this was not missed in passing: only the late list says it. */
export const REMIND_CATCH_UP_MS = 12 * 3_600_000;

/** What "now" is, in both ways a reminder is written. `wall` is the workspace
 *  clock as YYYY-MM-DDTHH:MM (a space between day and time is accepted). */
export type ReminderNow = { ms: number; wall: string; /** The hour the workspace's day starts at (0–6); absent = 0. */ dayStartHour?: number };

/** The fields of a task that say when to remind. */
export type ReminderFields = {
  remind_at?: string | null;
  /** HH:MM it starts, on the day `due_date`. */
  time?: string | null;
  due_date?: string | null;
  status?: string | null;
};

export type ReminderMoment = { text: string; instant: boolean };

/** Statuses a reminder is for: a finished, cancelled or blocked task is not nudged. */
export function reminderStatusOpen(status: string | null | undefined): boolean {
  return status === "todo" || status === "doing";
}

/** The moment a task is to be reminded: its reminder, else the time it starts.
 *  Null when it has neither. A wall-clock moment is compared as text (it orders
 *  like the time it spells); an instant is compared as a time. */
export function reminderMoment(task: ReminderFields, dayStartHour = 0): ReminderMoment | null {
  if (task.remind_at) return { text: task.remind_at, instant: /(?:Z|[+-]\d\d:?\d\d)$/.test(task.remind_at) };
  const day = task.due_date ? DAY.exec(task.due_date)?.[0] : undefined;
  if (task.time && day) {
    // The day D runs from D HH:00 (its start hour) to D+1 HH:00: a time before the start hour is on the next calendar day.
    const hour = Number.parseInt(task.time, 10);
    const calendarDay = hour < dayStartHour ? addDays(day, 1) : day;
    return { text: `${calendarDay}T${task.time}`, instant: false };
  }
  return null;
}

/** The same moment is the same key on every device and on the server; it is also
 *  the notification `tag`, so a push and an in-app notice for one moment are one
 *  notification on screen. */
export function reminderKey(taskId: string, moment: ReminderMoment): string {
  return `remind:${taskId}:${moment.text}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}/;
const WALL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/;

/** The wall-clock minute read as if it were UTC: only differences between two of them mean anything. NaN if malformed. */
function wallMs(text: string): number {
  const m = WALL.exec(text);
  return m ? Date.parse(`${m[1]}T${m[2]}:00Z`) : NaN;
}

/** How long ago (ms, negative = still ahead) the moment was, to the minute.
 *  NaN for a value that is no time (a malformed attribute): never due. */
export function reminderAgoMs(moment: ReminderMoment, now: ReminderNow): number {
  if (moment.instant) return now.ms - Date.parse(moment.text);
  return wallMs(now.wall) - wallMs(moment.text);
}

/** The task's moment when it is due now: open, has come, within the catch-up
 *  window. Null otherwise. Pure: `now` is given. */
export function dueReminderMoment(task: ReminderFields, now: ReminderNow): ReminderMoment | null {
  if (task.status != null && !reminderStatusOpen(task.status)) return null;
  const moment = reminderMoment(task, now.dayStartHour);
  if (!moment) return null;
  const ago = reminderAgoMs(moment, now);
  return ago >= 0 && ago <= REMIND_CATCH_UP_MS ? moment : null;
}

/** Where a task sits: the day it is to be done and the clock time it starts. */
export type ReminderPlacement = { when: string | null; time: string | null };

const MINUTES_PER_DAY = 1440;
/** A reminder on the workspace's wall clock (no zone): day, HH:MM, and seconds if it has them. */
const WALL_REMINDER = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/;
/** The reminder preset "that morning, 9:00" (apps/frontend TaskSheet): it names a clock time, not a distance to the start. */
const MORNING_REMINDER = "09:00";

function minutesOf(time: string): number {
  const [hour = "0", minute = "0"] = time.split(":");
  return Number.parseInt(hour, 10) * 60 + Number.parseInt(minute, 10);
}

/** Minutes from a workspace day's calendar midnight to its clock time `time`: a time before the hour the day starts
 *  at is on the next calendar day (reminderMoment), so it counts a whole day later. */
function dayMinutes(time: string, dayStartHour: number): number {
  return minutesOf(time) + (Number.parseInt(time, 10) < dayStartHour ? MINUTES_PER_DAY : 0);
}

/** The reminder after its task was moved, the one rule for the app and the server.
 *
 *  A reminder written as the workspace's wall clock goes with the task:
 *  - the day changes → the reminder's day moves by as many days, its clock time kept ("9:00 that day");
 *  - the start time changes → a reminder at or before the old start, within the start's workspace day, keeps its
 *    distance to the start ("15 minutes before"), unless it is the 9:00 morning preset, which stays at 9:00.
 *  `dayStartHour` is the hour the workspace's day starts at (0–6): "01:30" of a day starting at 04:00 is early the next morning.
 *  A reminder set to one exact moment (an instant, with Z or an offset) stays where it is, as does one when the task has
 *  no day or no time to follow. Null when there is no reminder. */
export function reminderAfterMove(remindAt: string | null, before: ReminderPlacement, after: ReminderPlacement, dayStartHour = 0): string | null {
  if (!remindAt) return null;
  const wall = WALL_REMINDER.exec(remindAt);
  if (!wall) return remindAt;
  let day = wall[1]!;
  let clock = wall[2]!;
  const seconds = wall[3] ?? "";
  const dayStartMin = dayStartHour * 60;
  // The reminder's minute counted from its start day's calendar midnight.
  const remindMin = before.when !== null ? daysBetween(before.when, day) * MINUTES_PER_DAY + minutesOf(clock) : NaN;
  const startedOnItsDay = before.when !== null && before.time !== null && clock !== MORNING_REMINDER
    && remindMin >= dayStartMin && remindMin <= dayMinutes(before.time, dayStartHour);
  if (before.when !== null && after.when !== null && before.when !== after.when) day = addDays(day, daysBetween(before.when, after.when));
  if (startedOnItsDay && before.time !== null && after.time !== null && before.time !== after.time) {
    const moved = remindMin + dayMinutes(after.time, dayStartHour) - dayMinutes(before.time, dayStartHour);
    const dayShift = Math.floor(moved / MINUTES_PER_DAY);
    const within = moved - dayShift * MINUTES_PER_DAY;
    day = addDays(after.when !== null ? after.when : before.when!, dayShift);
    clock = `${String(Math.floor(within / 60)).padStart(2, "0")}:${String(within % 60).padStart(2, "0")}`;
  }
  return `${day}T${clock}${seconds}`;
}
