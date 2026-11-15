// Tasks left over from an earlier day: the words that say which day left them, and the
// writes the Tasks page's 「可以排進今天的」 card makes (「排到今天」 for one task, 「不做了」).
// Pure; the page writes. `today` is always the workspace's (lib/localDate todayId), never the device's.

import { daysBetween } from "../localDate";
import { whenChanges, type TaskChanges, type TaskItem } from "./taskModel";
import { weekdayOf } from "@onden/markdown";

/** How long ago the day was: yesterday; 2–6 days ago by its weekday; longer by the count. */
export type LeftOverAge = { kind: "yesterday" } | { kind: "weekday"; weekday: number } | { kind: "daysAgo"; n: number };

export function leftOverAge(whenDate: string, today: string): LeftOverAge {
  const n = daysBetween(whenDate, today);
  if (n <= 1) return { kind: "yesterday" };
  if (n <= 6) return { kind: "weekday", weekday: weekdayOf(whenDate) };
  return { kind: "daysAgo", n };
}

/** A write for one task and what puts it back. */
export type PlannedChange = { id: string; changes: TaskChanges; undo: TaskChanges };

/** 排到今天: the task's day becomes today (so it is no longer late); undo gives back the day and
 *  the 今晚／某天 flags it had, which the new day clears. */
export function planTodayChanges(task: TaskItem, today: string): PlannedChange {
  return {
    id: task.id,
    changes: whenChanges({ kind: "today" }, today),
    undo: { when_date: task.whenDate, evening: task.evening, someday: task.someday },
  };
}

/** 不做了: the task is cancelled. Undo restores its status. */
export function dropChanges(task: Pick<TaskItem, "id" | "status">): PlannedChange {
  return { id: task.id, changes: { status: "cancelled" }, undo: { status: task.status } };
}
