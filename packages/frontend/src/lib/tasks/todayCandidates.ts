// 「可以排進今天的」: what the Tasks page offers to put on today. Two kinds, one list:
// tasks whose day has passed and are still open (late), and open tasks whose deadline is today or
// tomorrow (or already past) but that have no time on today's timeline. Late ones come first, the
// longest-waiting on top; then by deadline. Pure; `today` is the workspace's, never the device's.

import { deadlineIsSoon, isOpen, isOverdue, type TaskItem } from "./taskModel";

/** Rows the card lists before 「看全部」. */
export const CANDIDATES_SHOWN = 3;

/** A deadline this many days away (today = 0) or less puts a task on the card. */
const DEADLINE_CANDIDATE_DAYS = 1;

const byDay = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);

/** `tasks` that can go on today. `keep` are ids ticked a moment ago: they stay (struck through) until the tab changes. */
export function todayCandidates(tasks: readonly TaskItem[], today: string, keep: ReadonlySet<string> = new Set()): TaskItem[] {
  const late: TaskItem[] = [];
  const near: TaskItem[] = [];
  for (const task of tasks) {
    if (task.status === "cancelled" || (!isOpen(task.status) && !keep.has(task.id))) continue;
    // Late is the row's own rule (isOverdue); a task ticked a moment ago is judged as it was while open.
    if (isOverdue(task.status === "done" ? { ...task, status: "todo" } : task, today)) late.push(task);
    else if (deadlineIsSoon(task.deadline, today, DEADLINE_CANDIDATE_DAYS) && !(task.whenDate === today && task.time)) near.push(task);
  }
  late.sort((a, b) => byDay(a.whenDate, b.whenDate) || byDay(a.deadline, b.deadline));
  near.sort((a, b) => byDay(a.deadline, b.deadline));
  return [...late, ...near];
}
