// Where a task falls on the calendar — the one rule. The server's agenda SQL
// (backend services/tasksStore.ts taskBucketCaseSql) spells the same rule in SQL
// and a backend test holds the two together; every other reader (the Tasks page,
// the offline agenda, the list export, the journal) calls these instead of
// comparing when-dates itself (test/guards/tasks-time.guard.test.ts).
//
// `today` is the workspace-zone day id; dates compare as text, which orders
// YYYY-MM-DD like the day it spells. No imports besides calendar math.

import { addDays } from "./calendar.js";

/** The agenda's bucket names (the ones the Tasks page has always had). */
export type TaskBucket = "done" | "waiting" | "later" | "unscheduled" | "overdue" | "today" | "upcoming" | "scheduled";
/** The four homes a task lives in on the Tasks page and in the exported list. */
export type TaskHome = "today" | "upcoming" | "anytime" | "someday";

/** A day this close ahead (today excluded) is `upcoming`; further is `scheduled`. */
export const UPCOMING_DAYS = 7;

type DayFacts = { when: string | null | undefined; someday?: boolean };
type TaskFacts = DayFacts & { status: string };

/** The bucket by day alone, status aside: a parked (someday) task is `later`
 *  whatever its day. */
export function dayBucket(task: DayFacts, today: string): Exclude<TaskBucket, "done" | "waiting"> {
  if (task.someday) return "later";
  const day = task.when?.slice(0, 10);
  if (!day) return "unscheduled";
  if (day < today) return "overdue";
  if (day === today) return "today";
  return day <= addDays(today, UPCOMING_DAYS) ? "upcoming" : "scheduled";
}

/** The agenda bucket of a task: closed (done or cancelled) and waiting first, then its day. */
export function taskBucket(task: TaskFacts, today: string): TaskBucket {
  if (task.status === "done" || task.status === "cancelled") return "done";
  if (task.status === "waiting") return "waiting";
  return dayBucket(task, today);
}

/** The home of an open task by its own fields. An overdue day counts as today
 *  here: the Tasks page and the exported list keep it where it can be done.
 *  The journal does not fold it in (a past day is a suggestion, not today's
 *  list), so it reads `taskBucket` itself. */
export function taskHome(task: DayFacts, today: string): TaskHome {
  switch (dayBucket(task, today)) {
    case "overdue": case "today": return "today";
    case "upcoming": case "scheduled": return "upcoming";
    case "later": return "someday";
    case "unscheduled": return "anytime";
  }
}
