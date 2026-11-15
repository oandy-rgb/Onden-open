// What the 今天 page's left column lists for one day. Pure: the sorting rules are the Tasks page's
// (lib/tasks: isOverdue, todayCandidates), only the grouping into the page's three lists is new.
//
//   today (or any later day)
//     leftOver   「還沒做完」: open tasks whose day has passed. Not moved by themselves; each row has its own 排到今天.
//     planned    「今天要做的」: the day's own tasks, open first, done ones after (struck through).
//     unplanned  「還沒排的」: what could go on today — a deadline within a day, then what has no day at all.
//   a past day: only `planned`, the tasks of that day, done and left undone.
// A later day lists its own tasks and nothing to catch up on.

import { isOpen, isOverdue, todayCandidates, type TaskItem } from "../../../lib/tasks";

export type TodayLists = {
  leftOver: TaskItem[];
  planned: TaskItem[];
  unplanned: TaskItem[];
  /** Tasks of a past day that are still open now. */
  stillOpen: number;
};

/** Open tasks with no day, and not parked: the ones to plan from. */
const isAnytime = (task: TaskItem) => isOpen(task.status) && task.whenDate === null && !task.someday;

const byTime = (a: TaskItem, b: TaskItem) => (a.time ?? "99:99").localeCompare(b.time ?? "99:99");

export function todayLists(items: readonly TaskItem[], date: string, today: string, keepDone: ReadonlySet<string> = new Set()): TodayLists {
  const live = items.filter((task) => task.status !== "cancelled");
  const ofDay = live.filter((task) => task.whenDate === date && (isOpen(task.status) || task.status === "done" || keepDone.has(task.id)));
  const planned = [...ofDay.filter((task) => isOpen(task.status) || keepDone.has(task.id)).sort(byTime), ...ofDay.filter((task) => !isOpen(task.status) && !keepDone.has(task.id)).sort(byTime)];
  if (date !== today) {
    return { leftOver: [], planned, unplanned: [], stillOpen: date < today ? ofDay.filter((task) => isOpen(task.status)).length : 0 };
  }
  const leftOver = live.filter((task) => isOpen(task.status) && isOverdue(task, today)).sort((a, b) => (a.whenDate! < b.whenDate! ? -1 : a.whenDate! > b.whenDate! ? 1 : 0));
  const taken = new Set([...leftOver, ...planned].map((task) => task.id));
  // The Tasks page's candidates minus the late ones (listed above); then the ones with no day.
  const near = todayCandidates(live, today, keepDone).filter((task) => !taken.has(task.id));
  const nearIds = new Set(near.map((task) => task.id));
  const anytime = live.filter((task) => isAnytime(task) && !taken.has(task.id) && !nearIds.has(task.id));
  return { leftOver, planned, unplanned: [...near, ...anytime], stillOpen: 0 };
}

/** The minutes an item of the day was scheduled for, from its clock times ("09:00"–"10:30"); null without an end. */
export function plannedMinutes(task: Pick<TaskItem, "time" | "until">): number | null {
  if (!task.time || !task.until) return null;
  const minutes = (clock: string) => { const [h, m] = clock.split(":").map(Number) as [number, number]; return h * 60 + m; };
  const length = minutes(task.until) - minutes(task.time);
  return length > 0 ? length : null;
}
